/**
 * src/extraction/executiveDisposition.ts
 *
 * Close the two executive zero-row outcomes that used to look identical.
 *
 * A 278e whose deterministic read finds no 278-T table and whose other
 * successful reads also found nothing is verified_empty
 * (auto_resolved_empty).  A read the ogeText gate refuses, or a 278-T we
 * could not read, is an unreadable/OCR terminal (resolution_kind rejected,
 * reason ocr_unusable).  Neither outcome may be rewritten to
 * agreement_cascade_unresolved.
 *
 * The known-doc sweep is the one-shot corrective for the two rows already
 * parked that way.  It is bounded to that allowlist and idempotent.
 */

import type { Env } from '../shared/types.ts';
import { batch, get, type SqlParam } from '../shared/db.ts';
import { AGREEMENT_CLAIM_LEASE_MS } from './agreement.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';

export const EXECUTIVE_EMPTY_RESOLUTION_REASON = 'executive_278e_no_transactions';
export const OGE_TEXT_UNREADABLE_RESOLUTION = 'oge_text_unreadable';
/** Health-terminal token.  `ocr_unusable` is already a review-queue terminal class. */
export const OGE_TEXT_UNREADABLE_REASON = 'ocr_unusable,oge_text_unreadable';

export const BONDI_EMPTY_DOC_ID = 'E-undated-pam-bondi-2026-278term';
export const TRUMP_UNREADABLE_DOC_ID = 'E-2026-donald-j-trump-09-8-2026-278t';

const EMPTY_ERROR_CLEARED = EXECUTIVE_EMPTY_RESOLUTION_REASON;
const UNREADABLE_FILING_ERROR =
  'oge_text_unreadable: deterministic extractor refused a garbled or unreadable 278-T text layer';

/**
 * Two kind=agreement vision runs count as the same reading only when their
 * row counts are this close.  33 vs 66 vs 472 (Trump 278-T) is not a
 * successful read of a 1156-row filing.
 */
export const AGREEMENT_VISION_COUNT_AGREE_RATIO = 0.8;

/**
 * True when extraction_runs already holds a successful nonempty read of
 * `doc_id`.  Bind `doc_id` three times: a non-agreement (or null-kind) ok
 * run with rows still blocks; kind=agreement vision blocks only when at
 * least two ok>0 runs exist and every pair has min/max row_count >=
 * AGREEMENT_VISION_COUNT_AGREE_RATIO.  Disputed agreement vision must not
 * block an unreadable or empty close.  A pair is two distinct models
 * (provider or model differs) in the same agreement batch: retries of one
 * model, or runs from different batches, are not independent agreement.
 */
export const SUCCESSFUL_NONEMPTY_READ_SQL = `(
  EXISTS (
    SELECT 1 FROM extraction_runs
     WHERE doc_id = ? AND ok = 1 AND COALESCE(row_count, 0) > 0
       AND COALESCE(kind, '') <> 'agreement'
  )
  OR (
    EXISTS (
      SELECT 1 FROM extraction_runs a
        JOIN extraction_runs b
          ON b.doc_id = a.doc_id AND b.rowid > a.rowid
         AND b.batch_id = a.batch_id
         AND (b.provider <> a.provider OR b.model <> a.model)
       WHERE a.doc_id = ?
         AND a.ok = 1 AND b.ok = 1
         AND COALESCE(a.kind, '') = 'agreement'
         AND COALESCE(b.kind, '') = 'agreement'
         AND COALESCE(a.row_count, 0) > 0
         AND COALESCE(b.row_count, 0) > 0
    )
    AND NOT EXISTS (
      SELECT 1 FROM extraction_runs a
        JOIN extraction_runs b
          ON b.doc_id = a.doc_id AND b.rowid > a.rowid
         AND b.batch_id = a.batch_id
         AND (b.provider <> a.provider OR b.model <> a.model)
       WHERE a.doc_id = ?
         AND a.ok = 1 AND b.ok = 1
         AND COALESCE(a.kind, '') = 'agreement'
         AND COALESCE(b.kind, '') = 'agreement'
         AND COALESCE(a.row_count, 0) > 0
         AND COALESCE(b.row_count, 0) > 0
         AND (MIN(a.row_count, b.row_count) * 1.0 / MAX(a.row_count, b.row_count))
             < ${AGREEMENT_VISION_COUNT_AGREE_RATIO}
    )
  )
)`;

