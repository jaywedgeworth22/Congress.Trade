/**
 * Guard for POST /ingest-local-vision after #2107's broad ?worker=local reclaim.
 *
 * Cascade / low-confidence / needs-reprocess review rows already hold a stored
 * extract. Local vision stamps confidence 0.97, so a shorter OCR can publish
 * (or overwrite the payload) and lock the filing — remaining trades never land
 * because drain skips scanned_pdf and pending excludes live txs.
 *
 * Empty / OCR-garbage / likely_garbage parks are the historic reclaim set and
 * may be replaced even when the incoming set is smaller.
 */

const REPLACEABLE_REVIEW_REASON =
  /extract_empty|no_transactions_extracted|ocr_unusable|form_chrome|likely_garbage/i;

export function storedReviewTransactionCount(payloadJson: string | null | undefined): number {
  if (!payloadJson) return 0;
  try {
    const payload = JSON.parse(payloadJson) as {
      transactions?: unknown;
      transactionCount?: unknown;
    };
    const listed = Array.isArray(payload.transactions) ? payload.transactions.length : 0;
    const claimed = typeof payload.transactionCount === 'number' && Number.isFinite(payload.transactionCount)
      ? payload.transactionCount
      : 0;
    return Math.max(listed, claimed);
  } catch {
    return 0;
  }
}

export function storedReviewBlocksSmallerVisionSubmit(
  reason: string | null | undefined,
  payloadJson: string | null | undefined,
  incomingCount: number,
): boolean {
  if (REPLACEABLE_REVIEW_REASON.test(reason ?? '')) return false;
  return storedReviewTransactionCount(payloadJson) > incomingCount;
}
