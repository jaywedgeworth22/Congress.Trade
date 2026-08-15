/**
 * src/billing/appleWebhook.ts
 * App Store Server Notifications V2 sink (mounted at /api/webhooks/apple).
 *
 *   POST /api/webhooks/apple  -> { receivedAt } : Apple event sink
 *
 * Apple POSTs `{ signedPayload }` — an ES256 x5c JWS decoding to a
 * `ResponseBodyV2DecodedPayload`. That payload's own `data.signedTransactionInfo`
 * (and, for renewal-status events, `data.signedRenewalInfo`) are THEMSELVES
 * independently signed JWS, each with their own x5c chain — every layer is
 * verified against the pinned Apple root before any field is trusted.
 *
 * Handles the minimal notification set: DID_RENEW, EXPIRED,
 * DID_CHANGE_RENEWAL_STATUS, REVOKE, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED.
 * Idempotent on Apple's `notificationUUID`
 * via the same claim/release/processed ledger pattern the Stripe webhook uses
 * (appleWebhookEvents.ts), so an at-least-once redelivery never double-applies
 * a subscription state change.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { verifyAppleSignedJws, AppleJwsVerificationError } from './appleJws.ts';
import { planFromConfiguredAppleProductId, resolveAppleProductIds, type AppleTransactionPayload } from './apple.ts';
import { getAppleSubscription, upsertAppleSubscription } from './appleSubscriptions.ts';
import {
  claimAppleWebhookEvent,
  markAppleWebhookEventProcessed,
  releaseAppleWebhookEvent,
} from './appleWebhookEvents.ts';

interface AppleRenewalInfoPayload {
  originalTransactionId?: string;
  autoRenewProductId?: string;
  autoRenewStatus?: number; // 0 | 1
  expirationIntent?: number;
  /** Milliseconds since epoch.  Present while Apple is in Billing Grace Period. */
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
}

interface AppleNotificationDataPayload {
  bundleId?: string;
  environment?: string;
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
}

interface AppleServerNotificationV2Payload {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  data?: AppleNotificationDataPayload;
}

const HANDLED_NOTIFICATION_TYPES = new Set([
  'DID_RENEW',
  'EXPIRED',
  'DID_CHANGE_RENEWAL_STATUS',
  'REVOKE',
  'DID_FAIL_TO_RENEW',
  'GRACE_PERIOD_EXPIRED',
]);