function successfulNonemptyReadParams(docId: string): SqlParam[] {
  return [docId, docId, docId];
}

export interface ExecutiveCloseOptions {
  nowIso?: string;
  /** When set, only the holder of this lease (or an unclaimed row) may close. */
  claimToken?: string | null;
  /** Skip rows a human already suppressed (admin reopen sets agreement_suppressed_at). */
  respectSuppression?: boolean;
  reviewRevision?: number | null;
  /**
   * First-pass normalize() may run before any review_queue row exists.  When
   * set, a missing row is inserted already resolved instead of the UPDATE
   * matching nothing (which would let routeToReview park an unresolved row).
   */
  insertIfAbsent?: boolean;
}

async function hasLiveTransactions(env: Env, docId: string): Promise<boolean> {
  try {
    const row = await get<{ hit: number }>(
      env.DB,
      `SELECT 1 AS hit FROM transactions
        WHERE doc_id = ? AND deprecated_at IS NULL
        LIMIT 1`,
      [docId],
    );
    return Boolean(row);
  } catch {
    // Fail closed: do not close a filing we cannot prove is empty of rows.
    return true;
  }
}

/**
 * True when some earlier successful read already found transactions.  A
 * bare zero from the deterministic parser is not enough to call the filing
 * empty in that case.  Disputed kind=agreement vision is not a successful
 * read.
 */
export async function otherSuccessfulReadHasRows(env: Env, docId: string): Promise<boolean> {
  try {
    const row = await get<{ hit: number }>(
      env.DB,
      `SELECT 1 AS hit WHERE ${SUCCESSFUL_NONEMPTY_READ_SQL}`,
      successfulNonemptyReadParams(docId),
    );
    return Boolean(row);
  } catch {
    return true;
  }
}

function reviewWhere(opts: ExecutiveCloseOptions): { sql: string; params: SqlParam[] } {
  const respect = opts.respectSuppression ? 1 : 0;
  const revision = opts.reviewRevision ?? null;
  // A supplied claim token must match EXACTLY: a worker whose lease a
  // concurrent normalize() had just cleared must not close the row.
  const token = opts.claimToken ?? null;
  const base = `doc_id = ?
    AND resolved = 0
    AND (? = 0 OR agreement_suppressed_at IS NULL)
    AND (? IS NULL OR review_revision = ?)`;
  if (token) {
    return {
      sql: `${base}
      AND agreement_claim_token = ?`,
      params: [respect, revision, revision, token],
    };
  }
  // Tokenless callers (normalize(), the sweep) must not close over a live
  // agreement lease: acquiring a lease does not bump review_revision, so the
  // revision guard cannot see it. Close only when no lease is held or the
  // held lease has expired.
  const expiredBefore = new Date(
    Date.parse(opts.nowIso ?? new Date().toISOString()) - AGREEMENT_CLAIM_LEASE_MS,
  ).toISOString();
  return {
    sql: `${base}
      AND (
        agreement_claim_token IS NULL OR agreement_claimed_at IS NULL
        OR agreement_claimed_at <= ?
      )`,
    params: [respect, revision, revision, expiredBefore],
  };
}

