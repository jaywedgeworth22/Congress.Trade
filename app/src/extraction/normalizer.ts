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
import { all, batch, fromBool, get, parseJson } from '../shared/db';
import { isValidBracket, matchBracket, nearestBracket } from '../shared/brackets';
import { canonicalizeAssetType } from '../shared/assetTypes';
import { uuid } from '../shared/ids';
import { estimateTransactionValue } from '../shared/transactionValue';
import {
  isPlaceholderTicker,
  resolvePreferredTickerFromAssetName,
  resolveTickerDeterministic,
} from './tickerNormalize';
import { resolveContinuousTicker } from '@jaywedgeworth22/congress-trading-shared';
import { flushDeliveryOutbox } from '../delivery/outbox';

/**
 * Per-tx confidence at or above this threshold is trusted for auto-publish. If a
 * filing's lowest per-tx confidence falls below it (or any structural validation
 * fails), the whole filing is routed to review instead of being published.
 */
export const CONFIDENCE_THRESHOLD = 0.85;
export const MAX_PUBLISH_TRANSACTIONS_PER_FILING = 200;

export class TransactionPublishLimitError extends Error {}

// Multiplicative penalties applied to the extractor's per-row confidence when a
// validation check is soft-failed. Each is in (0,1]; they compound.
const PENALTY_UNRESOLVED_TICKER = 0.85; // asset/ticker could not be resolved
const PENALTY_INVALID_BRACKET = 0.6; //   amount range is not a canonical bracket
const PENALTY_FUTURE_TX_DATE = 0.7; //    tx_date after the filing's filed_date
const PENALTY_BAD_TX_TYPE = 0.5; //       tx_type not in {P,S,E}
const PENALTY_BAD_ASSET_NAME = 0.4; //    parsed asset contains PTR header chrome

/** Outcome of normalizing one filing's extracted rows. */
export interface NormalizeResult {
  /** Rows that passed validation and were persisted (or staged for review). */
  transactions: Transaction[];
  /** The minimum per-tx confidence across the filing (0 when no rows were read). */
  minConfidence: number;
  /** Whether the filing was routed to review_queue rather than published. */
  needsReview: boolean;
  /** True only when this invocation won the persistence/review-state CAS. */
  published: boolean;
}

interface ReviewSnapshot {
  resolved: number;
  review_revision: number;
  agreement_suppressed_at: string | null;
}

export interface FlaggedTx {
  tx: Transaction;
  flags: string[];
}

/** Flags that force a filing to human review regardless of soft confidence. */
export const HARD_FAILURE_FLAGS = ['no_amount', 'invalid_amount', 'bad_tx_type', 'bad_asset_name'];
const HARD_FAILURE_FLAG_SET = new Set<string>(HARD_FAILURE_FLAGS);

export function hasHardFailureFlags(flagged: Iterable<{ flags: readonly string[] }>): boolean {
  for (const f of flagged) {
    if (f.flags.some((flag) => HARD_FAILURE_FLAG_SET.has(flag))) return true;
  }
  return false;
}

type RowKeyFields = Pick<
  ParsedTx,
  | 'txDate'
  | 'owner'
  | 'assetName'
  | 'ticker'
  | 'assetType'
  | 'assetTypeName'
  | 'txType'
  | 'amountMin'
  | 'amountMax'
  | 'isOption'
  | 'capGainsOver200'
  | 'rawText'
  | 'filingStatus'
  | 'subholding'
  | 'location'
  | 'description'
  | 'supplementalText'
>;

/**
 * Stable identity for one parsed row within one filing. The row index keeps
 * duplicate disclosed rows distinct; the fingerprint catches changed edits at
 * the same position. The unique DB key is (doc_id, source, row_key).
 */
