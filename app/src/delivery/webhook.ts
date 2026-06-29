/**
 * src/delivery/webhook.ts
 * OWNER: delivery agent
 *
 * Handles {type:'delivery.dispatch'} for webhook subscriptions: loads matching
 * subscriptions, builds the payload, signs it with WEBHOOK_SIGNING_KEY (and/or
 * the per-subscription secret), POSTs to target_url, and records the attempt in
 * deliveries with retry/backoff semantics.
 *
 * RETRY STRATEGY (queue re-enqueue):
 *   A Worker invocation is short-lived, so we do NOT block-and-sleep across
 *   multiple HTTP attempts inside one invocation. Instead each failed POST is
 *   retried by re-enqueueing a `delivery.dispatch` message carrying an `attempt`
 *   counter and a `subscriptionId` (so the retry only re-targets the failed
 *   subscription, not the whole fan-out). Cloudflare Queues' `delaySeconds`
 *   gives us exponential backoff + jitter without holding the invocation open.
 *
 *   The base QueueMessage union (shared/types.ts, frozen) only declares
 *   `{type:'delivery.dispatch'; txId}`. We extend it at the wire level with two
 *   OPTIONAL fields (`attempt`, `subscriptionId`); index.ts preserves the whole
 *   message object so the retry can target one subscription and increment the
 *   attempt counter. This keeps the contract additive.
 *
 * IDEMPOTENCY:
 *   deliveries is keyed (subscription_id, tx_id). We claim a pending row before
 *   POSTing and skip already delivered/pending attempts, so retries / duplicate
 *   queue messages do not concurrently double-deliver. Recipients should still
 *   dedupe on X-Subscription-Id + X-Tx-Id because no HTTP webhook sender can be
 *   exactly-once if it crashes after POST but before recording success.
 */

import type { Env, Subscription, Transaction } from '../shared/types';
import { all, get, run } from '../shared/db';
import { prefixedId } from '../shared/ids';
import { mapSubscription, mapTransaction, type SubscriptionRow, type TransactionRow } from './rows';
import { matchesFiltersWithContext } from './subscriptions';
import { resolveSecret } from '../secrets/infisical';

/** Max delivery attempts before we give up (initial try + retries). */
const MAX_ATTEMPTS = 5;
/** Base backoff in seconds; doubled per attempt, then jittered. */
const BASE_BACKOFF_SEC = 5;
/** Cap a single backoff delay (Cloudflare Queues allow up to 12h; keep modest). */
const MAX_BACKOFF_SEC = 900;

/**
 * Wire shape of the delivery message. Extends the frozen union additively with
 * optional retry-routing fields.
 */
interface DispatchMessage {
  type: 'delivery.dispatch';
  txId: string;
  /** 1-based attempt counter for this (subscription, tx) pair. */
  attempt?: number;
  /** When set, only (re)deliver to this subscription (retry path). */
  subscriptionId?: string;
}

/**
 * Compute the HMAC-SHA256 signature (lowercase hex) for an outbound webhook
 * body, keyed by the per-subscription secret if given, else the worker-wide
 * WEBHOOK_SIGNING_KEY. Uses WebCrypto (Workers-compatible).
 */
export async function signWebhookPayload(env: Env, body: string, secret?: string): Promise<string> {
  const keyMaterial = secret ?? (await resolveSecret(env, 'WEBHOOK_SIGNING_KEY')).value ?? '';
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(body));
  return toHex(new Uint8Array(sigBuf));
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Exponential backoff with full jitter, capped. attempt is 1-based. */
function backoffSeconds(attempt: number): number {
  const expo = BASE_BACKOFF_SEC * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(expo, MAX_BACKOFF_SEC);
  // Full jitter: random in [0, capped]. Keep a small floor so we always wait.
  return Math.max(1, Math.floor(Math.random() * capped));
}

/**
 * Dispatch a persisted transaction to all matching active webhook subscriptions.
 * When called with a retry message (subscriptionId set), only that subscription
 * is (re)attempted.
 *
 * The normal queue path may pass only the transaction id. Retry messages pass
 * the whole body so the optional subscriptionId and attempt fields are preserved.
 */
export async function dispatchWebhook(
  env: Env,
  txIdOrMsg: string | DispatchMessage,
): Promise<void> {
  const msg: DispatchMessage =
    typeof txIdOrMsg === 'string' ? { type: 'delivery.dispatch', txId: txIdOrMsg } : txIdOrMsg;

  const txRow = await get<TransactionRow>(
    env.DB,
    'SELECT * FROM transactions WHERE id = ?',
    [msg.txId],
  );
  if (!txRow) {
    console.warn('dispatchWebhook: transaction not found', msg.txId);
    return;
  }
  // Don't push a retracted (un-published) row, e.g. on a retry after unpublish.
  if ((txRow as { deprecated_at?: string | null }).deprecated_at) return;
  const tx = mapTransaction(txRow);

  // Resolve chamber via the owning filing (Transaction carries no chamber col).
  const chamberRow = await get<{ chamber: string | null }>(
    env.DB,
    'SELECT chamber FROM filings WHERE doc_id = ?',
    [tx.docId],
  );
  const chamber = chamberRow?.chamber ?? null;

  // Resolve sector + market-cap bucket for sector/cap subscription filters.
  const refRow = tx.ticker
    ? await get<{ sector: string | null; market_cap_bucket: string | null }>(
        env.DB,
        'SELECT sector, market_cap_bucket FROM securities_ref WHERE ticker = ?',
        [tx.ticker],
      )
    : null;
  const ctx = {
    chamber,
    sector: refRow?.sector ?? null,
    marketCapBucket: refRow?.market_cap_bucket ?? null,
  };

  // Target set: a single subscription on the retry path, else all active webhooks.
  let subs: Subscription[];
  if (msg.subscriptionId) {
    const subRow = await get<SubscriptionRow>(
      env.DB,
      'SELECT id, client_id, delivery, target_url, secret, filters, cursor, active, created_at FROM subscriptions WHERE id = ?',
      [msg.subscriptionId],
    );
    subs = subRow ? [mapSubscription(subRow)] : [];
  } else {
    const subRows = await all<SubscriptionRow>(
      env.DB,
      "SELECT id, client_id, delivery, target_url, secret, filters, cursor, active, created_at FROM subscriptions WHERE active = 1 AND delivery = 'webhook'",
    );
    subs = subRows.map(mapSubscription);
  }

  const attempt = msg.attempt ?? 1;

  for (const sub of subs) {
    if (!sub.targetUrl) continue;
    if (!matchesFiltersWithContext(tx, sub.filters, ctx)) continue;
    await deliverToSubscription(env, sub, tx, attempt);
  }
}