async function writeClose(
  env: Env,
  docId: string,
  opts: ExecutiveCloseOptions,
  review: {
    reason: string;
    resolutionKind: 'verified_empty' | 'rejected';
    resolutionReason: string;
  },
  filing: { ingestStatus: string; error: string | null },
  decision: { action: 'auto_resolved_empty' | 'rejected'; reason: string },
): Promise<boolean> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const where = reviewWhere(opts);
  const insertStatements: Array<[string, SqlParam[]]> = opts.insertIfAbsent
    ? [[
        `INSERT OR IGNORE INTO review_queue (
            doc_id, reason, payload, created_at, resolved,
            resolution_kind, resolution_reason, resolved_at
          ) SELECT ?, ?, '{}', ?, 1, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
               AND EXISTS (
                 SELECT 1 FROM filings WHERE doc_id = ? AND ingest_status <> 'persisted'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL
               )
               -- Same atomic guard as the UPDATE close below: a successful
               -- nonempty read persisted between the outer guard and this
               -- batch must not be closed over on a first pass either.
               -- Disputed kind=agreement vision is not a successful read.
               AND NOT ${SUCCESSFUL_NONEMPTY_READ_SQL}`,
        [
          docId,
          review.reason,
          nowIso,
          review.resolutionKind,
          review.resolutionReason,
          nowIso,
          docId,
          docId,
          docId,
          ...successfulNonemptyReadParams(docId),
        ],
      ]]
    : [];
  const results = await batch(env.DB, [
    ...insertStatements,
    [
      `UPDATE review_queue
          SET resolved = 1,
              reason = ?,
              agreement_claim_token = NULL,
              agreement_claimed_at = NULL,
              agreement_next_attempt_at = NULL,
              resolution_kind = ?,
              resolution_reason = ?,
              resolved_at = ?,
              review_revision = review_revision + 1
        WHERE ${where.sql}
          -- Repeat the emptiness guards INSIDE the close: the outer
          -- hasLiveTransactions / otherSuccessfulReadHasRows checks run
          -- before the batch, so a live row or a nonempty extraction_run
          -- persisted in between would otherwise be closed over without
          -- even a review_revision bump.
          AND NOT EXISTS (
            SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL
          )
          AND NOT ${SUCCESSFUL_NONEMPTY_READ_SQL}
          -- routeToReview stages low-confidence candidates only in
          -- payload.transactions: no live transaction and no successful
          -- nonempty extraction_runs row, so both table guards pass while
          -- the review holds real candidates. Staged candidates are row
          -- evidence too. Disputed kind=agreement vision is not a successful
          -- read.
          AND NOT (COALESCE(json_extract(payload, '$.transactionCount'), 0) > 0)`,
      [
        review.reason,
        review.resolutionKind,
        review.resolutionReason,
        nowIso,
        docId,
        ...where.params,
        docId,
        ...successfulNonemptyReadParams(docId),
      ],
    ],
    [
      `UPDATE filings
          SET ingest_status = ?,
              error = ?
        WHERE doc_id = ?
          AND ingest_status <> 'persisted'
          AND NOT EXISTS (
            SELECT 1 FROM transactions
             WHERE doc_id = ? AND deprecated_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM review_queue
             WHERE doc_id = ? AND resolved = 1 AND resolution_kind = ?
               AND resolution_reason = ?
          )`,
      [
        filing.ingestStatus,
        filing.error,
        docId,
        docId,
        docId,
        review.resolutionKind,
        review.resolutionReason,
      ],
    ],
  ]);
  // Inserted-resolved or updated-to-resolved; the filings UPDATE is last.
  const closed = results
    .slice(0, insertStatements.length + 1)
    .some((result) => (result?.meta?.changes ?? 0) > 0);
  if (!closed) return false;
  await recordIngestionDecision(env.DB, {
    docId,
    action: decision.action,
    source: 'pipeline',
    reason: decision.reason,
    payload: {
      resolvedBy: 'executive-disposition',
      resolutionKind: review.resolutionKind,
    },
  });
  return true;
}

