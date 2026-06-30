/**
 * Durable Stripe webhook event ledger.
 *
 * Claim first, apply side effects once, then mark processed. If processing
 * fails, release the unprocessed claim so Stripe retry can repair state.
 */

import type { Env } from '../shared/types';
import { run } from '../shared/db';

export async function claimStripeWebhookEvent(
  env: Env,
  eventId: string,
  eventType: string,
  receivedAt = new Date().toISOString(),
): Promise<boolean> {
  const res = await run(
    env.DB,
    `INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, received_at)
     VALUES (?, ?, ?)`,
    [eventId, eventType, receivedAt],
  );
  return (res.meta?.changes ?? 1) > 0;
}

export async function markStripeWebhookEventProcessed(
  env: Env,
  eventId: string,
  processedAt = new Date().toISOString(),
): Promise<void> {
  await run(
    env.DB,
    `UPDATE stripe_webhook_events
        SET processed_at = ?
      WHERE event_id = ?`,
    [processedAt, eventId],
  );
}

export async function releaseStripeWebhookEvent(env: Env, eventId: string): Promise<void> {
  await run(env.DB, 'DELETE FROM stripe_webhook_events WHERE event_id = ? AND processed_at IS NULL', [eventId]);
}
