/**
 * src/extraction/normalizer.ts
 * OWNER: extraction agent
 *
 * The validator / normalizer + persistence step. Turns extractor output
 * (ParsedTx[]) into persistence-ready Transaction rows and writes the result:
 *   - resolve ticker against securities_master (exact ticker, then alias JSON)
 *   - enforce the canonical STOCK Act bracket set (see src/shared/brackets.ts)
 *   - sanity-check tx_date <= filed_date and tx_type in {P,S,E}
 *   - compute per-tx confidence = extractor confidence x validation penalties
 *   - route low-confidence docs to review_queue; otherwise INSERT transactions,
 *     mark filings persisted, and fan out delivery.dispatch per tx.
 *
 * index.ts does NOT delegate persistence to a separate module (the
 * `filing.extracted` queue case is a no-op hook), so this function owns the full
 * normalize + persist path. The extraction orchestrator calls:
 *     const result = await normalize(env, filing, extractorResult.transactions);
 * after running buildExtractorPipeline(env).
 */

import type { Env, Filing, Owner, ParsedTx, Transaction, TxType } from '../shared/types';
import { all, run, fromBool, parseJson } from '../shared/db';
import { isValidBracket, matchBracket, nearestBracket } from '../shared/brackets';
import { uuid } from '../shared/ids';

/**
 * Per-tx confidence at or above this threshold is trusted for auto-publish. If a
 * filing's lowest per-tx confidence falls below it (or any structural validation
 * fails), the whole filing is routed to review instead of being published.
 */
export const CONFIDENCE_THRESHOLD = 0.85;

// Multiplicative penalties applied to the extractor's per-row confidence when a
// validation check is soft-failed. Each is in (0,1]; they compound.
const PENALTY_UNRESOLVED_TICKER = 0.85; // asset/ticker could not be resolved
const PENALTY_INVALID_BRACKET = 0.6; //   amount range is not a canonical bracket
const PENALTY_FUTURE_TX_DATE = 0.7; //    tx_date after the filing's filed_date
const PENALTY_BAD_TX_TYPE = 0.5; //       tx_type not in {P,S,E}

/** Outcome of normalizing one filing's extracted rows. */
export interface NormalizeResult {
  /** Rows that passed validation and were persisted (or staged for review). */
  transactions: Transaction[];
  /** The minimum per-tx confidence across the filing (1 when no rows). */
  minConfidence: number;
  /** Whether the filing was routed to review_queue rather than published. */
  needsReview: boolean;
}

interface FlaggedTx {
  tx: Transaction;
  flags: string[];
}

/** securities_master row shape. `aliases` is a JSON string array. */
interface SecRow {
  ticker: string;
  name: string | null;
  aliases: string | null;
}

/**
 * Normalize + validate parsed transactions for a filing, then persist.
 *
 * Behaviour:
 *   - Build a Transaction for each ParsedTx, applying ticker resolution and
 *     validation penalties to derive a final per-tx confidence.
 *   - needsReview = (no rows) OR (minConfidence < CONFIDENCE_THRESHOLD) OR any
 *     hard structural problem (invalid bracket, bad tx_type).
 *   - If needsReview: write a review_queue row + filings.ingest_status =
 *     'needs_review'; do NOT INSERT transactions and do NOT publish.
 *   - Else: INSERT each transaction (source='primary'), set ingest_status =
 *     'persisted', and enqueue { type:'delivery.dispatch', txId } per row.
 *   - In all cases store filings.confidence / extractor / model_version.
 */