/** 278e with no transactions and no contradictory successful read. */
export async function closeVerifiedEmptyExecutive(
  env: Env,
  docId: string,
  opts: ExecutiveCloseOptions = {},
): Promise<boolean> {
  if (await hasLiveTransactions(env, docId)) return false;
  if (await otherSuccessfulReadHasRows(env, docId)) return false;
  return writeClose(
    env,
    docId,
    opts,
    {
      reason: EXECUTIVE_EMPTY_RESOLUTION_REASON,
      resolutionKind: 'verified_empty',
      resolutionReason: EXECUTIVE_EMPTY_RESOLUTION_REASON,
    },
    { ingestStatus: 'verified_empty', error: null },
    { action: 'auto_resolved_empty', reason: EMPTY_ERROR_CLEARED },
  );
}

/** Garbled / refused deterministic read.  Not an empty filing. */
export async function closeUnreadableExecutive(
  env: Env,
  docId: string,
  opts: ExecutiveCloseOptions = {},
): Promise<boolean> {
  if (await hasLiveTransactions(env, docId)) return false;
  // A later refused read must not reject a filing an earlier successful read
  // already found rows for - same guard the verified_empty close applies.
  if (await otherSuccessfulReadHasRows(env, docId)) return false;
  return writeClose(
    env,
    docId,
    opts,
    {
      reason: OGE_TEXT_UNREADABLE_REASON,
      resolutionKind: 'rejected',
      resolutionReason: OGE_TEXT_UNREADABLE_RESOLUTION,
    },
    { ingestStatus: 'error', error: UNREADABLE_FILING_ERROR },
    { action: 'rejected', reason: OGE_TEXT_UNREADABLE_RESOLUTION },
  );
}

export interface ExecutiveTerminalSweepResult {
  verifiedEmpty: number;
  unreadable: number;
}

/**
 * Correct the two parked rows.  Bondi is an empty 278e.  Trump is an
 * unreadable 278-T.  A second run matches nothing.  A row an administrator
 * reopened (agreement_suppressed_at set) is left for human review; the sweep
 * must not undo a reopen on its next hourly run.
 */
export async function sweepKnownParkedExecutiveTerminals(
  env: Env,
  now = new Date(),
): Promise<ExecutiveTerminalSweepResult> {
  const nowIso = now.toISOString();
  const targets: Array<{ docId: string; kind: 'empty' | 'unreadable' }> = [
    { docId: BONDI_EMPTY_DOC_ID, kind: 'empty' },
    { docId: TRUMP_UNREADABLE_DOC_ID, kind: 'unreadable' },
  ];
  let verifiedEmpty = 0;
  let unreadable = 0;
  for (const target of targets) {
    // Bind the close to the revision this SELECT observed: a normalize()
    // revision landing between the two would otherwise be closed over.  Only
    // correct a row still carrying the legacy parked reason: an operator
    // retry-auto rewrites it to auto_retry_requested and clears suppression,
    // and this sweep must not re-apply the hard-coded close without
    // re-reading the PDF.
    const open = await get<{ doc_id: string; review_revision: number }>(
      env.DB,
      `SELECT doc_id, review_revision FROM review_queue
        WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
          AND (reason LIKE 'extract_empty_failure%' OR reason LIKE 'agreement_cascade_unresolved%')
        LIMIT 1`,
      [target.docId],
    ).catch(() => null);
    if (!open) continue;
    const closed = target.kind === 'empty'
      ? await closeVerifiedEmptyExecutive(env, target.docId, {
          nowIso,
          respectSuppression: true,
          reviewRevision: open.review_revision,
        })
      : await closeUnreadableExecutive(env, target.docId, {
          nowIso,
          respectSuppression: true,
          reviewRevision: open.review_revision,
        });
    if (!closed) continue;
    if (target.kind === 'empty') verifiedEmpty += 1;
    else unreadable += 1;
  }
  if (verifiedEmpty || unreadable) {
    console.log(
      `executiveDisposition sweep: verified_empty=${verifiedEmpty} unreadable=${unreadable}`,
    );
  }
  return { verifiedEmpty, unreadable };
}

/** Docs the sweep is allowed to touch.  Tests and callers share this list. */
export function knownParkedExecutiveDocIds(): string[] {
  return [BONDI_EMPTY_DOC_ID, TRUMP_UNREADABLE_DOC_ID];
}
