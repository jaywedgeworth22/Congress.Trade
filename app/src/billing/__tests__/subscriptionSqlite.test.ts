import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types';
import { applySubscription, endSubscription } from '../subscription';

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
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

let openDatabase: SqliteDatabase | null = null;

async function sqliteDatabase(): Promise<SqliteDatabase> {
  // Dynamic module name keeps Worker production types free of Node-only APIs.
  const moduleName = 'node:sqlite';
  const sqlite = await import(moduleName) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  openDatabase = db;
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      google_sub TEXT,
      email_verified INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT,
      plan TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      trial_end TEXT
    );
    CREATE TABLE stripe_subscription_event_state (
      subscription_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      last_event_created INTEGER NOT NULL,
      last_event_priority INTEGER NOT NULL,
      last_event_id TEXT NOT NULL,
      last_event_type TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function d1Database(db: SqliteDatabase): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) ?? null) as T | null;
        },
        async run() {
          const result = db.prepare(sql).run(...params);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          } as unknown as D1Result;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...params) as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

function envFor(db: SqliteDatabase): Env {
  return {
    DB: d1Database(db),
    STRIPE_PRICE_MONTHLY: 'price_m',
    STRIPE_PRICE_ANNUAL: 'price_a',
  } as unknown as Env;
}

function seedUser(db: SqliteDatabase): void {
  db.prepare(`INSERT INTO users (
    id, email, email_verified, created_at, stripe_customer_id,
    stripe_subscription_id, subscription_status, plan
  ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`)
    .run('u1', 'u1@example.com', '2026-01-01T00:00:00.000Z', 'cus_1', 'sub_old', 'active', 'monthly');
}

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
});

describe('subscription ordering against SQLite', () => {
  it('updates the row when a same-second active create follows terminal old-sub deletion', async () => {
    const db = await sqliteDatabase();
    const env = envFor(db);
    seedUser(db);

    await endSubscription(env, 'cus_1', 'sub_old', {
      id: 'evt_old_deleted',
      created: 1_000,
      type: 'customer.subscription.deleted',
    });
    await applySubscription(env, {
      id: 'sub_new',
      customerId: 'cus_1',
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId: null,
    }, {
      id: 'evt_new_created',
      created: 1_000,
      type: 'customer.subscription.created',
    });

    expect(db.prepare(
      'SELECT stripe_subscription_id, subscription_status FROM users WHERE id = ?',
    ).get('u1')).toMatchObject({
      stripe_subscription_id: 'sub_new',
      subscription_status: 'active',
    });
  });

  it('leaves the row unchanged for an ambiguous same-second nonterminal cross-sub create', async () => {
    const db = await sqliteDatabase();
    const env = envFor(db);
    seedUser(db);
    await applySubscription(env, {
      id: 'sub_old', customerId: 'cus_1', status: 'active', priceId: 'price_m',
      currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEnd: null, metadataUserId: null,
    }, {
      id: 'evt_old_updated', created: 1_100, type: 'customer.subscription.updated',
    });
    await applySubscription(env, {
      id: 'sub_new', customerId: 'cus_1', status: 'active', priceId: 'price_m',
      currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEnd: null, metadataUserId: null,
    }, {
      id: 'evt_new_created', created: 1_100, type: 'customer.subscription.created',
    });

    expect(db.prepare(
      'SELECT stripe_subscription_id, subscription_status FROM users WHERE id = ?',
    ).get('u1')).toMatchObject({
      stripe_subscription_id: 'sub_old',
      subscription_status: 'active',
    });
  });
});
