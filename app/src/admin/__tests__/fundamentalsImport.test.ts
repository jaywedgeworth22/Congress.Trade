/**
 * src/admin/__tests__/fundamentalsImport.test.ts
 *
 * POST /securities/import accepts the sibling-app `fundamentals[]` and
 * `analyst[]` slots (cross-app FMP sharing, reverse direction). We assert the
 * parse/validate/count path with a fake D1 that records the SQL it's handed —
 * no real database needed (mirrors how the import endpoint is otherwise
 * exercised). Rows missing ticker/date are skipped; valid rows are upserted
 * into fundamentals_eod / analyst_consensus.
 */

import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

/** Minimal D1 stub: records every prepared SQL, no-ops bind/batch. */
function fakeDb() {
  const sql: string[] = [];
  const db = {
    prepare(query: string) {
      sql.push(query);
      return { bind: (..._args: unknown[]) => ({}) };
    },
    async batch(_stmts: unknown[]) {
      return [];
    },
  };
  return { db, sql };
}

function importReq(body: unknown, env: Record<string, unknown>) {
  return app.request(
    '/securities/import',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ingest-secret' },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

describe('POST /securities/import — fundamentals + analyst slots', () => {
  it('upserts valid fundamentals rows and skips ones missing ticker/date', async () => {
    const { db, sql } = fakeDb();
    const res = await importReq(
      {
        fundamentals: [
          {
            ticker: 'aapl',
            date: '2026-06-20',
            peRatio: 30.1,
            eps: 6.2,
            beta: 1.2,
            dividendYield: 0.005,
            week52High: 250,
            week52Low: 160,
            fcfYield: 0.03,
            debtToEquity: 1.5,
            epsGrowth: 0.08,
          },
          // `52wHigh`/`52wLow` aliases are honored.
          { ticker: 'MSFT', date: '2026-06-20', '52wHigh': 480, '52wLow': 360 },
          { date: '2026-06-20' }, // no ticker -> skipped
          { ticker: 'TSLA' }, // no date -> skipped
        ],
      },
      { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret', DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fundamentalsRows: number };
    expect(body.ok).toBe(true);
    expect(body.fundamentalsRows).toBe(2);
    expect(sql.some((s) => s.includes('INSERT INTO fundamentals_eod'))).toBe(true);
  });

  it('upserts valid analyst rows and skips ones missing ticker/date', async () => {
    const { db, sql } = fakeDb();
    const res = await importReq(
      {
        analyst: [
          {
            ticker: 'AAPL',
            date: '2026-06-20',
            rating: 'Buy',
            targetMean: 240,
            targetHigh: 300,
            targetLow: 180,
            analystCount: 40,
            strongBuy: 20,
            buy: 10,
            hold: 8,
            sell: 2,
            strongSell: 0,
          },
          { ticker: 'NVDA' }, // no date -> skipped
        ],
      },
      { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret', DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; analystRows: number };
    expect(body.ok).toBe(true);
    expect(body.analystRows).toBe(1);
    expect(sql.some((s) => s.includes('INSERT INTO analyst_consensus'))).toBe(true);
  });

  it('an empty body is still a no-op with zero fundamentals/analyst rows', async () => {
    const { db } = fakeDb();
    const res = await importReq(
      {},
      { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret', DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fundamentalsRows: number; analystRows: number };
    expect(body.fundamentalsRows).toBe(0);
    expect(body.analystRows).toBe(0);
  });
});