/**
 * Deliver one transaction to one subscription, recording the attempt and
 * scheduling a backoff retry on failure (up to MAX_ATTEMPTS).
 */
async function deliverToSubscription(
  env: Env,
  sub: Subscription,
  tx: Transaction,
  attempt: number,
): Promise<void> {
  const claim = await claimDelivery(env, sub.id, tx.id, attempt);
  if (!claim) return;

  const deliveredAt = new Date().toISOString();
  const payload = {
    event: 'trade.new' as const,
    transaction: tx,
    deliveredAt,
  };
  const body = JSON.stringify(payload);
  const signature = await signWebhookPayload(env, body, sub.secret ?? undefined);

  let ok = false;
  let lastError: string | null = null;
  try {
    const res = await fetch(sub.targetUrl as string, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': `sha256=${signature}`,
        'X-Tx-Id': tx.id,
        'X-Subscription-Id': sub.id,
        'X-Delivery-Attempt': String(attempt),
      },
      body,
    });
    ok = res.ok; // 2xx
    if (!ok) lastError = `HTTP ${res.status}`;
  } catch (err) {
    ok = false;
    lastError = (err as Error).message ?? 'fetch failed';
  }

  await recordDelivery(env, claim.id, ok, attempt, lastError);

  if (ok) {
    // Advance the subscription cursor to the high-water mark we just delivered.
    await run(
      env.DB,
      'UPDATE subscriptions SET cursor = ? WHERE id = ? AND cursor < ?',
      [tx.cursorSeq, sub.id, tx.cursorSeq],
    );
    return;
  }

  // Failure: schedule a backoff retry targeting only this subscription.
  if (attempt < MAX_ATTEMPTS) {
    const delaySeconds = backoffSeconds(attempt);
    const retryMsg: DispatchMessage = {
      type: 'delivery.dispatch',
      txId: tx.id,
      subscriptionId: sub.id,
      attempt: attempt + 1,
    };
    try {
      await env.DELIVERY_QUEUE.send(retryMsg, { delaySeconds });
    } catch (err) {
      console.error('dispatchWebhook: failed to enqueue retry', (err as Error).message);
    }
  } else {
    console.warn(
      `dispatchWebhook: giving up on sub=${sub.id} tx=${tx.id} after ${attempt} attempts: ${lastError}`,
    );
  }
}

interface DeliveryClaim {
  id: string;
}

/**
 * Claim the single deliveries row for this subscription/transaction before
 * sending the webhook. Returns null when another worker already delivered or is
 * already processing the same/later attempt.
 */
async function claimDelivery(
  env: Env,
  subscriptionId: string,
  txId: string,
  attempt: number,
): Promise<DeliveryClaim | null> {
  const existing = await get<{ status: string; attempts: number; id: string }>(
    env.DB,
    'SELECT id, status, attempts FROM deliveries WHERE subscription_id = ? AND tx_id = ?',
    [subscriptionId, txId],
  );
  if (existing?.status === 'delivered') return null;
  if (existing?.status === 'pending' && existing.attempts >= attempt) return null;

  const updatedAt = new Date().toISOString();
  if (existing) {
    const res = await run(
      env.DB,
      `UPDATE deliveries
          SET status = 'pending', attempts = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status != 'delivered'`,
      [attempt, updatedAt, existing.id],
    );
    if ((res.meta?.changes ?? 1) === 0) return null;
    return { id: existing.id };
  }

  const id = prefixedId('dlv');
  try {
    await run(
      env.DB,
      `INSERT INTO deliveries (id, subscription_id, tx_id, status, attempts, last_error, updated_at)
         VALUES (?, ?, ?, 'pending', ?, NULL, ?)`,
      [id, subscriptionId, txId, attempt, updatedAt],
    );
    return { id };
  } catch (err) {
    if (!/unique|constraint/i.test((err as Error).message)) throw err;
    return null;
  }
}

/** Update the claimed deliveries row with the final result for this attempt. */
async function recordDelivery(
  env: Env,
  deliveryId: string,
  ok: boolean,
  attempt: number,
  lastError: string | null,
): Promise<void> {
  const status = ok ? 'delivered' : 'failed';
  const updatedAt = new Date().toISOString();
  await run(
    env.DB,
    'UPDATE deliveries SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?',
    [status, attempt, ok ? null : lastError, updatedAt, deliveryId],
  );
}