export function transactionRowKey(
  source: Transaction['source'],
  rowIndex: number,
  fields: RowKeyFields,
): string {
  const payload = [
    fields.txDate ?? '',
    fields.owner ?? '',
    normalizeText(fields.assetName),
    (fields.ticker ?? '').toUpperCase(),
    normalizeText(fields.assetType),
    rowKeyAssetTypeName(fields.assetType, fields.assetTypeName ?? null),
    fields.txType ?? '',
    fields.amountMin ?? '',
    fields.amountMax ?? '',
    fields.isOption ? '1' : '0',
    fields.capGainsOver200 ? '1' : '0',
    normalizeText(fields.rawText),
    normalizeText(fields.filingStatus ?? null),
    normalizeText(fields.subholding ?? null),
    normalizeText(fields.location ?? null),
    normalizeText(fields.description ?? null),
    normalizeText(fields.supplementalText ?? null),
  ].join('\u001f');
  return `v1:${source}:${rowIndex}:${fnv1a32(payload)}`;
}

function rowKeyAssetTypeName(assetType: string | null | undefined, assetTypeName: string | null): string {
  const type = normalizeText(assetType ?? null);
  const name = normalizeText(assetTypeName);
  return name && name !== type ? name : '';
}

/**
 * Re-derive Transaction rows (with the current, recalibrated confidence rubric)
 * from parsed rows WITHOUT any DB write or delivery fan-out. Shared by normalize()
 * and the admin reprocess path, which recomputes confidence for already-persisted
 * filings and updates the existing rows in place.
 */
export async function recomputeTransactions(
  env: Env,
  filing: Filing,
  parsed: ParsedTx[],
): Promise<FlaggedTx[]> {
  const nowIso = new Date().toISOString();
  const resolver = await loadResolver(env);
  return parsed.map((p, rowIndex) => buildTransaction(p, filing, resolver, nowIso, rowIndex));
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

  const flagged: FlaggedTx[] = await recomputeTransactions(env, filing, parsed);

  const minConfidence = flagged.length
    ? Math.min(...flagged.map((f) => f.tx.confidence))
    : 0;

  // Hard structural failures force review regardless of the soft confidence.
  const hasHardFailure = hasHardFailureFlags(flagged);
  const exceedsPublishLimit = flagged.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING;

  const needsReview =
    flagged.length === 0 || minConfidence < CONFIDENCE_THRESHOLD || hasHardFailure || exceedsPublishLimit;

  const transactions = flagged.map((f) => f.tx);

  // Capture the queue version before any material state transition. The
  // review-open and publish batches below are conditional on this snapshot, so
  // a human decision that lands first wins without partial transaction rows.
  const reviewSnapshot = await get<ReviewSnapshot>(
    env.DB,
    `SELECT resolved, review_revision, agreement_suppressed_at
       FROM review_queue WHERE doc_id = ?`,
    [filing.docId],
  );

  // A completed decision is authoritative. Replaying an older extraction must
  // not reopen it or append a competing live row set.
  if (reviewSnapshot?.resolved === 1) {
    return { transactions, minConfidence, needsReview: false, published: false };
  }

  if (needsReview) {
    const reason = exceedsPublishLimit
      ? 'extraction_row_limit_exceeded'
      : reviewReason(flagged, minConfidence);
    const routed = await routeToReview(
      env,
      filing,
      flagged,
      minConfidence,
      nowIso,
      {
        extractor: extractorName,
        modelVersion,
        reasonOverride: exceedsPublishLimit ? reason : undefined,
      },
      reviewSnapshot,
    );
    return { transactions, minConfidence, needsReview: routed, published: false };
  }

  const persisted = await persistNormalizedPublish(
    env,
    filing.docId,
    transactions,
    reviewSnapshot,
    nowIso,
    {
      confidence: minConfidence,
      extractor: extractorName,
      modelVersion,
    },
  );
  if (!persisted.published) {
    return { transactions, minConfidence, needsReview: false, published: false };
  }
  const insertedIds = persisted.insertedIds;

  // Best-effort immediate flush. The durable outbox row was committed in the
  // same D1 batch as each transaction, so a queue outage cannot lose delivery;
  // the scheduled reconciler retries any row left pending.
  if (insertedIds.length > 0) {
    await flushDeliveryOutbox(env, { txIds: insertedIds, limit: insertedIds.length }).catch((err) =>
      console.error('normalize: delivery outbox flush failed', (err as Error).message),
    );
  }

  return { transactions, minConfidence, needsReview: false, published: true };
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
  rowIndex: number,
): FlaggedTx {
  const s = scoreFields(
    p.confidence,
    {
      ticker: p.ticker,
      assetName: p.assetName,
      amountMin: p.amountMin,
      amountMax: p.amountMax,
      txType: p.txType,
      txDate: p.txDate,
    },
    filing.filedDate,
    resolve,
  );
  const assetType = canonicalizeAssetType(p.assetType, p.assetTypeName ?? null, {
    isOption: p.isOption,
    assetName: p.assetName,
  });

  const tx: Transaction = {
    id: uuid(),
    docId: filing.docId,
    filerId: filing.filerId,
    txDate: p.txDate,
    owner: normalizeOwner(p.owner),
    assetName: p.assetName || s.ticker || '(unknown)',
    ticker: s.ticker,
    assetType: p.assetType,
    assetTypeName: p.assetTypeName ?? null,
    assetTypeCategory: assetType.category,
    assetTypeCategoryLabel: assetType.categoryLabel,
    txType: s.txType,
    amountMin: s.amountMin,
    amountMax: s.amountMax,
    isOption: Boolean(p.isOption),
    capGainsOver200: Boolean(p.capGainsOver200),
    rawText: p.rawText ?? '',
    filingStatus: p.filingStatus ?? null,
    subholding: p.subholding ?? null,
    location: p.location ?? null,
    description: p.description ?? null,
    supplementalText: p.supplementalText ?? null,
    confidence: s.confidence,
    source: 'primary',
    rowKey: transactionRowKey('primary', rowIndex, {
      ...p,
      ticker: s.ticker,
      txType: s.txType,
      amountMin: s.amountMin,
      amountMax: s.amountMax,
    }),
    firstSeenAt: filing.firstSeenAt,
    filedDate: filing.filedDate,
    createdAt: nowIso,
    // cursor_seq is assigned by the DB trigger on insert.
    cursorSeq: 0,
  };

  return { tx, flags: s.flags };
}

