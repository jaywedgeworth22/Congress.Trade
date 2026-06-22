/**
 * src/billing/entitlement.ts
 * Pure access-level derivation from a User's Stripe billing fields. No I/O, so
 * it's shared freely between the data API (gating), the auth `/me` endpoint, and
 * the billing routes — and is trivially unit-testable.
 *
 * A visitor is "premium" while their Stripe subscription is `trialing` or
 * `active`. We deliberately do NOT extend premium to `past_due`/`unpaid`: Stripe
 * keeps the subscription in `active` during its smart-retry grace window and
 * only flips to `past_due` once retries are failing, at which point access
 * should lapse until payment succeeds (which returns it to `active`).
 */

import type { Entitlement, User } from '../shared/types';

/** Stripe subscription statuses that grant premium access. */
export const PREMIUM_STATUSES: ReadonlySet<string> = new Set(['trialing', 'active']);

/** The free, anonymous entitlement (no user / never subscribed). */
export const ANONYMOUS_ENTITLEMENT: Entitlement = {
  premium: false,
  status: null,
  plan: null,
  trialing: false,
  trialEnd: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

/** Derive the access level for a user (or null for anonymous visitors). */
export function entitlementOf(user: User | null | undefined): Entitlement {
  if (!user) return ANONYMOUS_ENTITLEMENT;
  const status = user.subscriptionStatus;
  return {
    premium: status != null && PREMIUM_STATUSES.has(status),
    status: status ?? null,
    plan: user.plan ?? null,
    trialing: status === 'trialing',
    trialEnd: user.trialEnd ?? null,
    currentPeriodEnd: user.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: !!user.cancelAtPeriodEnd,
  };
}

/** Convenience boolean: may this user access premium features? */
export function isPremiumUser(user: User | null | undefined): boolean {
  return entitlementOf(user).premium;
}
