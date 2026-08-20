import { describe, it, expect } from 'vitest';
import {
  clientRedeemWouldResurrectRevoked,
  type AppleSubscriptionRecord,
} from '../appleSubscriptions.ts';

function revokedRow(overrides: Partial<AppleSubscriptionRecord> = {}): AppleSubscriptionRecord {
  return {
    originalTransactionId: 'otxn-1',
    userId: null,
    productId: 'trade.congress.premium.monthly',
    plan: 'monthly',
    status: 'revoked',
    environment: 'Production',
    latestTransactionId: 'txn-refund',
    purchaseDate: '2026-01-01T00:00:00.000Z',
    expiresDate: '2026-02-01T00:00:00.000Z',
    autoRenewStatus: false,
    autoRenewProductId: null,
    revokedAt: '2026-01-15T00:00:00.000Z',
    revocationReason: 1,
    lastNotificationType: 'REFUND',
    lastNotificationSubtype: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('clientRedeemWouldResurrectRevoked', () => {
  it('lets a first-time redeem through (no ledger row yet)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(null, { transactionId: 'txn-1', purchaseDateMs: Date.now() }),
    ).toBe(false);
  });

  it('lets an active ledger row through (restore purchases)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(
        { ...revokedRow(), status: 'active', revokedAt: null },
        { transactionId: 'txn-1', purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z') },
      ),
    ).toBe(false);
  });

  it('blocks replaying the original JWS after REFUND (same or older purchase)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(revokedRow(), {
        transactionId: 'txn-1',
        purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe(true);
  });

  it('blocks even when the refund webhook rotated latestTransactionId', () => {
    expect(
      clientRedeemWouldResurrectRevoked(revokedRow({ latestTransactionId: 'txn-refund' }), {
        transactionId: 'txn-1',
        purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe(true);
  });

  it('allows a later purchase on the same originalTransactionId after revoke', () => {
    expect(
      clientRedeemWouldResurrectRevoked(revokedRow(), {
        transactionId: 'txn-resubscribe',
        purchaseDateMs: Date.parse('2026-01-16T00:00:00.000Z'),
      }),
    ).toBe(false);
  });
});