/** Result of applying the shared validation rubric to one row's fields. */
export interface ScoredFields {
  confidence: number;
  flags: string[];
  ticker: string | null;
  amountMin: number | null;
  amountMax: number | null;
  txType: TxType;
}

/**
 * Apply the shared validation rubric to one row's fields, starting from `base`
 * confidence and compounding penalties. Used by BOTH the live normalizer and the
 * seed backfill so every source is scored identically — provenance (parsed by us
 * vs imported) is tracked separately via transactions.source, NOT baked into
 * this number.
 *
 * Penalizes only genuine problems: a supplied-but-unresolvable ticker, a
 * missing/inverted amount, a bad tx_type, or a tx_date after the filing date.
 * Ticker-less assets and plausible non-canonical amounts are accepted/snapped
 * without penalty.
 */
export function scoreFields(
  base: number,
  fields: {
    ticker: string | null;
    assetName: string | null;
    amountMin: number | null;
    amountMax: number | null;
    txType: string | null;
    txDate: string | null;
  },
  filedDate: string | null,
  resolve: TickerResolver,
): ScoredFields {
  const flags: string[] = [];
  let confidence = clamp01(base);

  if (looksLikeHeaderContaminatedAsset(fields.assetName)) {
    flags.push('bad_asset_name');
    confidence *= PENALTY_BAD_ASSET_NAME;
  }

  // --- ticker resolution: exact symbol, then alias/name lookup --------------
  // Only PENALIZE when a ticker string was supplied but couldn't be resolved
  // (a likely mis-parse). Many disclosures legitimately have no ticker — bonds,
  // real estate, private funds — and that should NOT lower confidence.
  // A dash / "N/A" / blank is a "no ticker" marker, not an unresolved ticker —
  // treat it like a legitimately symbol-less asset (bond, fund) and don't penalize.
  const hadTickerInput = !!(fields.ticker && fields.ticker.trim()) && !isPlaceholderTicker(fields.ticker);
  const resolved = resolve(fields.ticker, fields.assetName);
  let ticker = fields.ticker;
  if (resolved) {
    ticker = resolved;
  } else if (hadTickerInput) {
    flags.push('unresolved_ticker');
    confidence *= PENALTY_UNRESOLVED_TICKER;
  } else {
    ticker = null;
  }

  // --- amount validation ----------------------------------------------------
  // Penalize only TRULY unusable amounts (missing, or a nonsensical range). A
  // plausible range that isn't an exact canonical bracket is snapped to the
  // nearest STOCK Act bracket WITHOUT penalty.
  let amountMin = fields.amountMin;
  let amountMax = fields.amountMax;
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
    const b = nearestBracket(amountMin, amountMax);
    if (b) {
      amountMin = b.min;
      amountMax = b.max;
    }
  } else {
    flags.push('invalid_amount');
    confidence *= PENALTY_INVALID_BRACKET;
  }

  // --- tx_type must be one of P / S / E ------------------------------------
  let txType = fields.txType as TxType;
  if (!isTxType(txType)) {
    flags.push('bad_tx_type');
    confidence *= PENALTY_BAD_TX_TYPE;
    txType = 'P';
  }

  // --- tx_date sanity: must be <= filed_date -------------------------------
  if (fields.txDate && filedDate && fields.txDate > filedDate) {
    flags.push('future_tx_date');
    confidence *= PENALTY_FUTURE_TX_DATE;
  }

  return { confidence: clamp01(confidence), flags, ticker, amountMin, amountMax, txType };
}

