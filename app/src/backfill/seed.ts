/**
 * src/backfill/seed.ts
 * OWNER: backfill agent
 *
 * Hybrid backfill — the "instant history" half of the system.
 *
 * We pull free, open, pre-aggregated datasets (the community
 * house-stock-watcher / senate-stock-watcher S3 JSON dumps) and upsert their
 * rows into `transactions` with source='seed_dataset'. This bootstraps a large
 * back-history of disclosures in seconds, before the live pipeline has had time
 * to accumulate anything.
 *
 * This is deliberately the LOW-FIDELITY half of a two-part strategy:
 *   - seed_dataset (here): instant, broad history, coarse provenance. No raw
 *     document, no per-row OCR confidence, no review gating. We do NOT enqueue
 *     delivery for these rows — they are reference/history only.
 *   - primary (watcher -> fetcher -> classifier -> extractor -> normalizer):
 *     the PRIMARY, low-latency half. It carries true provenance (rawObjectKey,
 *     extractor, confidence) and later UPGRADES a seed row's provenance when it
 *     independently ingests the same filing. `primary` always wins.
 *
 * Idempotency: ids are deterministic (hash of source+filer+date+ticker+amount)
 * and we INSERT OR IGNORE, so re-running the backfill never duplicates rows and
 * never clobbers an existing (possibly primary) row with the same identity.
 */

import type { Chamber, Owner, Transaction, TxType, Env } from '../shared/types';
import { batch } from '../shared/db';
import { nearestBracket } from '../shared/brackets';
import { HOUSE_ASSET_TYPE_NAMES } from '../shared/assetTypes';
import { sanitizeAssetName } from '../shared/text';
import { scoreFields, loadResolver, type TickerResolver } from '../extraction/normalizer';

// ---------------------------------------------------------------------------
// Seed source URLs (centralized). Flag any uncertain ones here.
// ---------------------------------------------------------------------------

/**
 * Free, public, pre-aggregated disclosure datasets.
 *
 * The original house/senate-stock-watcher S3 buckets now return HTTP 403
 * (AccessDenied), so the defaults below point at sources confirmed reachable as
 * of 2026-06. Both are overridable via SEED_SENATE_URL / SEED_HOUSE_URL.
 *
 * - senate: the timothycarambat/senate-stock-watcher-data GitHub mirror (same
 *   data as senatestockwatcher.com), served over raw.githubusercontent.com.
 *   CONFIDENT — verified reachable and in the expected RawWatcherRecord shape.
 * - house:  there is no maintained pre-parsed House JSON mirror; the community
 *   S3 bucket is gated. The high-fidelity path for House history is
 *   `runHouseHistoricalBackfill` (backfill/houseCrawler.ts, exposed as
 *   POST /api/admin/house-backfill), which pulls the official, accessible
 *   yearly bulk ZIP indexes and runs them through the live pipeline. This URL
 *   remains as a hook for operators who host their own House aggregate.
 *   UNCERTAIN — set SEED_HOUSE_URL or use the House backfill instead.
 */
/**
 * Base confidence for seed (pre-aggregated, third-party) rows BEFORE the shared
 * validation rubric is applied. Seed fields are clean and structured but are not
 * a first-party parse of the source filing, so the base sits just under a clean
 * House text extraction (CLEAN_CONFIDENCE = 0.97). The SAME rubric the live
 * normalizer uses (scoreFields) is then applied, so a clean seed row lands ~0.95
 * — directly comparable to a live-parsed row. Provenance (seed vs primary) is
 * tracked by transactions.source, NOT baked into this number.
 */
export const SEED_BASE_CONFIDENCE = 0.95;

/**
 * Statements per D1 batch() call. Each batch is ONE Worker subrequest, so this
 * keeps a full ~8k-row refresh well under Cloudflare's per-invocation subrequest
 * cap (~1000). Kept modest so a single batch payload stays small.
 */
const SEED_BATCH_SIZE = 50;

