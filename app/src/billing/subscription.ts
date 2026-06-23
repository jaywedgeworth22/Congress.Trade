/**
 * src/billing/subscription.ts
 * Persistence for Stripe billing state on the `users` table, plus a parser that
 * normalizes a raw Stripe Subscription object into the fields we store. Kept
 * separate from the HTTP layer (routes.ts) and the API client (stripe.ts) so the
 * mapping is unit-testable against an in-memory DB.
 */

import type { BillingPlan, Env, User } from '../shared/types';
import { get, run } from '../shared/db';
import { getUserById } from '../auth/users';

/** Map a Stripe Price id to our plan cadence, or null if it isn't ours. */
export function planForPrice(env: Env, priceId: string | null | undefined): BillingPlan | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_MONTHLY) return 'monthly';
  if (priceId === env.STRIPE_PRICE_ANNUAL) return 'annual';
  return null;
}

/** The subset of a Stripe Subscription object we persist. */
export interface ParsedSubscription {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  /** `subscription_data.metadata.userId` set at checkout, if present. */
  metadataUserId: string | null;
}

interface RawStripeSubscription {
  id?: string;
  status?: string;
  customer?: string | { id?: string };
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  trial_end?: number | null;
  items?: { data?: Array<{ price?: { id?: string }; current_period_end?: number | null }> };
  metadata?: { userId?: string };
}

function isoFromUnix(sec: number | null | undefined): string | null {
  return typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

/** Normalize a raw Stripe Subscription (from a webhook event) into our shape. */
export function parseSubscription(raw: RawStripeSubscription): ParsedSubscription | null {
  const id = raw.id;
  const customerId = typeof raw.customer === 'string' ? raw.customer : raw.customer?.id;
  if (!id || !customerId || !raw.status) return null;
  return {
    id,
    customerId,
    status: raw.status,
    priceId: raw.items?.data?.[0]?.price?.id ?? null,
    // API >=2025-03-31.basil moved current_period_end onto the subscription item.
    currentPeriodEnd: isoFromUnix(raw.items?.data?.[0]?.current_period_end ?? raw.current_period_end),
    cancelAtPeriodEnd: !!raw.cancel_at_period_end,
    trialEnd: isoFromUnix(raw.trial_end),
    metadataUserId: raw.metadata?.userId ?? null,
  };
}

interface UserIdRow {
  id: string;
}

/** Look up a user by their Stripe customer id (webhook resolution). */
export async function getUserByStripeCustomerId(env: Env, customerId: string): Promise<User | null> {
  const row = await get<UserIdRow>(env.DB, 'SELECT id FROM users WHERE stripe_customer_id = ?', [
    customerId,
  ]);
  return row ? getUserById(env, row.id) : null;
}

/** Persist the customer<->user link (idempotent; only sets when changed). */
export async function linkCustomerToUser(
  env: Env,
  userId: string,
  customerId: string,
): Promise<void> {
  await run(env.DB, 'UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, userId]);
}

/**
 * Apply a parsed subscription to the owning user. Resolves the user by Stripe
 * customer id, falling back to the `userId` carried in subscription metadata
 * (and persisting the customer link) to tolerate out-of-order webhook delivery.
 * Returns the affected user id, or null if no user could be resolved.
 */
export async function applySubscription(env: Env, sub: ParsedSubscription): Promise<string | null> {
  let user = await getUserByStripeCustomerId(env, sub.customerId);
  if (!user && sub.metadataUserId) {
    user = await getUserById(env, sub.metadataUserId);
    if (user) await linkCustomerToUser(env, user.id, sub.customerId);
  }
  if (!user) return null;

  await run(
    env.DB,
    `UPDATE users
        SET stripe_customer_id = ?,
            stripe_subscription_id = ?,
            subscription_status = ?,
            plan = ?,
            current_period_end = ?,
            cancel_at_period_end = ?,
            trial_end = ?
      WHERE id = ?`,
    [
      sub.customerId,
      sub.id,
      sub.status,
      planForPrice(env, sub.priceId),
      sub.currentPeriodEnd,
      sub.cancelAtPeriodEnd ? 1 : 0,
      sub.trialEnd,
      user.id,
    ],
  );
  return user.id;
}

/**
 * Mark a subscription as ended (customer.subscription.deleted). Clears the
 * subscription fields but keeps the customer id so a re-subscribe reuses it.
 */
export async function endSubscription(env: Env, customerId: string): Promise<string | null> {
  const user = await getUserByStripeCustomerId(env, customerId);
  if (!user) return null;
  await run(
    env.DB,
    `UPDATE users
        SET subscription_status = 'canceled',
            cancel_at_period_end = 0,
            trial_end = NULL
      WHERE id = ?`,
    [user.id],
  );
  return user.id;
}