function looksLikeHeaderContaminatedAsset(assetName: string | null): boolean {
  if (!assetName) return false;
  return /(?:\bClerk of the House of Representatives\b|\bLegislative Resource Center\b|\bID Owner Asset Transaction Type\b|\bTransaction Type Date Notification Date Amount\b|\bPeriodic Transaction Report\b|Name:\s*Hon\.|Status:\s*Member|State\/District:)/i.test(
    assetName,
  );
}

// ---------------------------------------------------------------------------
// Ticker resolution against securities_master
// ---------------------------------------------------------------------------

export type TickerResolver = (ticker: string | null, assetName: string | null) => string | null;

/** Load securities_master once and return an in-memory ticker resolver. */
export async function loadResolver(env: Env): Promise<TickerResolver> {
  const secRows = await all<SecRow>(env.DB, 'SELECT ticker, name, aliases FROM securities_master');
  return buildResolver(secRows);
}

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
    const preferred = resolvePreferredTickerFromAssetName(assetName, (issuerName) => {
      const key = issuerName.trim().toLowerCase();
      return byAlias.get(key) ?? byName.get(key) ?? byTicker.get(key.toUpperCase()) ?? null;
    });
    if (preferred) return preferred;

    // Curated stale→current aliases (e.g. FB→META) take precedence over the
    // master, because the master can carry a STALE row for a reassigned ticker
    // (SEC reassigned FB to a ProShares ETF after Meta moved to META).
    const continuous = resolveContinuousTicker(t);
    if (continuous !== t && byTicker.has(continuous)) return byTicker.get(continuous)!;
    if (t && byTicker.has(t)) return byTicker.get(t)!;
    const name = (assetName || '').trim().toLowerCase();
    if (name && byAlias.has(name)) return byAlias.get(name)!;
    if (name && byName.has(name)) return byName.get(name)!;
    // Also try the raw ticker as an alias (sometimes asset name lands in ticker).
    const tl = t.toLowerCase();
    if (tl && byAlias.has(tl)) return byAlias.get(tl)!;
    // Deterministic fallback: `$`-series strip, punctuation variants, curated
    // stale→current aliases (probed against the master), then syntactic
    // acceptance of a well-formed symbol the master doesn't list yet. This is
    // what clears the dominant `unresolved_ticker` review-queue reason.
    return resolveTickerDeterministic(t, (sym) => (byTicker.has(sym) ? byTicker.get(sym)! : null));
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const CONDITIONAL_BULK_INSERT_TX_SQL = `INSERT OR IGNORE INTO transactions (
  id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
  tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
  raw_text, asset_type_name, filing_status, subholding, location, description,
  supplemental_text, row_key, confidence, source, created_at, cursor_seq,
  first_seen_at, filed_date, est_value
) SELECT
  json_extract(value, '$.id'), json_extract(value, '$.docId'),
  json_extract(value, '$.filerId'), json_extract(value, '$.txDate'),
  json_extract(value, '$.owner'), json_extract(value, '$.assetName'),
  json_extract(value, '$.ticker'), json_extract(value, '$.assetType'),
  json_extract(value, '$.txType'), json_extract(value, '$.amountMin'),
  json_extract(value, '$.amountMax'), json_extract(value, '$.isOption'),
  json_extract(value, '$.capGainsOver200'), json_extract(value, '$.rawText'),
  json_extract(value, '$.assetTypeName'), json_extract(value, '$.filingStatus'),
  json_extract(value, '$.subholding'), json_extract(value, '$.location'),
  json_extract(value, '$.description'), json_extract(value, '$.supplementalText'),
  json_extract(value, '$.rowKey'), json_extract(value, '$.confidence'),
  json_extract(value, '$.source'), json_extract(value, '$.createdAt'), NULL,
  json_extract(value, '$.firstSeenAt'), json_extract(value, '$.filedDate'),
  json_extract(value, '$.estValue')
  FROM json_each(?)`;