export const SEED_SOURCES: Record<Chamber, { url: string; certain: boolean }> = {
  senate: {
    url: 'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json',
    certain: true,
  },
  house: {
    // Legacy community bucket — currently gated (HTTP 403). Override via
    // SEED_HOUSE_URL, or prefer POST /api/admin/house-backfill (houseCrawler.ts)
    // for official House history.
    url: 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
    certain: false,
  },
};

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface SeedBackfillOptions {
  /** Which chambers to seed. Defaults to both. */
  chambers?: Chamber[];
  /** Only import transactions whose tx_date year is >= this. */
  sinceYear?: number;
  /** Hard cap on rows inserted across all sources (safety valve). */
  limit?: number;
  /** If true, do not write — just count what would be imported. */
  dryRun?: boolean;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Per-chamber source URL overrides. The hardcoded SEED_SOURCES point at the
   * community house/senate-stock-watcher S3 buckets, which have historically
   * gone offline / locked down (HTTP 403). Operators can point the backfill at
   * a working mirror without a code change — `runSeedBackfillFromEnv` reads
   * SEED_HOUSE_URL / SEED_SENATE_URL and forwards them here.
   */
  sourceUrls?: Partial<Record<Chamber, string>>;
}

export interface SeedBackfillResult {
  /** Rows inserted (or, in dryRun, that would be inserted). */
  inserted: number;
  /** Rows seen but not inserted (bad data, below sinceYear, over limit). */
  skipped: number;
  /** Per-chamber inserted counts. */
  bySource: Record<string, number>;
  /** Soft, per-source errors. The run continues past any single failure. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Raw record shapes (loose — community datasets are inconsistent)
// ---------------------------------------------------------------------------

/**
 * A single raw record from either watcher dataset. Field names differ slightly
 * between House and Senate dumps, so every field is optional and we probe a few
 * aliases when mapping.
 */
export interface RawWatcherRecord {
  // names
  senator?: string;
  representative?: string;
  // asset
  ticker?: string;
  asset_description?: string;
  asset_type?: string;
  // transaction
  type?: string;
  transaction_date?: string;
  disclosure_date?: string;
  amount?: string;
  owner?: string;
  // allow anything else
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (no network, no DB — unit-tested directly)
// ---------------------------------------------------------------------------

const SEED_ASSET_TYPE_NAMES: Record<string, string> = {
  Stock: 'Stock',
  'Stock Option': 'Stock Option',
  'Municipal Security': 'Municipal Security',
  'Other Securities': 'Other Securities',
  'Corporate Bond': 'Corporate Bond',
  'Non-Public Stock': 'Non-Public Stock',
};

function seedAssetTypeName(assetType: string | null): string | null {
  if (!assetType) return null;
  return HOUSE_ASSET_TYPE_NAMES[assetType] ?? SEED_ASSET_TYPE_NAMES[assetType] ?? null;
}

function cleanSeedDetail(value: string | null): string | null {
  const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function parseSeedAssetDescription(raw: string | undefined): {
  assetName: string;
  description: string | null;
  supplementalText: string | null;
} {
  const source = raw ?? '';
  const firstTag = source.search(/<[^>]+>/);
  const base = firstTag >= 0 ? sanitizeAssetName(source.slice(0, firstTag)) : sanitizeAssetName(source);
  const full = sanitizeAssetName(source);
  let detail = full;
  if (base && full.toLowerCase().startsWith(base.toLowerCase())) detail = full.slice(base.length);
  detail = detail.replace(/^[-–—:;,\s]+/, '').trim();
  const supplementalText = detail && detail.toLowerCase() !== base.toLowerCase() ? detail : null;
  let description: string | null = null;
  const descriptionMatch = supplementalText?.match(/\bDescription:\s*(.+)$/i);
  const optionMatch = supplementalText?.match(/\bOption\s+Type:\s*(.+)$/i);
  const rateMatch = supplementalText?.match(/\bRate\/Coupon:\s*(.+)$/i);
  const companyMatch = supplementalText?.match(/\bCompany:\s*(.+)$/i);
  if (descriptionMatch) description = cleanSeedDetail(descriptionMatch[1]);
  else if (optionMatch) description = cleanSeedDetail(`Option Type: ${optionMatch[1]}`);
  else if (rateMatch) description = cleanSeedDetail(`Rate/Coupon: ${rateMatch[1]}`);
  else if (companyMatch) description = cleanSeedDetail(`Company: ${companyMatch[1]}`);
  else description = cleanSeedDetail(supplementalText);
  return {
    assetName: base || full,
    description,
    supplementalText: cleanSeedDetail(supplementalText),
  };
}

/** Normalize a raw transaction-type string to the TxType union P|S|E. */
export function mapTxType(raw: string | undefined): TxType {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('exchange')) return 'E';
  if (t.includes('sale') || t.includes('sell') || t.startsWith('s')) return 'S';
  // "purchase", "buy", "p", or anything unrecognized defaults to purchase.
  return 'P';
}

function isUnknownSeedTxType(raw: string | undefined): boolean {
  const t = (raw ?? '').toLowerCase().trim();
  return !t || t === '--' || t === 'n/a' || t === 'na' || t === 'unknown';
}

function isScannedPdfPlaceholder(raw: string | undefined): boolean {
  const t = (raw ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return t.includes('this filing was disclosed via scanned pdf') ||
    t.includes('use link in ptr_link column to view the pdf') ||
    t.includes('pdf disclosed filing');
}

/** Normalize a raw owner string to the Owner union, or null when absent/unknown. */
export function mapOwner(raw: string | undefined): Owner | null {
  const o = (raw ?? '').toLowerCase().trim();
  if (!o || o === '--' || o === 'n/a') return null;
  if (o.startsWith('sp')) return 'spouse'; // "Spouse", "SP"
  if (o.startsWith('jt') || o.includes('joint')) return 'joint';
  if (o.startsWith('dc') || o.includes('depend') || o.includes('child')) return 'dependent';
  if (o.startsWith('self') || o === 'c' || o.includes('self')) return 'self';
  return null;
}

/**
 * Normalize a raw tx date to ISO `YYYY-MM-DD`, or null when unparseable.
 * Accepts "MM/DD/YYYY" (watcher style) and already-ISO strings.
 */
export function normalizeDate(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // already ISO-ish
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // MM/DD/YYYY
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) {
    const mm = us[1].padStart(2, '0');
    const dd = us[2].padStart(2, '0');
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

/**
 * Map a watcher "amount" bracket string ("$1,001 - $15,000", "$50,000,001 +")
 * to a canonical STOCK Act [min,max] pair via shared/brackets. Returns
 * { min:null, max:null } when nothing parseable.
 */
export function mapAmount(raw: string | undefined): { min: number | null; max: number | null } {
  const text = (raw ?? '').trim();
  if (!text) return { min: null, max: null };
  const nums = (text.match(/[\d,]+/g) ?? [])
    .map((t) => Number(t.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return { min: null, max: null };
  const lo = Math.min(...nums);
  const openEnded = /\+\s*$/.test(text) || /\bover\b/i.test(text);
  const hi = openEnded ? null : nums.length > 1 ? Math.max(...nums) : null;
  const bracket = nearestBracket(lo, hi);
  if (bracket) return { min: bracket.min, max: bracket.max };
  return { min: lo, max: hi };
}

/** Pick the filer display name from whichever chamber field is present. */
export function pickFilerName(rec: RawWatcherRecord): string {
  const n = (rec.senator ?? rec.representative ?? '').trim();
  return n;
}

/**
 * Deterministic synthetic filer id derived from chamber + display name.
 * Seed datasets have no bioguide id, so we mint a stable `seed-<chamber>-<slug>`
 * key. Re-running yields the same id, so filer upserts are idempotent too.
 */
export function seedFilerId(chamber: Chamber, name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;
  return `seed-${chamber}-${slug}`;
}

/**
 * Deterministic transaction id = djb2 hash of
 * source + filerId + date + ticker + amount. Idempotent across runs and stable
 * regardless of insertion order. Returns a `seed_…` prefixed hex string.
 */
export function deterministicTxId(parts: {
  source: string;
  filerId: string | null;
  txDate: string | null;
  ticker: string | null;
  amountMin: number | null;
  amountMax: number | null;
}): string {
  const key = [
    parts.source,
    parts.filerId ?? '',
    parts.txDate ?? '',
    (parts.ticker ?? '').toUpperCase(),
    parts.amountMin ?? '',
    parts.amountMax ?? '',
  ].join('|');
  // djb2 — deterministic, dependency-free, Workers-safe.
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  // Second pass over the reversed string widens the space, lowering collisions.
  let h2 = 52711;
  for (let i = key.length - 1; i >= 0; i--) {
    h2 = ((h2 << 5) + h2 + key.charCodeAt(i)) >>> 0;
  }
  return `seed_${h.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Map one raw watcher record into a persistence-ready Transaction (source =
 * 'seed_dataset'). Returns null when the record is too malformed to be useful
 * (no asset and no ticker). `docId` is a synthetic per-chamber sentinel because
 * seed rows have no real filing document.
 *
 * Pure: no network, no DB. cursorSeq is left 0 (DB assigns the real value).
 */
export function mapRecordToTransaction(
  rec: RawWatcherRecord,
  chamber: Chamber,
  nowIso: string,
  resolve: TickerResolver,
): Transaction | null {
  const parsedAsset = parseSeedAssetDescription(rec.asset_description);
  const assetName = parsedAsset.assetName;
  if (isScannedPdfPlaceholder(rec.asset_description)) return null;
  if ((rec.asset_type ?? '').trim().toLowerCase() === 'pdf disclosed filing') return null;
  if (isUnknownSeedTxType(rec.type)) return null;
  const rawTicker = normalizeTicker(rec.ticker);
  if (!assetName && !rawTicker) return null;

  const filerName = pickFilerName(rec);
  const filerId = seedFilerId(chamber, filerName);
  const txDate = normalizeDate(rec.transaction_date);
  const rawTxType = mapTxType(rec.type);
  const { min, max } = mapAmount(rec.amount);
  const source = 'seed_dataset' as const;
  const assetType = (rec.asset_type ?? '').trim() || null;
  const assetTypeName = seedAssetTypeName(assetType);
  const isOption =
    assetType === 'Stock Option' || /\b(option\s+type|strike\s+price|expires):/i.test(parsedAsset.supplementalText ?? '');

  // Score with the SAME rubric the live normalizer uses, from a clean-import
  // base. Seed rows have no filing document, so there's no filed_date to check
  // tx_date against (filedDate = null skips that penalty).
  const scored = scoreFields(
    SEED_BASE_CONFIDENCE,
    { ticker: rawTicker, assetName, amountMin: min, amountMax: max, txType: rawTxType, txDate },
    null,
    resolve,
  );

  // The id is derived from the RAW source fields (not the scored/snapped ones)
  // so it stays stable across rubric changes — keeping re-imports idempotent.
  const id = deterministicTxId({
    source,
    filerId,
    txDate,
    ticker: rawTicker,
    amountMin: min,
    amountMax: max,
  });

  return {
    id,
    docId: `seed-${chamber}`,
    filerId,
    txDate,
    owner: mapOwner(rec.owner),
    assetName: assetName || (scored.ticker ?? ''),
    ticker: scored.ticker,
    assetType,
    assetTypeName,
    txType: scored.txType,
    amountMin: scored.amountMin,
    amountMax: scored.amountMax,
    isOption,
    capGainsOver200: false,
    rawText: JSON.stringify({
      member: filerName,
      type: rec.type ?? null,
      amount: rec.amount ?? null,
    }),
    description: parsedAsset.description,
    supplementalText: parsedAsset.supplementalText,
    confidence: scored.confidence,
    source,
    createdAt: nowIso,
    cursorSeq: 0,
  };
}

/** Clean a raw ticker: uppercase, drop placeholders ("--", "N/A", "<empty>"). */
function normalizeTicker(raw: string | undefined): string | null {
  const t = (raw ?? '').trim().toUpperCase();
  if (!t || t === '--' || t === 'N/A' || t === '<empty>' || t === 'NONE') return null;
  return t;
}

/** True iff this transaction's tx_date year is >= sinceYear (or no filter). */
export function passesSinceYear(tx: Transaction, sinceYear: number | undefined): boolean {
  if (sinceYear === undefined) return true;
  if (!tx.txDate) return false;
  const year = Number(tx.txDate.slice(0, 4));
  return Number.isFinite(year) && year >= sinceYear;
}

// ---------------------------------------------------------------------------
// Persistence (idempotent upserts)
// ---------------------------------------------------------------------------

type SqlStatement = [string, Array<string | number | null>];

/** Statement to upsert a synthetic seed filer (INSERT OR IGNORE — never clobbers real meta). */
function buildSeedFilerStatement(filerId: string, chamber: Chamber, fullName: string): SqlStatement {
  return [
    `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, party, state, district, committees)
     VALUES (?, ?, ?, '', '', '', '[]')`,
    [filerId, chamber, fullName],
  ];
}

/**
 * Upsert one seed transaction, keyed on the deterministic id. On conflict it
 * refreshes the mutable, re-derivable columns (asset_name, ticker, amounts,
 * tx_type, confidence, raw_text) so a re-run reconciles existing rows to the
 * latest mapping/scoring WITHOUT creating duplicates — and preserves the
 * original cursor_seq + created_at (feed ordering is stable). The
 * `WHERE source='seed_dataset'` guard means it can never clobber a primary row
 * that happens to share an id. Returns true when a row was inserted or updated.
 */
function buildSeedTxStatement(tx: Transaction): SqlStatement {
  return [
    `INSERT INTO transactions (
       id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
       asset_type_name, tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
       raw_text, description, supplemental_text, confidence, source, created_at, cursor_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed_dataset', ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       asset_name = excluded.asset_name,
       ticker = excluded.ticker,
       asset_type = excluded.asset_type,
       asset_type_name = excluded.asset_type_name,
       tx_type = excluded.tx_type,
       amount_min = excluded.amount_min,
       amount_max = excluded.amount_max,
       is_option = excluded.is_option,
       raw_text = excluded.raw_text,
       description = excluded.description,
       supplemental_text = excluded.supplemental_text,
       confidence = excluded.confidence
     WHERE transactions.source = 'seed_dataset'`,
    [
      tx.id,
      tx.docId,
      tx.filerId,
      tx.txDate,
      tx.owner,
      tx.assetName,
      tx.ticker,
      tx.assetType,
      tx.assetTypeName ?? null,
      tx.txType,
      tx.amountMin,
      tx.amountMax,
      tx.isOption ? 1 : 0,
      tx.capGainsOver200 ? 1 : 0,
      tx.rawText,
      tx.description ?? null,
      tx.supplementalText ?? null,
      tx.confidence,
      tx.createdAt,
    ],
  ];
}

/** Fetch + parse one chamber's aggregate JSON. Throws on transport/parse error. */
async function fetchChamberRecords(
  chamber: Chamber,
  fetchImpl: typeof fetch,
  urlOverride?: string,
): Promise<RawWatcherRecord[]> {
  const url = urlOverride || SEED_SOURCES[chamber].url;
  const res = await fetchImpl(url, {
    headers: {
      'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
      accept: 'application/json,*/*',
    },
  });
  if (!res.ok) throw new Error(`${chamber} seed GET ${url} -> HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    throw new Error(`${chamber} seed payload was not a JSON array`);
  }
  return json as RawWatcherRecord[];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the seed-dataset backfill. Fails soft per-source: a failure pulling or
 * parsing one chamber is recorded in `errors` and does not abort the others.
 *
 * Does NOT enqueue delivery — seed rows are history/reference only.
 */
export async function runSeedBackfill(
  env: Env,
  opts: SeedBackfillOptions = {},
): Promise<SeedBackfillResult> {
  const chambers = opts.chambers ?? (['house', 'senate'] as Chamber[]);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const nowIso = new Date().toISOString();

  // Resolve tickers against securities_master with the same resolver the live
  // normalizer uses, so seed rows score on identical footing. dryRun (and the
  // bare-env unit tests) never touch the DB, so fall back to a no-op resolver.
  const resolve: TickerResolver =
    opts.dryRun || !env.DB ? () => null : await loadResolver(env);

  const result: SeedBackfillResult = {
    inserted: 0,
    skipped: 0,
    bySource: {},
    errors: [],
  };
  const seenFilers = new Set<string>();

  // Writes are grouped into D1 batches: one batch() call = one Worker subrequest,
  // so ~8k upserts collapse from ~8k subrequests (over Cloudflare's per-invocation
  // cap) to a few hundred. `pending` records the chamber for each *tx* statement
  // (null for filer statements) so we can attribute changes after the batch runs.
  let queued: SqlStatement[] = [];
  let pending: Array<Chamber | null> = [];
  let queuedTxCount = 0;

  const flush = async () => {
    if (queued.length === 0) return;
    try {
      const results = await batch(env.DB, queued);
      results.forEach((r, i) => {
        const chamber = pending[i];
        if (!chamber) return; // filer upsert — not counted as a tx row.
        const changes = (r as D1Result).meta?.changes ?? 0;
        if (changes > 0) {
          result.inserted++;
          result.bySource[chamber] = (result.bySource[chamber] ?? 0) + 1;
        } else {
          result.skipped++; // upsert WHERE-guarded out (e.g. a primary row owns the id).
        }
      });
    } catch (err) {
      result.errors.push(`batch upsert: ${(err as Error).message}`);
      for (const chamber of pending) if (chamber) result.skipped++;
    } finally {
      queued = [];
      pending = [];
    }
  };

  for (const chamber of chambers) {
    result.bySource[chamber] = result.bySource[chamber] ?? 0;
    let records: RawWatcherRecord[];
    try {
      records = await fetchChamberRecords(chamber, fetchImpl, opts.sourceUrls?.[chamber]);
    } catch (err) {
      result.errors.push(`${chamber}: ${(err as Error).message}`);
      continue; // fail soft — move to the next chamber.
    }

    for (const rec of records) {
      if (queuedTxCount >= limit) {
        result.skipped++;
        continue;
      }
      const tx = mapRecordToTransaction(rec, chamber, nowIso, resolve);
      if (!tx) {
        result.skipped++;
        continue;
      }
      if (!passesSinceYear(tx, opts.sinceYear)) {
        result.skipped++;
        continue;
      }

      if (opts.dryRun) {
        result.inserted++;
        result.bySource[chamber]++;
        continue;
      }

      // Queue the synthetic filer upsert once per id per run, then the tx upsert.
      if (tx.filerId && !seenFilers.has(tx.filerId)) {
        queued.push(buildSeedFilerStatement(tx.filerId, chamber, pickFilerName(rec)));
        pending.push(null);
        seenFilers.add(tx.filerId);
      }
      queued.push(buildSeedTxStatement(tx));
      pending.push(chamber);
      queuedTxCount++;

      if (queued.length >= SEED_BATCH_SIZE) await flush();
    }
  }

  await flush();
  return result;
}

/** Env shape (read defensively — Env is the frozen foundation contract). */
type EnvWithSeed = Env & { SEED_HOUSE_URL?: string; SEED_SENATE_URL?: string };

/**
 * Convenience wrapper that layers SEED_HOUSE_URL / SEED_SENATE_URL env overrides
 * onto an explicit set of options before running the backfill. This is the entry
 * point the admin trigger route uses, so operators can repoint the (frequently
 * gated) community datasets at a working mirror without redeploying code.
 */
export function runSeedBackfillFromEnv(
  env: Env,
  opts: SeedBackfillOptions = {},
): Promise<SeedBackfillResult> {
  const e = env as EnvWithSeed;
  const sourceUrls: Partial<Record<Chamber, string>> = { ...opts.sourceUrls };
  if (e.SEED_HOUSE_URL && sourceUrls.house === undefined) sourceUrls.house = e.SEED_HOUSE_URL;
  if (e.SEED_SENATE_URL && sourceUrls.senate === undefined) sourceUrls.senate = e.SEED_SENATE_URL;
  return runSeedBackfill(env, { ...opts, sourceUrls });
}
