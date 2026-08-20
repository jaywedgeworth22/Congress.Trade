// Apple's real signing key is not available to tests, so the JWS chain
// verification itself (appleJws.ts) is unit-tested separately against a
// synthetic chain (billing/__tests__/appleJws.test.ts) — this file mocks
// verifyAppleSignedJws to exercise executeCommand's surrounding
// redeem_apple_purchase logic (bundle id / product id / active-window
// checks, ledger idempotency, owner-mismatch conflict, entitlement result).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAppleSignedJws = vi.fn();
vi.mock('../../billing/appleJws', () => ({
  verifyAppleSignedJws: (...args: unknown[]) => verifyAppleSignedJws(...args),
  AppleJwsVerificationError: class AppleJwsVerificationError extends Error {},
}));

import { executeCommand, commandType } from '../commands.ts';
import { AppleJwsVerificationError } from '../../billing/appleJws.ts';
import { ClientInputError } from '../utils.ts';
import type { Env, User } from '../../shared/types.ts';

interface SqliteRunResult {
  changes: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

async function freshDb(): Promise<SqliteDatabase> {
  const sqlite = (await import('node:sqlite')) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, picture TEXT,
      google_sub TEXT, apple_sub TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_login_at TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT,
      plan TEXT, current_period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, trial_end TEXT
    );
    CREATE TABLE apple_subscriptions (
      original_transaction_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL,
      plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', environment TEXT,
      latest_transaction_id TEXT, purchase_date TEXT, expires_date TEXT,
      auto_renew_status INTEGER, auto_renew_product_id TEXT, revoked_at TEXT, revocation_reason INTEGER,
      last_notification_type TEXT, last_notification_subtype TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.exec(
    `INSERT INTO users (id, email, google_sub, email_verified, created_at) VALUES ('user_1', 'u1@example.com', NULL, 1, '2026-01-01T00:00:00Z')`,
  );
  db.exec(
    `INSERT INTO users (id, email, google_sub, email_verified, created_at) VALUES ('user_2', 'u2@example.com', NULL, 1, '2026-01-01T00:00:00Z')`,
  );
  return db;
}

function d1Database(db: SqliteDatabase): Env['DB'] {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first<T>() {
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } } as unknown;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return { prepare } as unknown as Env['DB'];
}

async function fakeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const db = await freshDb();
  return {
    DB: d1Database(db),
    APPLE_IAP_ENABLED: 'true',
    ...overrides,
  } as unknown as Env;
}

function baseUser(id = 'user_1'): User {
  return {
    id,
    email: `${id}@example.com`,
    name: null,
    picture: null,
    googleSub: null,
    appleSub: null,
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    plan: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEnd: null,
  };
}

const FUTURE_MS = Date.now() + 30 * 86_400_000;

function activeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: 'txn-1',
    originalTransactionId: 'otxn-1',
    productId: 'trade.congress.premium.monthly',
    bundleId: 'trade.congress.ios',
    type: 'Auto-Renewable Subscription',
    environment: 'Production',
    expiresDate: FUTURE_MS,
    purchaseDate: Date.now(),
    ...overrides,
  };
}

describe('commandType', () => {
  it('accepts redeem_apple_purchase', () => {
    expect(commandType('redeem_apple_purchase')).toBe('redeem_apple_purchase');
  });
});

describe('executeCommand redeem_apple_purchase', () => {
  beforeEach(() => {
    verifyAppleSignedJws.mockReset();
  });

  it('is refused when APPLE_IAP_ENABLED is not "true"', async () => {
    const env = await fakeEnv({ APPLE_IAP_ENABLED: 'false' });
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'x.y.z' }),
    ).rejects.toThrow(/not enabled/);
    expect(verifyAppleSignedJws).not.toHaveBeenCalled();
  });

  it('requires signedTransaction', async () => {
    const env = await fakeEnv();
    await expect(executeCommand(env, baseUser(), 'redeem_apple_purchase', {})).rejects.toThrow(
      /signedTransaction/,
    );
  });

  it('surfaces a verification failure as a ClientInputError (permanent, not queue-retried)', async () => {
    verifyAppleSignedJws.mockRejectedValue(new AppleJwsVerificationError('invalid JWS signature'));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(ClientInputError);
  });

  it('rejects a Sandbox transaction unless APPLE_ALLOW_SANDBOX is true', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/Sandbox/);

    const allowed = await fakeEnv({ APPLE_ALLOW_SANDBOX: 'true' });
    const result = (await executeCommand(allowed, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { entitlement: { premium: boolean } };
    expect(result.entitlement.premium).toBe(true);
  });

  it('rejects a bundle id mismatch', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ bundleId: 'com.other.app' }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/bundleId/);
  });

  it('rejects an unrecognized product id', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ productId: 'not.a.real.product' }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/product/);
  });

  it('rejects an expired transaction', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ expiresDate: Date.now() - 1000 }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/active subscription/);
  });

  it('rejects a revoked transaction', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ revocationDate: Date.now() - 1000 }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/active subscription/);
  });

  it('grants premium and persists the ledger row on a valid monthly transaction', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const result = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { entitlement: { premium: boolean; plan: string; source?: string }; originalTransactionId: string };
    expect(result.entitlement.premium).toBe(true);
    expect(result.entitlement.plan).toBe('monthly');
    expect(result.entitlement.source).toBe('apple');
    expect(result.originalTransactionId).toBe('otxn-1');
  });

  it('maps the annual product id to the annual plan', async () => {
    verifyAppleSignedJws.mockResolvedValue(
      activeTransaction({ productId: 'trade.congress.premium.annual', originalTransactionId: 'otxn-annual' }),
    );
    const env = await fakeEnv();
    const result = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { plan: string };
    expect(result.plan).toBe('annual');
  });

  it('honors env-configured APPLE_PRODUCT_MONTHLY/ANNUAL over the hardcoded defaults', async () => {
    verifyAppleSignedJws.mockResolvedValue(
      activeTransaction({ productId: 'com.example.custom.monthly', originalTransactionId: 'otxn-custom' }),
    );
    const env = await fakeEnv({ APPLE_PRODUCT_MONTHLY: 'com.example.custom.monthly' });
    const result = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { plan: string };
    expect(result.plan).toBe('monthly');
  });

  it('redeeming the same originalTransactionId again for the same user is idempotent (restore purchases)', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const first = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { originalTransactionId: string };
    const second = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { originalTransactionId: string; entitlement: { premium: boolean } };
    expect(second.originalTransactionId).toBe(first.originalTransactionId);
    expect(second.entitlement.premium).toBe(true);
  });

  it('refuses to reassign an originalTransactionId already owned by a different user', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    await executeCommand(env, baseUser('user_1'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });
    await expect(
      executeCommand(env, baseUser('user_2'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/already linked/);
  });

  it('a renewal transaction with a newer expiry updates the same ledger row', async () => {
    verifyAppleSignedJws.mockResolvedValueOnce(activeTransaction({ transactionId: 'txn-1', expiresDate: FUTURE_MS }));
    const env = await fakeEnv();
    const first = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { expiresAt: string };

    const laterExpiry = FUTURE_MS + 30 * 86_400_000;
    verifyAppleSignedJws.mockResolvedValueOnce(
      activeTransaction({ transactionId: 'txn-2', expiresDate: laterExpiry }),
    );
    const second = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { expiresAt: string };

    expect(new Date(second.expiresAt).getTime()).toBeGreaterThan(new Date(first.expiresAt).getTime());
  });
});
