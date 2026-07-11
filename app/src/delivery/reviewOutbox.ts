import type { Env } from '../shared/types';
import { all, run } from '../shared/db';

interface PendingReviewDelivery {
  tx_id: string;
  doc_id: string;
  transaction_id: string | null;
  deprecated_at: string | null;
}

export interface ReviewOutboxDrainResult {
  selected: number;
  dispatched: number;
  failed: number;
  abandoned: number;
}

/**
 * Drain durable delivery intents created by human/agreement review resolution.
 * A send that succeeds before its D1 acknowledgement may be repeated, which is
 * safe because webhook delivery is already idempotent on subscription+tx.
 */
export async function drainReviewDeliveryOutbox(
  env: Env,
  limit = 25,
): Promise<ReviewOutboxDrainResult> {
  // Keep select + one D1 acknowledgement per send below the Free-plan
  // 50-query invocation ceiling, with room for the caller's own work.
  const bounded = Math.min(Math.max(Math.floor(limit) || 25, 1), 40);
  const rows = await all<PendingReviewDelivery>(
    env.DB,
    `SELECT o.tx_id, o.doc_id, t.id AS transaction_id, t.deprecated_at
       FROM review_delivery_outbox o
       LEFT JOIN transactions t ON t.id = o.tx_id
      WHERE o.dispatched_at IS NULL
      ORDER BY o.created_at ASC
      LIMIT ?`,
    [bounded],
  );
  let dispatched = 0;
  let failed = 0;
  let abandoned = 0;
  for (const row of rows) {
    const nowIso = new Date().toISOString();
    if (row.transaction_id === null || row.deprecated_at != null) {
      await run(
        env.DB,
        `UPDATE review_delivery_outbox
            SET dispatched_at = ?, attempts = attempts + 1,
                last_attempt_at = ?, last_error = ?
          WHERE tx_id = ? AND dispatched_at IS NULL`,
        [
          nowIso,
          nowIso,
          row.transaction_id === null ? 'transaction missing before dispatch' : 'transaction deprecated before dispatch',
          row.tx_id,
        ],
      );
      abandoned += 1;
      continue;
    }
    try {
      await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId: row.tx_id });
      await run(
        env.DB,
        `UPDATE review_delivery_outbox
            SET dispatched_at = ?, attempts = attempts + 1,
                last_attempt_at = ?, last_error = NULL
          WHERE tx_id = ? AND dispatched_at IS NULL`,
        [nowIso, nowIso, row.tx_id],
      );
      dispatched += 1;
    } catch (err) {
      await run(
        env.DB,
        `UPDATE review_delivery_outbox
            SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
          WHERE tx_id = ? AND dispatched_at IS NULL`,
        [nowIso, (err as Error).message.slice(0, 1000), row.tx_id],
      ).catch(() => {});
      failed += 1;
    }
  }
  return { selected: rows.length, dispatched, failed, abandoned };
}