function transactionInsertJson(transactions: Transaction[]): string {
  return JSON.stringify(transactions.map((tx) => ({
    id: tx.id,
    docId: tx.docId,
    filerId: tx.filerId,
    txDate: tx.txDate,
    owner: tx.owner,
    assetName: tx.assetName,
    ticker: tx.ticker,
    assetType: tx.assetType,
    txType: tx.txType,
    amountMin: tx.amountMin,
    amountMax: tx.amountMax,
    isOption: fromBool(tx.isOption),
    capGainsOver200: fromBool(tx.capGainsOver200),
    rawText: tx.rawText,
    assetTypeName: tx.assetTypeName ?? null,
    filingStatus: tx.filingStatus ?? null,
    subholding: tx.subholding ?? null,
    location: tx.location ?? null,
    description: tx.description ?? null,
    supplementalText: tx.supplementalText ?? null,
    rowKey: tx.rowKey ?? null,
    confidence: tx.confidence,
    source: tx.source,
    createdAt: tx.createdAt,
    firstSeenAt: tx.firstSeenAt ?? null,
    filedDate: tx.filedDate ?? null,
    estValue: estimateTransactionValue(tx.amountMin, tx.amountMax),
  })));
}

const BULK_DELIVERY_OUTBOX_SQL = `INSERT OR IGNORE INTO delivery_outbox
  (tx_id, status, attempts, available_at, last_error, created_at, updated_at)
SELECT DISTINCT t.id, 'pending', 0, ?, NULL, ?, ?
  FROM transactions t
  JOIN json_each(?) requested
    ON (
      json_extract(requested.value, '$.rowKey') IS NOT NULL
      AND t.doc_id = json_extract(requested.value, '$.docId')
      AND t.source = json_extract(requested.value, '$.source')
      AND t.row_key = json_extract(requested.value, '$.rowKey')
    ) OR (
      json_extract(requested.value, '$.rowKey') IS NULL
      AND t.id = json_extract(requested.value, '$.id')
    )
 WHERE t.deprecated_at IS NULL`;

