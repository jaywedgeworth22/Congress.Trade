import { describe, expect, it } from 'vitest';
import {
  isStaleLedgerReactivation,
  type AppleSubscriptionRecord,
} from '../appleSubscriptions.ts';

function row(overrides: Partial<AppleSubscriptionRecord> = {}): AppleSubscriptionRecord {
  return {
    originalTransactionId: 'otxn-1',
    userId: null,
    productId: 'trade.congress.premium.monthly',
    plan: 'monthly',
    status: 'revoked',
    environment: 'Production',
    latestTransactionId: 'txn-1',
    purchaseDate: '2026-08-01T00:00:00.000Z',
    expiresDate: '2026-09-01T00:00:00.000Z',
    autoRenewStatus: null,
    autoRenewProductId: null,
    revokedAt: '2026-08-20T12:00:00.000Z',
    revocationReason: 1,
    lastNotificationType: 'REFUND',
    lastNotificationSubtype: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('isStaleLedgerReactivation', () => {
  it('never blocks an already-active or grace-period row (idempotent restore)', () => {
    expect(isStaleLedgerReactivation(row({ status: 'active', revokedAt: null }), { transactionId: 'txn-1' })).toBe(false);
    expect(isStaleLedgerReactivation(row({ status: 'grace_period', revokedAt: null }), { transactionId: 'txn-1' })).toBe(false);
  });

  it('blocks replay of the same transactionId after REFUND/REVOKE', () => {
    expect(isStaleLedgerReactivation(row(), {
      transactionId: 'txn-1',
      purchaseDate: Date.parse('2026-08-01T00:00:00.000Z'),
      expiresDate: Date.parse('2026-09-01T00:00:00.000Z'),
    })).toBe(true);
  });

  it('blocks an older purchase even when the transactionId differs', () => {
    expect(isStaleLedgerReactivation(row(), {
      transactionId: 'txn-older',
      purchaseDate: Date.parse('2026-07-01T00:00:00.000Z'),
      expiresDate: Date.parse('2026-08-01T00:00:00.000Z'),
    })).toBe(true);
  });

  it('allows a later purchase after revoke (real re-subscribe)', () => {
    expect(isStaleLedgerReactivation(row(), {
      transactionId: 'txn-resubscribe',
      purchaseDate: Date.parse('2026-08-21T00:00:00.000Z'),
      expiresDate: Date.parse('2026-09-21T00:00:00.000Z'),
    })).toBe(false);
  });

  it('blocks expired/billing_retry resurrection from the same transaction', () => {
    expect(isStaleLedgerReactivation(row({ status: 'expired', revokedAt: null }), { transactionId: 'txn-1' })).toBe(true);
    expect(isStaleLedgerReactivation(row({ status: 'billing_retry', revokedAt: null }), { transactionId: 'txn-1' })).toBe(true);
  });
});
