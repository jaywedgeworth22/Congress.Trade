import { describe, expect, it } from 'vitest';
import { validateSubscriptionFilters } from '../subscriptions';

describe('subscription filter validation', () => {
  it('normalizes bounded filters', () => {
    expect(validateSubscriptionFilters({ tickers: ['aapl', 'AAPL'], chambers: ['house'], minAmount: 1000 })).toEqual({
      ok: true, filters: { tickers: ['AAPL'], chambers: ['house'], minAmount: 1000 },
    });
  });
  it('rejects unbounded, invalid, and inverted filters', () => {
    expect(validateSubscriptionFilters({ tickers: Array(51).fill('A') }).ok).toBe(false);
    expect(validateSubscriptionFilters({ sides: ['X'] }).ok).toBe(false);
    expect(validateSubscriptionFilters({ minAmount: 2, maxAmount: 1 }).ok).toBe(false);
  });
});
