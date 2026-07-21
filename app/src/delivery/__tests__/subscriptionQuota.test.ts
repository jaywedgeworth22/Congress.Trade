import { describe, expect, it } from 'vitest';
import {
  assertSubscriptionQuota,
  MAX_ACTIVE_SUBSCRIPTIONS_PER_USER,
  MAX_SUBSCRIPTIONS_PER_USER,
  SubscriptionQuotaError,
  updateSubscription,
} from '../subscriptions.ts';
import type { Env } from '../../shared/types.ts';

function envWithCounts(total: number, active: number): Env {
  return { DB: { prepare: () => ({
    bind() { return this; },
    async first<T>() { return { total, active } as T; },
    async all<T>() { return { results: [{ total, active } as T] }; },
  }) } as unknown as D1Database } as Env;
}

describe('durable subscription quotas', () => {
  it('rejects total and active creation limits', async () => {
    await expect(assertSubscriptionQuota(envWithCounts(MAX_SUBSCRIPTIONS_PER_USER, 0), 'user:u', { creating: true }))
      .rejects.toBeInstanceOf(SubscriptionQuotaError);
    await expect(assertSubscriptionQuota(envWithCounts(5, MAX_ACTIVE_SUBSCRIPTIONS_PER_USER), 'user:u', { creating: true }))
      .rejects.toBeInstanceOf(SubscriptionQuotaError);
  });

  it('rejects reactivation at the active limit but permits an in-budget account', async () => {
    await expect(assertSubscriptionQuota(envWithCounts(10, MAX_ACTIVE_SUBSCRIPTIONS_PER_USER), 'user:u', { activating: true }))
      .rejects.toBeInstanceOf(SubscriptionQuotaError);
    await expect(assertSubscriptionQuota(envWithCounts(1, 1), 'user:u', { creating: true })).resolves.toBeUndefined();
  });

  it('normalizes a trigger race during update into SubscriptionQuotaError', async () => {
    const env = {
      DB: { prepare: (sql: string) => ({
        bind() { return this; },
        async run() {
          if (/UPDATE subscriptions/i.test(sql)) throw new Error('D1_ERROR: subscription active quota exceeded');
          return { success: true, meta: { changes: 1 } };
        },
        async first<T>() { return null as T | null; },
      }) } as unknown as D1Database,
    } as unknown as Env;
    await expect(updateSubscription(env, 'sub_1', { active: true })).rejects.toBeInstanceOf(SubscriptionQuotaError);
  });
});