export async function normalize(
  env: Env,
  filing: Filing,
  parsed: ParsedTx[],
  meta?: { extractor?: string; modelVersion?: string | null },
): Promise<NormalizeResult> {
  const nowIso = new Date().toISOString();
  const extractorName = meta?.extractor ?? filing.extractor ?? null;
  const modelVersion = meta?.modelVersion ?? filing.modelVersion ?? null;

  // Load the securities master once for in-memory resolution.
  const secRows = await all<SecRow>(env.DB, 'SELECT ticker, name, aliases FROM securities_master');
  const resolver = buildResolver(secRows);

  const flagged: FlaggedTx[] = parsed.map((p) =>
    buildTransaction(p, filing, resolver, nowIso),
  );

  const minConfidence = flagged.length
    ? Math.min(...flagged.map((f) => f.tx.confidence))
    : 1;

  // Hard structural failures force review regardless of the soft confidence.
  const hasHardFailure = flagged.some(
    (f) => f.flags.includes('invalid_bracket') || f.flags.includes('bad_tx_type'),
  );

  const needsReview =
    flagged.length === 0 || minConfidence < CONFIDENCE_THRESHOLD || hasHardFailure;

  const transactions = flagged.map((f) => f.tx);

  // Always record the document-level extraction metadata + confidence.
  await run(
    env.DB,
    'UPDATE filings SET confidence = ?, extractor = ?, model_version = ? WHERE doc_id = ?',
    [minConfidence, extractorName, modelVersion, filing.docId],
  );

  if (needsReview) {
    await routeToReview(env, filing, flagged, minConfidence, nowIso);
    return { transactions, minConfidence, needsReview: true };
  }

  await persistTransactions(env, transactions);
  await run(env.DB, "UPDATE filings SET ingest_status = 'persisted', error = NULL WHERE doc_id = ?", [
    filing.docId,
  ]);

  // Fan out delivery for each newly persisted transaction.
  for (const tx of transactions) {
    try {
      await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId: tx.id });
    } catch (err) {
      console.error('normalize: delivery enqueue failed', tx.id, (err as Error).message);
    }
  }

  return { transactions, minConfidence, needsReview: false };
}

// ---------------------------------------------------------------------------
// Per-transaction normalization + validation
// ---------------------------------------------------------------------------

/** Build a Transaction (+ flags) from one ParsedTx, applying validation penalties. */
function buildTransaction(
  p: ParsedTx,
  filing: Filing,
  resolve: TickerResolver,
  nowIso: string,
): FlaggedTx {
  const flags: string[] = [];
  let confidence = clamp01(p.confidence);

  // --- ticker resolution: exact symbol, then alias/name lookup --------------
  // Only PENALIZE when a ticker string was supplied but couldn't be resolved
  // (a likely mis-parse). Many disclosures legitimately have no ticker — bonds,
  // real estate, private funds — and that should NOT lower confidence.
  const hadTickerInput = !!(p.ticker && p.ticker.trim());
  const resolved = resolve(p.ticker, p.assetName);
  let ticker = p.ticker;
  if (resolved) {
    ticker = resolved;
  } else if (hadTickerInput) {
    flags.push('unresolved_ticker');
    confidence *= PENALTY_UNRESOLVED_TICKER;
  } else {
    // Legitimately ticker-less asset — no ticker to resolve, no penalty.
    ticker = null;
  }

  // --- amount validation ----------------------------------------------------
  // Penalize only TRULY unusable amounts (missing, or a nonsensical range).
  // A plausible range that isn't an exact canonical bracket is snapped to the
  // nearest STOCK Act bracket WITHOUT penalty — common for House free-form amounts.
  let amountMin = p.amountMin;
  let amountMax = p.amountMax;
  if (amountMin === null || amountMin === undefined) {
    flags.push('no_amount');
    confidence *= PENALTY_INVALID_BRACKET;
  } else if (isValidBracket(amountMin, amountMax)) {
    const b = matchBracket(amountMin, amountMax);
    if (b) {
      amountMin = b.min;
      amountMax = b.max;
    }
  } else if (amountMin >= 0 && (amountMax === null || amountMax >= amountMin)) {
    // Plausible but non-canonical range -> snap to nearest bracket, no penalty.
    const b = nearestBracket(amountMin, amountMax);
    if (b) {
      amountMin = b.min;
      amountMax = b.max;
    }
  } else {
    // Negative / inverted range -> genuinely bad parse.
    flags.push('invalid_amount');
    confidence *= PENALTY_INVALID_BRACKET;
  }

  // --- tx_type must be one of P / S / E ------------------------------------
  let txType = p.txType;
  if (!isTxType(txType)) {
    flags.push('bad_tx_type');
    confidence *= PENALTY_BAD_TX_TYPE;
    txType = 'P';
  }

  // --- tx_date sanity: must be <= filed_date -------------------------------
  const txDate = p.txDate;
  if (txDate && filing.filedDate && txDate > filing.filedDate) {
    flags.push('future_tx_date');
    confidence *= PENALTY_FUTURE_TX_DATE;
  }

  const tx: Transaction = {
    id: uuid(),
    docId: filing.docId,
    filerId: filing.filerId,
    txDate,
    owner: normalizeOwner(p.owner),
    assetName: p.assetName || ticker || '(unknown)',
    ticker,
    assetType: p.assetType,
    txType,
    amountMin,
    amountMax,
    isOption: Boolean(p.isOption),
    capGainsOver200: Boolean(p.capGainsOver200),
    rawText: p.rawText ?? '',
    confidence: clamp01(confidence),
    source: 'primary',
    createdAt: nowIso,
    // cursor_seq is assigned by the DB trigger on insert.
    cursorSeq: 0,
  };

  return { tx, flags };
}

