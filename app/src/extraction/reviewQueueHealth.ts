/**
 * Review-queue health buckets (owner 2026-08-17).
 *
 * Health used to count only the autopilot-eligible slice
 * (`countEligibleBacklog`), so 210 suppressed / parked rows could sit
 * unresolved while the check said "9 items, ok".  Jay's ruling: count
 * EVERY unresolved human-review row, split eligible vs suppressed vs
 * terminal, and mark any unresolved queue unhealthy.
 *
 * Buckets are disjoint:
 *   eligible  — unresolved, not suppressed, not a parked/rejected class
 *   suppressed — unresolved + agreement_suppressed_at, not terminal-class
 *   terminal  — unresolved rejected:/exhausted/parked classes (need a human)
 */

import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';

export type ReviewQueueBucket = 'eligible' | 'suppressed' | 'terminal';

export interface ReviewQueueHealthCounts {
  unresolved: number;
  eligible: number;
  suppressed: number;
  terminal: number;
}

const TERMINAL_REASON_RE =
  /^(rejected:)|local_vision_exhausted|extraction_row_limit|ocr_unusable|scanned_pdf_vision_spend|form_chrome_only/i;

/** SQL fragment: row is NOT a parked/rejected terminal class. */
export const TERMINAL_REVIEW_REASON_EXCLUDE_SQL = `
  COALESCE(rq.reason, '') NOT LIKE 'rejected:%'
  AND COALESCE(rq.reason, '') NOT LIKE '%local_vision_exhausted%'
  AND COALESCE(rq.reason, '') NOT LIKE '%extraction_row_limit%'
  AND COALESCE(rq.reason, '') NOT LIKE '%ocr_unusable%'
  AND COALESCE(rq.reason, '') NOT LIKE '%scanned_pdf_vision_spend%'
  AND COALESCE(rq.reason, '') NOT LIKE '%form_chrome_only%'
`.trim();

export function isTerminalReviewReason(reason: string | null | undefined): boolean {
  return TERMINAL_REASON_RE.test((reason ?? '').trim());
}

export function classifyUnresolvedReviewItem(row: {
  suppressed: boolean;
  reason: string | null | undefined;
}): ReviewQueueBucket {
  if (isTerminalReviewReason(row.reason)) return 'terminal';
  if (row.suppressed) return 'suppressed';
  return 'eligible';
}

export async function countReviewQueueBuckets(
  env: Env,
): Promise<ReviewQueueHealthCounts | null> {
  try {
    const row = await get<{
      unresolved: number;
      eligible: number;
      suppressed: number;
      terminal: number;
    }>(
      env.DB,
      `SELECT
          COUNT(*) AS unresolved,
          SUM(CASE
            WHEN rq.agreement_suppressed_at IS NULL
             AND ${TERMINAL_REVIEW_REASON_EXCLUDE_SQL}
            THEN 1 ELSE 0 END) AS eligible,
          SUM(CASE
            WHEN rq.agreement_suppressed_at IS NOT NULL
             AND ${TERMINAL_REVIEW_REASON_EXCLUDE_SQL}
            THEN 1 ELSE 0 END) AS suppressed,
          SUM(CASE
            WHEN COALESCE(rq.reason, '') LIKE 'rejected:%'
              OR COALESCE(rq.reason, '') LIKE '%local_vision_exhausted%'
              OR COALESCE(rq.reason, '') LIKE '%extraction_row_limit%'
              OR COALESCE(rq.reason, '') LIKE '%ocr_unusable%'
              OR COALESCE(rq.reason, '') LIKE '%scanned_pdf_vision_spend%'
              OR COALESCE(rq.reason, '') LIKE '%form_chrome_only%'
            THEN 1 ELSE 0 END) AS terminal
         FROM review_queue rq
        WHERE COALESCE(rq.resolved, 0) = 0`,
    );
    if (!row) {
      return { unresolved: 0, eligible: 0, suppressed: 0, terminal: 0 };
    }
    return {
      unresolved: Number(row.unresolved ?? 0),
      eligible: Number(row.eligible ?? 0),
      suppressed: Number(row.suppressed ?? 0),
      terminal: Number(row.terminal ?? 0),
    };
  } catch {
    return null;
  }
}

export function formatReviewQueueHealthDetail(counts: ReviewQueueHealthCounts): string {
  return (
    `${counts.unresolved} unresolved human-review item(s) `
    + `(eligible ${counts.eligible}, suppressed ${counts.suppressed}, terminal ${counts.terminal})`
  );
}