export function buildAppleWebhookRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.post('/apple', async (c) => {
    const enabled = (await resolveSecret(c.env, 'APPLE_IAP_ENABLED')).value === 'true';
    if (!enabled) return c.json({ error: 'Apple IAP is not enabled' }, 503);

    let body: { signedPayload?: unknown };
    try {
      body = (await c.req.json()) as { signedPayload?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const signedPayload = typeof body.signedPayload === 'string' ? body.signedPayload : '';
    if (!signedPayload) return c.json({ error: 'signedPayload required' }, 400);

    let notification: AppleServerNotificationV2Payload;
    try {
      notification = await verifyAppleSignedJws<AppleServerNotificationV2Payload>(signedPayload);
    } catch (err) {
      const message = err instanceof AppleJwsVerificationError ? err.message : 'invalid Apple notification';
      console.warn('apple webhook rejected:', message);
      return c.json({ error: message }, 400);
    }

    const notificationUUID = notification.notificationUUID;
    const notificationType = notification.notificationType ?? 'UNKNOWN';
    if (!notificationUUID) return c.json({ error: 'missing notificationUUID' }, 400);

    let claimToken: string | null = null;
    try {
      const claim = await claimAppleWebhookEvent(c.env, notificationUUID, notificationType);
      if (claim.status === 'duplicate') return c.json({ received: true, duplicate: true });
      if (claim.status === 'busy') {
        return c.json({ error: 'notification is already being processed' }, 503, { 'Retry-After': '5' });
      }
      claimToken = claim.claimToken;

      if (HANDLED_NOTIFICATION_TYPES.has(notificationType)) {
        await applyNotification(c.env, notificationType, notification);
      }
      // Unhandled types (SUBSCRIBED, REFUND, PRICE_INCREASE, ...) are
      // acknowledged but not applied yet.  DID_FAIL_TO_RENEW and
      // GRACE_PERIOD_EXPIRED are handled so Billing Grace Period keeps
      // Premium live for the configured window.

      if (!(await markAppleWebhookEventProcessed(c.env, notificationUUID, claimToken))) {
        throw new Error('webhook claim was lost before completion');
      }
    } catch (err) {
      if (claimToken) {
        try {
          await releaseAppleWebhookEvent(c.env, notificationUUID, claimToken);
        } catch (releaseErr) {
          console.error('apple webhook idempotency release failed:', (releaseErr as Error).message);
        }
      }
      console.error('apple webhook handling error:', (err as Error).message);
      return c.json({ error: 'webhook handling failed' }, 500);
    }
    return c.json({ received: true });
  });

  return r;
}

async function applyNotification(
  env: Env,
  notificationType: string,
  notification: AppleServerNotificationV2Payload,
): Promise<void> {
  const signedTransactionInfo = notification.data?.signedTransactionInfo;
  if (!signedTransactionInfo) {
    console.warn(`apple webhook ${notificationType}: missing signedTransactionInfo, skipping`);
    return;
  }
  let transaction: AppleTransactionPayload;
  try {
    transaction = await verifyAppleSignedJws<AppleTransactionPayload>(signedTransactionInfo);
  } catch (err) {
    console.warn(`apple webhook ${notificationType}: invalid signedTransactionInfo:`, (err as Error).message);
    return;
  }

  const expectedBundle = (await resolveSecret(env, 'APPLE_BUNDLE_ID')).value?.trim() || 'trade.congress.ios';
  if (transaction.bundleId && transaction.bundleId !== expectedBundle) {
    console.warn(`apple webhook ${notificationType}: bundleId mismatch, ignoring`);
    return;
  }

  const originalTransactionId = transaction.originalTransactionId || transaction.transactionId;
  if (!originalTransactionId) return;

  // The ledger row's owner is established by redeem_apple_purchase (which
  // knows the signed-in userId); a webhook can only UPDATE an existing row,
  // never attribute a subscription to a user on its own.
  const existing = await getAppleSubscription(env, originalTransactionId);
  if (!existing) {
    console.warn(
      `apple webhook ${notificationType}: no ledger row for originalTransactionId ${originalTransactionId} yet (redeem_apple_purchase has not run) — ignoring`,
    );
    return;
  }

  let renewalInfo: AppleRenewalInfoPayload | null = null;
  if (notification.data?.signedRenewalInfo) {
    try {
      renewalInfo = await verifyAppleSignedJws<AppleRenewalInfoPayload>(notification.data.signedRenewalInfo);
    } catch (err) {
      console.warn(`apple webhook ${notificationType}: invalid signedRenewalInfo:`, (err as Error).message);
    }
  }

  const configuredProducts = await resolveAppleProductIds(env);
  const plan = planFromConfiguredAppleProductId(transaction.productId, configuredProducts) ?? existing.plan;
  const expiresDate =
    transaction.expiresDate != null ? new Date(Number(transaction.expiresDate)).toISOString() : existing.expiresDate;

  const base = {
    originalTransactionId,
    userId: existing.userId,
    productId: transaction.productId ?? existing.productId,
    plan,
    environment: transaction.environment ?? existing.environment,
    latestTransactionId: transaction.transactionId ?? existing.latestTransactionId,
    purchaseDate:
      transaction.purchaseDate != null ? new Date(Number(transaction.purchaseDate)).toISOString() : existing.purchaseDate,
    expiresDate,
    autoRenewStatus:
      renewalInfo?.autoRenewStatus != null ? renewalInfo.autoRenewStatus === 1 : existing.autoRenewStatus,
    autoRenewProductId: renewalInfo?.autoRenewProductId ?? existing.autoRenewProductId,
    lastNotificationType: notificationType,
    lastNotificationSubtype: notification.subtype ?? null,
  };

  if (notificationType === 'DID_RENEW') {
    await upsertAppleSubscription(env, { ...base, status: 'active', revokedAt: null, revocationReason: null });
    return;
  }
  if (notificationType === 'EXPIRED') {
    await upsertAppleSubscription(env, { ...base, status: 'expired' });
    return;
  }
  if (notificationType === 'REVOKE') {
    await upsertAppleSubscription(env, {
      ...base,
      status: 'revoked',
      revokedAt: new Date().toISOString(),
      revocationReason: transaction.revocationReason ?? null,
    });
    return;
  }
  if (notificationType === 'DID_CHANGE_RENEWAL_STATUS') {
    // Entitlement is unaffected by this event alone — only the renewal-info
    // fields change; keep the subscription's current access status as-is.
    await upsertAppleSubscription(env, { ...base, status: existing.status });
    return;
  }
  if (notificationType === 'DID_FAIL_TO_RENEW') {
    const graceMs = renewalInfo?.gracePeriodExpiresDate != null
      ? Number(renewalInfo.gracePeriodExpiresDate)
      : NaN;
    const graceStillOpen = Number.isFinite(graceMs) && graceMs > Date.now();
    const appleSaysGrace = notification.subtype === 'GRACE_PERIOD' || graceStillOpen;
    if (appleSaysGrace) {
      const graceExpires = graceStillOpen
        ? new Date(graceMs).toISOString()
        : existing.expiresDate;
      await upsertAppleSubscription(env, {
        ...base,
        status: 'grace_period',
        expiresDate: graceExpires ?? base.expiresDate,
      });
      return;
    }
    await upsertAppleSubscription(env, {
      ...base,
      status: renewalInfo?.isInBillingRetryPeriod ? 'billing_retry' : 'expired',
    });
    return;
  }
  if (notificationType === 'GRACE_PERIOD_EXPIRED') {
    await upsertAppleSubscription(env, {
      ...base,
      status: renewalInfo?.isInBillingRetryPeriod ? 'billing_retry' : 'expired',
    });
  }
}
