/**
 * src/billing/appleSubscriptions.ts
 *
 * D1 helpers for the `apple_subscriptions` ledger (migration 0081) — the
 * source of truth for Apple-purchased Premium, independent of the
 * Stripe-shaped `users` columns. Keyed by Apple's `originalTransactionId`,
 * which stays constant across renewals of the same subscription (StoreKit 2
 * `Transaction.originalID`); upserts here are what make both the
 * `redeem_apple_purchase` command and the App Store Server Notifications
 * webhook idempotent on that id.
 */

import type { ApplePlan } from './apple.ts';
import type { Env } from '../shared/types.ts';
import { get, run } from '../shared/db.ts';

export type AppleSubscriptionStatus = 'active' | 'expired' | 'revoked' | 'grace_period' | 'billing_retry';

export interface AppleSubscriptionRecord {
  originalTransactionId: string;
  userId: string;
  productId: string;
  plan: ApplePlan;
  status: AppleSubscriptionStatus;
  environment: string | null;
  latestTransactionId: string | null;
  purchaseDate: string | null;
  expiresDate: string | null;
  autoRenewStatus: boolean | null;
  autoRenewProductId: string | null;
  revokedAt: string | null;
  revocationReason: number | null;
  lastNotificationType: string | null;
  lastNotificationSubtype: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AppleSubscriptionRow {
  original_transaction_id: string;
  user_id: string;
  product_id: string;
  plan: string;
  status: string;
  environment: string | null;
  latest_transaction_id: string | null;
  purchase_date: string | null;
  expires_date: string | null;
  auto_renew_status: number | null;
  auto_renew_product_id: string | null;
  revoked_at: string | null;
  revocation_reason: number | null;
  last_notification_type: string | null;
  last_notification_subtype: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: AppleSubscriptionRow): AppleSubscriptionRecord {
  return {
    originalTransactionId: r.original_transaction_id,
    userId: r.user_id,
    productId: r.product_id,
    plan: r.plan as ApplePlan,
    status: r.status as AppleSubscriptionStatus,
    environment: r.environment,
    latestTransactionId: r.latest_transaction_id,
    purchaseDate: r.purchase_date,
    expiresDate: r.expires_date,
    autoRenewStatus: r.auto_renew_status == null ? null : r.auto_renew_status === 1,
    autoRenewProductId: r.auto_renew_product_id,
    revokedAt: r.revoked_at,
    revocationReason: r.revocation_reason,
    lastNotificationType: r.last_notification_type,
    lastNotificationSubtype: r.last_notification_subtype,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** True when `status` is a state that currently grants Premium access. */
export function appleStatusGrantsAccess(status: AppleSubscriptionStatus): boolean {
  return status === 'active' || status === 'grace_period';
}

export async function getAppleSubscription(
  env: Env,
  originalTransactionId: string,
): Promise<AppleSubscriptionRecord | null> {
  const row = await get<AppleSubscriptionRow>(
    env.DB,
    'SELECT * FROM apple_subscriptions WHERE original_transaction_id = ?',
    [originalTransactionId],
  );
  return row ? mapRow(row) : null;
}

/**
 * The subscription (if any) that currently grants this user Premium access:
 * status active/grace_period AND not past its expiry. A user may in theory
 * have redeemed more than one Apple subscription over time (e.g. switched
 * plans by cancelling and resubscribing under a new originalTransactionId);
 * the most recently updated qualifying row wins.
 */
export async function activeAppleSubscriptionForUser(
  env: Env,
  userId: string,
  nowIso: string = new Date().toISOString(),
): Promise<AppleSubscriptionRecord | null> {
  const row = await get<AppleSubscriptionRow>(
    env.DB,
    `SELECT * FROM apple_subscriptions
      WHERE user_id = ?
        AND status IN ('active', 'grace_period')
        AND (expires_date IS NULL OR expires_date > ?)
      ORDER BY updated_at DESC
      LIMIT 1`,
    [userId, nowIso],
  );
  return row ? mapRow(row) : null;
}

export interface UpsertAppleSubscriptionInput {
  originalTransactionId: string;
  userId: string;
  productId: string;
  plan: ApplePlan;
  status: AppleSubscriptionStatus;
  environment?: string | null;
  latestTransactionId?: string | null;
  purchaseDate?: string | null;
  expiresDate?: string | null;
  autoRenewStatus?: boolean | null;
  autoRenewProductId?: string | null;
  revokedAt?: string | null;
  revocationReason?: number | null;
  lastNotificationType?: string | null;
  lastNotificationSubtype?: string | null;
}

/**
 * Idempotent upsert keyed on `originalTransactionId`. Reassigning the row to
 * a DIFFERENT userId is refused (returns `{ ok: false, reason: 'owner_mismatch' }`)
 * rather than silently reassigning a subscription's Premium grant to a new
 * account — the only legitimate way a transaction id's owner should ever
 * change is a support-assisted account merge, not an unauthenticated replay.
 */
export async function upsertAppleSubscription(
  env: Env,
  input: UpsertAppleSubscriptionInput,
): Promise<{ ok: true; record: AppleSubscriptionRecord } | { ok: false; reason: 'owner_mismatch'; ownerId: string }> {
  const existing = await getAppleSubscription(env, input.originalTransactionId);
  if (existing && existing.userId !== input.userId) {
    return { ok: false, reason: 'owner_mismatch', ownerId: existing.userId };
  }
  const now = new Date().toISOString();
  await run(
    env.DB,
    `INSERT INTO apple_subscriptions (
       original_transaction_id, user_id, product_id, plan, status, environment,
       latest_transaction_id, purchase_date, expires_date, auto_renew_status,
       auto_renew_product_id, revoked_at, revocation_reason,
       last_notification_type, last_notification_subtype, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(original_transaction_id) DO UPDATE SET
       product_id = excluded.product_id,
       plan = excluded.plan,
       status = excluded.status,
       environment = excluded.environment,
       latest_transaction_id = excluded.latest_transaction_id,
       purchase_date = excluded.purchase_date,
       expires_date = excluded.expires_date,
       auto_renew_status = excluded.auto_renew_status,
       auto_renew_product_id = excluded.auto_renew_product_id,
       revoked_at = excluded.revoked_at,
       revocation_reason = excluded.revocation_reason,
       last_notification_type = COALESCE(excluded.last_notification_type, apple_subscriptions.last_notification_type),
       last_notification_subtype = COALESCE(excluded.last_notification_subtype, apple_subscriptions.last_notification_subtype),
       updated_at = excluded.updated_at`,
    [
      input.originalTransactionId,
      input.userId,
      input.productId,
      input.plan,
      input.status,
      input.environment ?? null,
      input.latestTransactionId ?? null,
      input.purchaseDate ?? null,
      input.expiresDate ?? null,
      input.autoRenewStatus == null ? null : input.autoRenewStatus ? 1 : 0,
      input.autoRenewProductId ?? null,
      input.revokedAt ?? null,
      input.revocationReason ?? null,
      input.lastNotificationType ?? null,
      input.lastNotificationSubtype ?? null,
      existing ? existing.createdAt : now,
      now,
    ],
  );
  const record = await getAppleSubscription(env, input.originalTransactionId);
  if (!record) throw new Error('apple subscription upsert failed');
  return { ok: true, record };
}
