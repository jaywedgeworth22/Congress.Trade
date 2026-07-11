/**
 * Durable Stripe webhook event ledger.
 *
 * Claim first, apply side effects once, then mark processed. If processing
 * fails, release the unprocessed claim so Stripe retry can repair state.
 */

import type { Env } from '../shared/types';
import { get, run } from '../shared/db';

const DEFAULT_CLAIM_LEASE_SECONDS = 60;

export type StripeWebhookClaimResult =
  | { status: 'claimed'; claimToken: string }
  | { status: 'duplicate' }
  | { status: 'busy' };

export interface StripeWebhookClaimOptions {
  now?: Date;
  leaseSeconds?: number;
  claimToken?: string;
}

interface StripeWebhookEventRow {
  processed_at: string | null;
}

export async function claimStripeWebhookEvent(
  env: Env,
  eventId: string,
  eventType: string,
  options: StripeWebhookClaimOptions = {},
): Promise<StripeWebhookClaimResult> {
  const now = options.now ?? new Date();
  const leaseSeconds = Math.max(1, Math.floor(options.leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS));
  const claimToken = options.claimToken ?? crypto.randomUUID();
  const receivedAt = now.toISOString();
  const claimExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const inserted = await run(
    env.DB,
    `INSERT OR IGNORE INTO stripe_webhook_events (
       event_id, event_type, received_at, claim_token, claim_expires_at
     ) VALUES (?, ?, ?, ?, ?)`,
    [eventId, eventType, receivedAt, claimToken, claimExpiresAt],
  );
  if ((inserted.meta?.changes ?? 0) > 0) return { status: 'claimed', claimToken };

  const reclaimed = await run(
    env.DB,
    `UPDATE stripe_webhook_events
        SET event_type = ?, claim_token = ?, claim_expires_at = ?
      WHERE event_id = ?
        AND processed_at IS NULL
        AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
    [eventType, claimToken, claimExpiresAt, eventId, receivedAt],
  );
  if ((reclaimed.meta?.changes ?? 0) > 0) return { status: 'claimed', claimToken };

  const existing = await get<StripeWebhookEventRow>(
    env.DB,
    'SELECT processed_at FROM stripe_webhook_events WHERE event_id = ?',
    [eventId],
  );
  return existing?.processed_at ? { status: 'duplicate' } : { status: 'busy' };
}

export async function markStripeWebhookEventProcessed(
  env: Env,
  eventId: string,
  claimToken: string,
  processedAt = new Date().toISOString(),
): Promise<boolean> {
  const res = await run(
    env.DB,
    `UPDATE stripe_webhook_events
        SET processed_at = ?, claim_token = NULL, claim_expires_at = NULL
      WHERE event_id = ? AND claim_token = ? AND processed_at IS NULL`,
    [processedAt, eventId, claimToken],
  );
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseStripeWebhookEvent(
  env: Env,
  eventId: string,
  claimToken: string,
): Promise<boolean> {
  const res = await run(
    env.DB,
    `UPDATE stripe_webhook_events
        SET claim_token = NULL, claim_expires_at = NULL
      WHERE event_id = ? AND claim_token = ? AND processed_at IS NULL`,
    [eventId, claimToken],
  );
  return (res.meta?.changes ?? 0) > 0;
}