// ---------------------------------------------------------------------------
// Ticker resolution against securities_master
// ---------------------------------------------------------------------------

type TickerResolver = (ticker: string | null, assetName: string | null) => string | null;

/**
 * Build an in-memory resolver from securities_master rows. Resolution order:
 *   1. exact ticker symbol match (case-insensitive),
 *   2. exact alias match (alias JSON array, case-insensitive),
 *   3. exact security name match (case-insensitive).
 * Returns the canonical ticker, or null when nothing matches.
 */
function buildResolver(rows: SecRow[]): TickerResolver {
  const byTicker = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const r of rows) {
    const canonical = (r.ticker || '').toUpperCase();
    if (!canonical) continue;
    byTicker.set(canonical, canonical);
    if (r.name) byName.set(r.name.trim().toLowerCase(), canonical);
    const aliases = parseJson<string[]>(r.aliases, []);
    for (const a of aliases) {
      if (typeof a === 'string' && a.trim()) byAlias.set(a.trim().toLowerCase(), canonical);
    }
  }

  return (ticker, assetName) => {
    const t = (ticker || '').trim().toUpperCase();
    if (t && byTicker.has(t)) return byTicker.get(t)!;
    const name = (assetName || '').trim().toLowerCase();
    if (name && byAlias.has(name)) return byAlias.get(name)!;
    if (name && byName.has(name)) return byName.get(name)!;
    // Also try the raw ticker as an alias (sometimes asset name lands in ticker).
    const tl = t.toLowerCase();
    if (tl && byAlias.has(tl)) return byAlias.get(tl)!;
    return null;
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const INSERT_TX_SQL = `INSERT INTO transactions (
  id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
  tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
  raw_text, confidence, source, created_at, cursor_seq
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`;

/** Insert each validated transaction. cursor_seq is assigned by the DB trigger. */
async function persistTransactions(env: Env, transactions: Transaction[]): Promise<void> {
  for (const tx of transactions) {
    await run(env.DB, INSERT_TX_SQL, [
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
      fromBool(tx.isOption),
      fromBool(tx.capGainsOver200),
      tx.rawText,
      tx.confidence,
      tx.source,
      tx.createdAt,
    ]);
  }
}

/** Write (or upsert) a review_queue row and flag the filing needs_review. */
async function routeToReview(
  env: Env,
  filing: Filing,
  flagged: FlaggedTx[],
  minConfidence: number,
  nowIso: string,
): Promise<void> {
  const reasons = new Set<string>();
  for (const f of flagged) for (const flag of f.flags) reasons.add(flag);
  if (flagged.length === 0) reasons.add('no_transactions_extracted');
  if (minConfidence < CONFIDENCE_THRESHOLD) reasons.add('low_confidence');

  const reason = Array.from(reasons).join(',') || 'needs_review';
  const payload = JSON.stringify({
    minConfidence,
    extractor: filing.extractor,
    modelVersion: filing.modelVersion,
    transactions: flagged.map((f) => ({ ...f.tx, flags: f.flags })),
  });

  await run(
    env.DB,
    `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved)
       VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(doc_id) DO UPDATE SET
       reason = excluded.reason,
       payload = excluded.payload,
       created_at = excluded.created_at,
       resolved = 0`,
    [filing.docId, reason, payload, nowIso],
  );

  await run(
    env.DB,
    "UPDATE filings SET ingest_status = 'needs_review' WHERE doc_id = ?",
    [filing.docId],
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isTxType(v: unknown): v is TxType {
  return v === 'P' || v === 'S' || v === 'E';
}

function normalizeOwner(o: Owner | null): Owner | null {
  if (o === 'self' || o === 'spouse' || o === 'joint' || o === 'dependent') return o;
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
