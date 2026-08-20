/**
 * src/delivery/__tests__/twinDedupeScale.test.ts
 *
 * Issue #2062: PR 2037's correlated TWIN_DEDUPE_SQL hung first-page
 * GET /transactions (unbounded COUNT) and 90d Trends on a prod-sized
 * corpus. Five-row in-memory fixtures could not catch that.
 *
 * This file plants thousands of unique live rows plus a Fleischmann-style
 * triple and asserts:
 *   - COUNT / today have no correlated transactions-d subquery
 *   - EXPLAIN QUERY PLAN on COUNT is not a per-row corpus scan
 *   - first-page + COUNT + today + 90d summary finish well under 2s
 *   - published page / analytics still collapse the TSCO triple
 */

import { describe, expect, it } from 'vitest';
import { BASE_SCHEMA_STATEMENTS, TWIN_SEEK_INDEX_SCHEMA_STATEMENTS } from '../../admin/migrations.ts';
import { buildSummaryQuery, buildTickerLeaderboardQuery } from '../../analytics/builders.ts';
import {
  buildTransactionsCountQuery,
  buildTransactionsQuery,
  buildTransactionsTodayFilingsQuery,
} from '../rows.ts';
import { TWIN_DEDUPE_SQL, TWIN_SEEK_INDEX } from '../../shared/tradeIdentity.ts';

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const CORPUS = 12_000;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function createCorpus(): Promise<SqliteDatabase> {
  const sqlite = (await import('node:sqlite')) as unknown as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  for (const sql of BASE_SCHEMA_STATEMENTS) {
    try {
      db.exec(sql);
    } catch {
      // idempotent schema fragments
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS securities_ref (
      ticker TEXT PRIMARY KEY, company_name TEXT, sector TEXT, market_cap REAL,
      market_cap_bucket TEXT, country TEXT, exchange_short TEXT, asset_class TEXT, enriched_at TEXT
    );
    ALTER TABLE filers ADD COLUMN photo_url TEXT;
    ALTER TABLE filers ADD COLUMN resolved_bioguide_id TEXT;
    ALTER TABLE filers ADD COLUMN display_name TEXT;
    ALTER TABLE filings ADD COLUMN filing_status TEXT;
    ALTER TABLE transactions ADD COLUMN deprecated_at TEXT;
  `);
  for (const sql of TWIN_SEEK_INDEX_SCHEMA_STATEMENTS) {
    db.exec(sql);
  }

  db.exec('BEGIN');
  const filer = db.prepare(
    'INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, party) VALUES (?, ?, ?, ?)',
  );
  const ins = db.prepare(`
    INSERT INTO transactions (
      id, doc_id, filer_id, tx_date, ticker, asset_name, tx_type, source,
      amount_min, amount_max, owner, is_option
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1001, 15000, 'self', 0)
  `);
  for (let i = 0; i < CORPUS; i++) {
    const filerId = `F${String(i % 400).padStart(6, '0')}`;
    if (i < 400) filer.run(filerId, 'house', `Member ${filerId}`, 'Republican');
    const ticker = `T${String(i % 800).padStart(3, '0')}`;
    const source = i % 17 === 0 ? 'competitor_backfill' : i % 11 === 0 ? 'manual' : 'primary';
    ins.run(
      `id-${i}`,
      `D-${i}`,
      filerId,
      isoDaysAgo(i % 80),
      ticker,
      ticker,
      i % 3 === 0 ? 'S' : 'B',
      source,
    );
  }
  filer.run('F000459', 'house', 'Chuck Fleischmann', 'Republican');
  ins.run('manual-tsco', 'H-2026-9116212', 'F000459', isoDaysAgo(10), 'TSCO', 'TSCO', 'S', 'manual');
  ins.run('primary-tsco', 'H-2026-20034932', 'F000459', isoDaysAgo(10), 'TSCO', 'TSCO', 'S', 'primary');
  ins.run(
    'competitor-tsco',
    'COMPETITOR-fleischmann_TSCO',
    'F000459',
    isoDaysAgo(10),
    'TSCO',
    'TSCO',
    'S',
    'competitor_backfill',
  );
  db.exec('COMMIT');
  return db;
}

function planDetails(db: SqliteDatabase, sql: string): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row.detail ?? ''))
    .join(' | ');
}

describe('twin-dedupe scale (#2062)', () => {
  it('COUNT/today omit the correlated twin scan; first page and 90d stay fast', async () => {
    const db = await createCorpus();
    const pageQ = buildTransactionsQuery({ since: 0, sort: 'tx_date', order: 'desc', limit: 50 });
    const countQ = buildTransactionsCountQuery({ since: 0, sort: 'tx_date', order: 'desc' });
    const todayQ = buildTransactionsTodayFilingsQuery({}, isoDaysAgo(0));
    const summaryQ = buildSummaryQuery({ window: '90d' });
    const boardQ = buildTickerLeaderboardQuery({ window: '90d', limit: 20 });

    expect(countQ.sql).not.toContain(TWIN_DEDUPE_SQL);
    expect(countQ.sql).not.toContain('FROM transactions d');
    expect(todayQ.sql).not.toContain(TWIN_DEDUPE_SQL);
    expect(pageQ.sql).toContain(TWIN_DEDUPE_SQL);
    expect(summaryQ.sql).toContain(TWIN_DEDUPE_SQL);

    const countPlan = planDetails(db, countQ.sql);
    expect(countPlan).not.toMatch(/CORRELATED SCALAR SUBQUERY/);
    expect(countPlan).not.toMatch(/SCAN d\b/);

    const summaryPlan = planDetails(db, summaryQ.sql);
    expect(summaryPlan).toContain(`USING INDEX ${TWIN_SEEK_INDEX}`);
    expect(summaryPlan).not.toMatch(/SCAN d\b/);

    const t0 = performance.now();
    const page = db.prepare(pageQ.sql).all(...pageQ.params);
    const count = db.prepare(countQ.sql).get(...countQ.params);
    db.prepare(todayQ.sql).get(...todayQ.params);
    const summary = db.prepare(summaryQ.sql).get(...summaryQ.params);
    db.prepare(boardQ.sql).all(...boardQ.params);
    const elapsed = performance.now() - t0;

    expect(page.length).toBe(50);
    expect(Number(count?.total)).toBe(CORPUS + 3);
    expect(Number(summary?.total_trades)).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);

    const tscoPage = buildTransactionsQuery({
      ticker: 'TSCO',
      since: 0,
      sort: 'tx_date',
      order: 'desc',
    });
    const published = db.prepare(tscoPage.sql).all(...tscoPage.params);
    expect(published.map((row) => row.id)).toEqual(['primary-tsco']);

    db.close();
  });
});