interface PublicationMetadata {
  confidence: number;
  extractor: string | null;
  modelVersion: string | null;
}

/**
 * Atomically publish a normalized row set. A first-pass filing is guarded by
 * the continued absence of a review row. A previously reviewed filing is
 * guarded by the unresolved revision captured before the batch. Both paths
 * commit exact rows, the filing state, and delivery intents together.
 */
async function persistNormalizedPublish(
  env: Env,
  docId: string,
  transactions: Transaction[],
  review: ReviewSnapshot | null,
  nowIso: string,
  metadata: PublicationMetadata,
): Promise<{ published: boolean; insertedIds: string[] }> {
  if (transactions.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING) {
    throw new TransactionPublishLimitError(
      `refusing to publish ${transactions.length} transactions; limit is ${MAX_PUBLISH_TRANSACTIONS_PER_FILING}`,
    );
  }
  const insertRowsJson = transactionInsertJson(transactions);
  const rowKeysJson = JSON.stringify(transactions.map((tx) => tx.rowKey ?? ''));
  const exactLiveSet = `(SELECT COUNT(*) FROM transactions
      WHERE doc_id = ? AND source IN ('primary', 'manual')
        AND deprecated_at IS NULL) = ?
    AND (SELECT COUNT(*) FROM transactions
      WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL
        AND row_key IN (SELECT value FROM json_each(?))) = ?`;

  const auditPayload = JSON.stringify({
    minConfidence: metadata.confidence,
    extractor: metadata.extractor,
    modelVersion: metadata.modelVersion,
    transactionCount: transactions.length,
  });
  let statements: Array<[string, any[]]>;
  let transitionIndex: number;
  if (review) {
    const revision = review.review_revision;
    statements = [
      [
        `${CONDITIONAL_BULK_INSERT_TX_SQL}
          WHERE EXISTS (SELECT 1 FROM review_queue
            WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
              AND agreement_suppressed_at IS NULL)`,
        [insertRowsJson, docId, revision],
      ],
      [
        `INSERT INTO review_queue (doc_id)
          SELECT ?
           WHERE EXISTS (SELECT 1 FROM review_queue
             WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
               AND agreement_suppressed_at IS NULL)
             AND NOT (${exactLiveSet})`,
        [
          docId, docId, revision,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
      [
        `${BULK_DELIVERY_OUTBOX_SQL}
          AND EXISTS (SELECT 1 FROM review_queue
            WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
              AND agreement_suppressed_at IS NULL)`,
        [nowIso, nowIso, nowIso, insertRowsJson, docId, revision],
      ],
      [
        `UPDATE filings
            SET ingest_status = 'persisted', error = NULL,
                confidence = ?, extractor = ?, model_version = ?
          WHERE doc_id = ?
            AND EXISTS (SELECT 1 FROM review_queue
              WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
                AND agreement_suppressed_at IS NULL)
            AND ${exactLiveSet}`,
        [
          metadata.confidence, metadata.extractor, metadata.modelVersion,
          docId, docId, revision,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
      [
        `INSERT OR IGNORE INTO ingestion_decisions
           (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
         SELECT ?, ?, 'auto_published', 'pipeline', NULL, 'passed_normalization', ?,
                COALESCE((
                  SELECT json_group_array(id) FROM (
                    SELECT id FROM transactions
                     WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL
                     ORDER BY id ASC
                  )
                ), '[]'), ?
          WHERE EXISTS (SELECT 1 FROM review_queue
            WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
              AND agreement_suppressed_at IS NULL)
            AND ${exactLiveSet}`,
        [
          `decision:auto_published:${docId}`, docId, auditPayload, docId, nowIso,
          docId, revision,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
      [
        `UPDATE review_queue
            SET resolved = 1,
                agreement_next_attempt_at = NULL,
                agreement_claim_token = NULL,
                agreement_claimed_at = NULL,
                agreement_suppressed_at = NULL,
                agreement_suppression_reason = NULL,
                review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
            AND agreement_suppressed_at IS NULL
            AND ${exactLiveSet}`,
        [
          docId, revision,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
    ];
    transitionIndex = statements.length - 1;
  } else {
    statements = [
      [
        `${CONDITIONAL_BULK_INSERT_TX_SQL}
          WHERE NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
            AND EXISTS (SELECT 1 FROM filings
              WHERE doc_id = ? AND ingest_status <> 'persisted')`,
        [insertRowsJson, docId, docId],
      ],
      [
        `INSERT INTO filings (doc_id)
          SELECT ?
           WHERE NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
             AND EXISTS (SELECT 1 FROM filings
               WHERE doc_id = ? AND ingest_status <> 'persisted')
             AND NOT (${exactLiveSet})`,
        [
          docId, docId, docId,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
      [
        `${BULK_DELIVERY_OUTBOX_SQL}
          AND NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
          AND EXISTS (SELECT 1 FROM filings
            WHERE doc_id = ? AND ingest_status <> 'persisted')`,
        [nowIso, nowIso, nowIso, insertRowsJson, docId, docId],
      ],
      [
        `UPDATE filings
            SET ingest_status = 'persisted', error = NULL,
                confidence = ?, extractor = ?, model_version = ?
          WHERE doc_id = ? AND ingest_status <> 'persisted'
            AND NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
            AND ${exactLiveSet}`,
        [
          metadata.confidence, metadata.extractor, metadata.modelVersion,
          docId, docId,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
      [
        `INSERT OR IGNORE INTO ingestion_decisions
           (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
         SELECT ?, ?, 'auto_published', 'pipeline', NULL, 'passed_normalization', ?,
                COALESCE((
                  SELECT json_group_array(id) FROM (
                    SELECT id FROM transactions
                     WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL
                     ORDER BY id ASC
                  )
                ), '[]'), ?
          WHERE NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
            AND EXISTS (SELECT 1 FROM filings
              WHERE doc_id = ? AND ingest_status = 'persisted')
            AND ${exactLiveSet}`,
        [
          `decision:auto_published:${docId}`, docId, auditPayload, docId, nowIso,
          docId, docId,
          docId, transactions.length,
          docId, rowKeysJson, transactions.length,
        ],
      ],
    ];
    transitionIndex = 3;
  }

  let results: D1Result[];
  try {
    results = await batch(env.DB, statements);
  } catch (err) {
    if (/UNIQUE constraint failed: (?:review_queue|filings)\.doc_id/i.test((err as Error).message)) {
      throw new Error(`normalized publish exact-set conflict for ${docId}`);
    }
    throw err;
  }
  if ((results[transitionIndex]?.meta?.changes ?? 0) === 0) {
    return { published: false, insertedIds: [] };
  }

  const insertedCount = results[0]?.meta?.changes ?? 0;
  const liveRows = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM transactions
      WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL
        AND row_key IN (SELECT value FROM json_each(?))`,
    [docId, rowKeysJson],
  );
  const insertedIds = liveRows.length > 0
    ? liveRows.map((row) => row.id)
    : insertedCount === transactions.length
      ? transactions.map((tx) => tx.id)
      : [];
  return { published: true, insertedIds };
}

/** Low-level idempotent row + durable-outbox insert for non-publication callers. */
export async function persistTransactions(env: Env, transactions: Transaction[]): Promise<string[]> {
  if (transactions.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING) {
    throw new TransactionPublishLimitError(
      `refusing to publish ${transactions.length} transactions; limit is ${MAX_PUBLISH_TRANSACTIONS_PER_FILING}`,
    );
  }
  if (transactions.length === 0) return [];
  const insertRowsJson = transactionInsertJson(transactions);
  const proposedIdsJson = JSON.stringify(transactions.map((tx) => tx.id));
  const results = await batch(env.DB, [
    [CONDITIONAL_BULK_INSERT_TX_SQL, [insertRowsJson]],
    [BULK_DELIVERY_OUTBOX_SQL, [
      transactions[0].createdAt,
      transactions[0].createdAt,
      transactions[0].createdAt,
      insertRowsJson,
    ]],
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return [];
  const inserted = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))`,
    [proposedIdsJson],
  );
  return inserted.map((row) => row.id);
}

/** Atomically persist review state, metadata, and its idempotent audit receipt. */
async function routeToReview(
  env: Env,
  filing: Filing,
  flagged: FlaggedTx[],
  minConfidence: number,
  nowIso: string,
  meta: {
    extractor: string | null;
    modelVersion: string | null;
    reasonOverride?: string;
  },
  review: ReviewSnapshot | null,
): Promise<boolean> {
  const reason = meta.reasonOverride ?? reviewReason(flagged, minConfidence);
  const truncated = flagged.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING;
  const payload = JSON.stringify({
    minConfidence,
    extractor: meta.extractor,
    modelVersion: meta.modelVersion,
    transactionCount: flagged.length,
    truncated,
    transactions: flagged
      .slice(0, MAX_PUBLISH_TRANSACTIONS_PER_FILING)
      .map((f) => ({ ...f.tx, flags: f.flags })),
  });
  const decisionPayload = JSON.stringify({
    minConfidence,
    extractor: meta.extractor,
    modelVersion: meta.modelVersion,
    transactionCount: flagged.length,
    truncated,
  });

  const nextRevision = review ? review.review_revision + 1 : 1;
  const transition: [string, any[]] = review
    ? [
        `UPDATE review_queue
            SET reason = ?,
                payload = ?,
                agreement_claim_token = NULL,
                agreement_claimed_at = NULL,
                review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 0 AND review_revision = ?`,
        [reason, payload, filing.docId, review.review_revision],
      ]
    : [
        `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
           SELECT ?, ?, ?, ?, 0
            WHERE EXISTS (SELECT 1 FROM filings
              WHERE doc_id = ? AND ingest_status <> 'persisted')`,
        [filing.docId, reason, payload, nowIso, filing.docId],
      ];
  const results = await batch(env.DB, [
    transition,
    [
      `UPDATE filings
          SET confidence = ?, extractor = ?, model_version = ?,
              ingest_status = 'needs_review'
        WHERE doc_id = ? AND EXISTS (
          SELECT 1 FROM review_queue
           WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
        )`,
      [minConfidence, meta.extractor, meta.modelVersion, filing.docId, filing.docId, nextRevision],
    ],
    [
      `INSERT OR IGNORE INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       SELECT ?, ?, 'review_opened', 'pipeline', NULL, ?, ?, '[]', ?
        WHERE EXISTS (SELECT 1 FROM review_queue
          WHERE doc_id = ? AND resolved = 0 AND review_revision = ?)`,
      [
        `decision:review_opened:${filing.docId}`,
        filing.docId,
        reason,
        decisionPayload,
        nowIso,
        filing.docId,
        nextRevision,
      ],
    ],
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

function reviewReason(flagged: FlaggedTx[], minConfidence: number): string {
  const reasons = new Set<string>();
  for (const f of flagged) for (const flag of f.flags) reasons.add(flag);
  if (flagged.length === 0) reasons.add('no_transactions_extracted');
  if (minConfidence < CONFIDENCE_THRESHOLD) reasons.add('low_confidence');
  return Array.from(reasons).join(',') || 'needs_review';
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

function normalizeText(value: string | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
