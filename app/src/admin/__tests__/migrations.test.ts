// The Worker intentionally omits Node types, while Vitest runs this migration
// parity check in Node.
// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { persistTransactions } from '../../extraction/normalizer';
import { checkReadiness } from '../../shared/readiness';
import type { Env, Transaction } from '../../shared/types';
import {
  BASE_SCHEMA_STATEMENTS,
  EST_VALUE_SCHEMA_STATEMENTS,
  POST_0024_SCHEMA_STATEMENTS,
  RELIABILITY_SCHEMA_STATEMENTS,
  REVIEW_AUTONOMY_SCHEMA_STATEMENTS,
  STRIPE_EVENT_SCHEMA_STATEMENTS,
} from '../migrations';

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

const migrationsUrl = new URL(
  '../../../migrations/',
  (import.meta as ImportMeta & { url: string }).url,
);

async function sqliteDatabase(): Promise<SqliteDatabase> {
  // Dynamic module name keeps Worker production types free of Node-only APIs.
  const moduleName = 'node:sqlite';
  const sqlite = await import(moduleName) as SqliteModule;
  return new sqlite.DatabaseSync(':memory:');
}

function migrationFiles(): string[] {
  return readdirSync(migrationsUrl).filter((name: string) => name.endsWith('.sql')).sort();
}

function applyMigrationFiles(db: SqliteDatabase, files: string[]): void {
  for (const name of files) {
    db.exec(readFileSync(new URL(name, migrationsUrl), 'utf8'));
  }
}

function applyAdminTail(db: SqliteDatabase): void {
  for (const sql of POST_0024_SCHEMA_STATEMENTS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column|already exists/i.test((error as Error).message)) throw error;
    }
  }
}

function d1Database(db: SqliteDatabase): D1Database {
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
        return {
          success: true,
          meta: { changes: Number(result.changes) },
        } as unknown as D1Result;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function schemaSnapshot(db: SqliteDatabase): Record<string, unknown> {
  const objects = db.prepare(
    `SELECT type, name, tbl_name
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  ).all();
  const tables = objects
    .filter((row) => row.type === 'table')
    .map((row) => String(row.name));
  const columns = Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`PRAGMA table_xinfo("${table}")`).all(),
  ]));
  const indexes = Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`PRAGMA index_list("${table}")`).all(),
  ]));
  return { objects, columns, indexes };
}

describe('admin migration bootstrap', () => {
  it('creates base tables before incremental ALTER statements run', () => {
    expect(BASE_SCHEMA_STATEMENTS[0]).toContain('CREATE TABLE IF NOT EXISTS filers');
    expect(BASE_SCHEMA_STATEMENTS.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS transactions'))).toBe(true);
    expect(BASE_SCHEMA_STATEMENTS.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS review_queue'))).toBe(true);
  });
  it('includes reliability schema mirrored by migrations 0030 and 0031', () => {
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('delivery_outbox');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('ingestion_outbox');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('dead_letter_cycles');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('claim_token');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('lease_until');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_subscriptions_total_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('source_attempts');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_sse_subscription_connection_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('trg_sse_client_connection_quota');
    expect(RELIABILITY_SCHEMA_STATEMENTS.join('\n')).toContain('idx_deliveries_subscription_tx');
  });

  it('mirrors migrations 0029 and 0032 around the reliability sequence', () => {
    expect(EST_VALUE_SCHEMA_STATEMENTS.join('\n')).toContain('est_value');
    expect(EST_VALUE_SCHEMA_STATEMENTS.join('\n')).toContain('amount_min + amount_max');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('claim_token');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('claim_expires_at');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('stripe_subscription_event_state');
    expect(STRIPE_EVENT_SCHEMA_STATEMENTS.join('\n')).toContain('idx_stripe_subscription_event_customer');
    expect(POST_0024_SCHEMA_STATEMENTS).toEqual([
      ...EST_VALUE_SCHEMA_STATEMENTS,
      ...RELIABILITY_SCHEMA_STATEMENTS,
      ...STRIPE_EVENT_SCHEMA_STATEMENTS,
      ...REVIEW_AUTONOMY_SCHEMA_STATEMENTS,
    ]);
  });

  it('includes the review autonomy schema mirrored by migrations 0033-0037', () => {
    const sql = REVIEW_AUTONOMY_SCHEMA_STATEMENTS.join('\n');
    expect(sql).toContain('page_count');
    expect(sql).toContain('agreement_attempts');
    expect(sql).toContain('agreement_legacy_replay_at');
    expect(sql).toContain('llm_budget');
    expect(sql).toContain('agreement_suppressed_at');
    expect(sql).toContain('idx_transactions_live_doc_source_rowkey');
    expect(sql).toContain('review_revision');
    expect(sql).not.toContain('review_delivery_outbox');
  });

  it('matches the real 0029-0037 file schema and passes readiness on SQLite', async () => {
    const files = migrationFiles();
    const priorFiles = files.filter((name) => Number(name.slice(0, 4)) <= 24);
    const fileDb = await sqliteDatabase();
    const adminDb = await sqliteDatabase();
    try {
      applyMigrationFiles(fileDb, files);
      applyMigrationFiles(adminDb, priorFiles);
      applyAdminTail(adminDb);

      expect(schemaSnapshot(adminDb)).toEqual(schemaSnapshot(fileDb));
      expect(await checkReadiness(d1Database(fileDb))).toEqual({
        ok: true,
        db: true,
        schema: true,
        missing: [],
      });
    } finally {
      fileDb.close();
      adminDb.close();
    }
  });

  it('executes the production transaction/outbox write idempotently on migrated SQLite', async () => {
    const db = await sqliteDatabase();
    try {
      applyMigrationFiles(db, migrationFiles());
      const d1 = d1Database(db);
      const env = { DB: d1 } as unknown as Env;
      const transaction: Transaction = {
        id: 'tx-1',
        docId: 'doc-1',
        filerId: null,
        txDate: '2026-07-01',
        owner: 'self',
        assetName: 'Example Corp',
        ticker: 'EXM',
        assetType: 'stock',
        txType: 'P',
        amountMin: 15_001,
        amountMax: 50_000,
        isOption: false,
        capGainsOver200: false,
        rawText: 'Example Corp (EXM)',
        rowKey: 'primary:0:example',
        confidence: 0.99,
        source: 'primary',
        createdAt: '2026-07-11T00:00:00.000Z',
        cursorSeq: 0,
        firstSeenAt: '2026-07-11T00:00:00.000Z',
        filedDate: '2026-07-10',
      };

      expect(await persistTransactions(env, [transaction])).toEqual(['tx-1']);
      expect(await persistTransactions(env, [{ ...transaction, id: 'tx-retry' }])).toEqual([]);

      expect(db.prepare(
        'SELECT id, cursor_seq, est_value FROM transactions WHERE row_key = ?',
      ).get(transaction.rowKey)).toMatchObject({
        id: 'tx-1',
        est_value: 32_500.5,
      });
      expect(Number(db.prepare('SELECT cursor_seq FROM transactions WHERE id = ?').get('tx-1')?.cursor_seq)).toBeGreaterThan(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
