import { describe, it, expect } from 'vitest';
import { entitlementOf, isPremiumUser, ANONYMOUS_ENTITLEMENT } from '../entitlement.ts';
import type { User } from '../../shared/types.ts';

function user(over: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'a@b.com',
    name: null,
    picture: null,
    googleSub: null,
    emailVerified: true,
    createdAt: 'now',
    lastLoginAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    plan: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEnd: null,
    ...over,
  };
}

describe('entitlementOf', () => {
  it('anonymous visitors get the free entitlement', () => {
    expect(entitlementOf(null)).toEqual(ANONYMOUS_ENTITLEMENT);
    expect(entitlementOf(undefined)).toEqual(ANONYMOUS_ENTITLEMENT);
    expect(entitlementOf(null).premium).toBe(false);
  });

  it('grants premium while trialing (and flags trialing)', () => {
    const e = entitlementOf(user({ subscriptionStatus: 'trialing', plan: 'monthly', trialEnd: 'T' }));
    expect(e.premium).toBe(true);
    expect(e.trialing).toBe(true);
    expect(e.plan).toBe('monthly');
    expect(e.trialEnd).toBe('T');
  });

  it('grants premium while active', () => {
    expect(entitlementOf(user({ subscriptionStatus: 'active', plan: 'annual' })).premium).toBe(true);
  });

  it('denies premium for past_due / canceled / unknown statuses', () => {
    expect(entitlementOf(user({ subscriptionStatus: 'past_due' })).premium).toBe(false);
    expect(entitlementOf(user({ subscriptionStatus: 'canceled' })).premium).toBe(false);
    expect(entitlementOf(user({ subscriptionStatus: 'incomplete' })).premium).toBe(false);
    expect(entitlementOf(user()).premium).toBe(false);
  });

  it('denies premium when an active subscription has no recognized app plan', () => {
    const e = entitlementOf(user({ subscriptionStatus: 'active', plan: null }));
    expect(e.premium).toBe(false);
    expect(e.status).toBe('active');
  });

  it('passes through cancel_at_period_end + period end', () => {
    const e = entitlementOf(
      user({ subscriptionStatus: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: 'P' }),
    );
    expect(e.cancelAtPeriodEnd).toBe(true);
    expect(e.currentPeriodEnd).toBe('P');
  });

  it('isPremiumUser mirrors entitlement.premium', () => {
    expect(isPremiumUser(user({ subscriptionStatus: 'active', plan: 'monthly' }))).toBe(true);
    expect(isPremiumUser(user({ subscriptionStatus: 'past_due' }))).toBe(false);
    expect(isPremiumUser(null)).toBe(false);
  });
});
