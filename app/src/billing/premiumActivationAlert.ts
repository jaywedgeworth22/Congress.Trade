/**
 * src/billing/premiumActivationAlert.ts
 *
 * Pushover notification to the owner whenever someone becomes Premium for
 * the first time — from either billing path (Stripe checkout or Apple IAP
 * redeem/webhook).  Fires on genuine NEW activations only: callers key each
 * call on a stable `activationKey` (the Stripe subscription id `sub_...`, or
 * `apple:<originalTransactionId>`) and this module claims that key exactly
 * once via `premium_activation_notices` (migration 0093) — a redelivered
 * webhook, or a later renewal/trial-conversion update on the SAME
 * subscription id, reuses the same key and is silently skipped.
 *
 * FAIL-SOFT BY CONTRACT: this is called from the money path (the Stripe
 * webhook handler and the redeem_apple_purchase command), after the
 * subscription write has already committed.  Nothing in here may throw —
 * a Pushover outage, a missing token, a slow response, or a totals-query
 * failure is caught and logged, never surfaced to the caller.  Callers may
 * `await` this directly without their own try/catch.
 */

import type { BillingPlan, Env } from '../shared/types.ts';
import { get, run } from '../shared/db.ts';
import { sendPushover } from '../shared/pushover.ts';

export type PremiumActivationSource = 'stripe' | 'apple';

export interface PremiumActivationInput {
  /** Stable id for this specific subscription — the notification fires at most once per key. */
  activationKey: string;
  userId: string;
  /** Included in the notification so the owner knows who subscribed; never a token/secret. */
  userEmail: string | null;
  source: PremiumActivationSource;
  plan: BillingPlan | string;
  /** True when the activation grants access via a free trial rather than an immediate charge. */
  trialing: boolean;
}

export interface PremiumTotals {
  /** Distinct users currently holding Premium across Stripe + Apple. */
  total: number;
  /** Of `total`, how many are in a free trial (Stripe `trialing`; Apple has no trial concept here). */
  trialing: number;
}

interface PremiumTotalsRow {
  total: number | null;
  trialing: number | null;
}

/**
 * One cheap aggregate query (indexed by migration 0093's
 * idx_users_premium_status / idx_apple_subscriptions_status_expires) — not a
 * per-notification table scan.  DISTINCT guards the rare case a single user
 * holds both an active Stripe subscription and an Apple ledger row.
 */
export async function getPremiumTotals(env: Env, nowIso: string = new Date().toISOString()): Promise<PremiumTotals> {
  const row = await get<PremiumTotalsRow>(
    env.DB,
    `SELECT
       COUNT(DISTINCT id) AS total,
       COUNT(DISTINCT CASE WHEN trialing = 1 THEN id END) AS trialing
     FROM (
       SELECT id, CASE WHEN subscription_status = 'trialing' THEN 1 ELSE 0 END AS trialing
         FROM users
        WHERE plan IN ('monthly', 'annual')
          AND subscription_status IN ('trialing', 'active')
       UNION ALL
       SELECT user_id AS id, 0 AS trialing
         FROM apple_subscriptions
        WHERE status IN ('active', 'grace_period')
          AND (expires_date IS NULL OR expires_date > ?)
     ) combined`,
    [nowIso],
  );
  return { total: row?.total ?? 0, trialing: row?.trialing ?? 0 };
}

/** INSERT OR IGNORE claim: resolves true only the first time this activationKey is seen. */
async function claimActivation(env: Env, activationKey: string, userId: string): Promise<boolean> {
  const result = await run(
    env.DB,
    `INSERT OR IGNORE INTO premium_activation_notices (activation_key, user_id, notified_at) VALUES (?, ?, ?)`,
    [activationKey, userId, new Date().toISOString()],
  );
  return (result.meta?.changes ?? 0) > 0;
}

function planLabel(plan: BillingPlan | string): string {
  return plan === 'annual' ? 'annual' : 'monthly';
}

/**
 * Notify the owner's Pushover of a genuine new Premium activation, exactly
 * once per `input.activationKey`.  See module doc for the fail-soft contract —
 * this function never throws.
 */
export async function notifyPremiumActivation(
  env: Env,
  input: PremiumActivationInput,
  deps: { push?: typeof sendPushover } = {},
): Promise<void> {
  const push = deps.push ?? sendPushover;
  try {
    const isNew = await claimActivation(env, input.activationKey, input.userId);
    if (!isNew) return;

    const totals = await getPremiumTotals(env);
    const sourceLabel = input.source === 'apple' ? 'Apple' : 'Stripe';
    const stateLabel = input.trialing ? 'trial' : 'paid';
    const who = input.userEmail || input.userId;
    // Two spaces between sentences (owner convention — see FLEET-UI-COPY.md).
    const message =
      `${who} subscribed: ${sourceLabel} ${planLabel(input.plan)} (${stateLabel}).  ` +
      `Premium accounts: ${totals.total} total, ${totals.trialing} on trial.`;

    const delivered = await push(env, {
      title: 'New Premium subscriber',
      message,
    });
    if (!delivered.sent) {
      console.warn('premium activation pushover not sent:', delivered.reason ?? 'unknown reason');
    }
  } catch (err) {
    console.error('premium activation notification failed:', (err as Error).message);
  }
}
