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
import { run } from '../shared/db';
import { nearestBracket } from '../shared/brackets';

// ---------------------------------------------------------------------------
// Seed source URLs (centralized). Flag any uncertain ones here.
// ---------------------------------------------------------------------------

/**
 * Free, public, pre-aggregated disclosure datasets.
 *
 * - senate: the senate-stock-watcher S3 aggregate. URL is well-known/stable and
 *   was given by the task spec. CONFIDENT.
 * - house:  the house-stock-watcher aggregate. The project mirrors the senate
 *   bucket layout on its own S3 bucket. The exact bucket host is best-effort
 *   (UNCERTAIN — verify against https://housestockwatcher.com if it 404s); the
 *   backfill fails soft per-source, so a wrong House URL degrades to "Senate
 *   only" rather than breaking the run.
 */
export const SEED_SOURCES: Record<Chamber, { url: string; certain: boolean }> = {
  senate: {
    // Given by task spec; stable. CONFIDENT.
    url: 'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
    certain: true,
  },
  house: {
    // house-stock-watcher aggregate, mirroring the senate bucket convention.
    // UNCERTAIN — confirm bucket/host if this 404s.
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

/** Normalize a raw transaction-type string to the TxType union P|S|E. */
export function mapTxType(raw: string | undefined): TxType {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('exchange')) return 'E';
  if (t.includes('sale') || t.includes('sell') || t.startsWith('s')) return 'S';
  // "purchase", "buy", "p", or anything unrecognized defaults to purchase.
  return 'P';
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
): Transaction | null {
  const assetName = (rec.asset_description ?? '').trim();
  const ticker = normalizeTicker(rec.ticker);
  if (!assetName && !ticker) return null;

  const filerName = pickFilerName(rec);
  const filerId = seedFilerId(chamber, filerName);
  const txDate = normalizeDate(rec.transaction_date);
  const txType = mapTxType(rec.type);
  const { min, max } = mapAmount(rec.amount);
  const source = 'seed_dataset' as const;

  const id = deterministicTxId({
    source,
    filerId,
    txDate,
    ticker,
    amountMin: min,
    amountMax: max,
  });

  return {
    id,
    docId: `seed-${chamber}`,
    filerId,
    txDate,
    owner: mapOwner(rec.owner),
    assetName: assetName || (ticker ?? ''),
    ticker,
    assetType: (rec.asset_type ?? '').trim() || null,
    txType,
    amountMin: min,
    amountMax: max,
    isOption: false,
    capGainsOver200: false,
    rawText: JSON.stringify({
      member: filerName,
      type: rec.type ?? null,
      amount: rec.amount ?? null,
    }),
    confidence: 1,
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

/** Upsert a synthetic seed filer (INSERT OR IGNORE — never clobbers real meta). */
async function upsertSeedFiler(
  env: Env,
  filerId: string,
  chamber: Chamber,
  fullName: string,
): Promise<void> {
  await run(
    env.DB,
    `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, party, state, district, committees)
     VALUES (?, ?, ?, '', '', '', '[]')`,
    [filerId, chamber, fullName],
  );
}

/**
 * Insert one seed transaction. INSERT OR IGNORE on the deterministic id makes
 * this idempotent and prevents clobbering a primary row sharing the identity.
 * cursor_seq is left NULL so trg_transactions_cursor assigns it. Returns true
 * when a new row was actually inserted.
 */
async function insertSeedTransaction(env: Env, tx: Transaction): Promise<boolean> {
  const res = await run(
    env.DB,
    `INSERT OR IGNORE INTO transactions (
       id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
       tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
       raw_text, confidence, source, created_at, cursor_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed_dataset', ?, NULL)`,
    [
      tx.id,
      tx.docId,
      tx.filerId,
      tx.txDate,
      tx.owner,
      tx.assetName,
      tx.ticker,
      tx.assetType,
      tx.txType,
      tx.amountMin,
      tx.amountMax,
      tx.isOption ? 1 : 0,
      tx.capGainsOver200 ? 1 : 0,
      tx.rawText,
      tx.confidence,
      tx.createdAt,
    ],
  );
  // D1 meta.changes is the number of rows written (0 when IGNORE-d).
  const changes = (res as D1Result).meta?.changes ?? 0;
  return changes > 0;
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

  const result: SeedBackfillResult = {
    inserted: 0,
    skipped: 0,
    bySource: {},
    errors: [],
  };
  const seenFilers = new Set<string>();

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
      if (result.inserted >= limit) {
        result.skipped++;
        continue;
      }
      const tx = mapRecordToTransaction(rec, chamber, nowIso);
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

      try {
        // Upsert the synthetic filer once per id per run.
        if (tx.filerId && !seenFilers.has(tx.filerId)) {
          const name = pickFilerName(rec);
          await upsertSeedFiler(env, tx.filerId, chamber, name);
          seenFilers.add(tx.filerId);
        }
        const wrote = await insertSeedTransaction(env, tx);
        if (wrote) {
          result.inserted++;
          result.bySource[chamber]++;
        } else {
          result.skipped++; // already present (idempotent re-run / primary wins).
        }
      } catch (err) {
        result.errors.push(`${chamber} row insert: ${(err as Error).message}`);
        result.skipped++;
      }
    }
  }

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
