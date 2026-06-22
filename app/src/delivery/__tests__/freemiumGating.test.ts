import { describe, it, expect } from 'vitest';
import {
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsExportQuery,
  MAX_EXPORT_ROWS,
  FREE_WINDOW_DAYS,
} from '../rows';
import { buildRestRouter } from '../rest';
import type { Env } from '../../shared/types';

describe('freemium query gating (filedSince)', () => {
  it('adds the recency clause + bound param to the feed query', () => {
    const q = buildTransactionsQuery({ filedSince: '2024-01-01', limit: 50 });
    expect(q.sql).toContain('COALESCE(f.filed_date, t.tx_date) >= ?');
    expect(q.params).toContain('2024-01-01');
    expect(q.limit).toBe(50);
  });

  it('applies the same clause to the count query (consistent X of N)', () => {
    const q = buildTransactionsCountQuery({ filedSince: '2024-01-01' });
    expect(q.sql).toContain('COALESCE(f.filed_date, t.tx_date) >= ?');
    expect(q.params).toEqual(['2024-01-01']);
  });

  it('omits the clause when filedSince is absent', () => {
    expect(buildTransactionsQuery({}).sql).not.toContain('filed_date, t.tx_date) >=');
  });
});

describe('buildTransactionsExportQuery', () => {
  it('drops the cursor backstop, orders newest-first, and caps rows', () => {
    const q = buildTransactionsExportQuery({ ticker: 'aapl' });
    expect(q.sql).not.toContain('cursor_seq > ?');
    expect(q.sql).toContain('ORDER BY t.cursor_seq DESC');
    expect(q.sql).toContain(`LIMIT ${MAX_EXPORT_ROWS}`);
    expect(q.params).toContain('AAPL');
  });

  it('clamps an oversized maxRows back to the cap', () => {
    expect(buildTransactionsExportQuery({}, 10_000_000).limit).toBe(MAX_EXPORT_ROWS);
  });
});

/** Fake env: anonymous (no session cookie) => getCurrentUser resolves to null. */
function fakeEnv(): Env {
  return {
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        async first() {
          return { total: 0 };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return {};
        },
      }),
    },
  } as unknown as Env;
}

describe('GET /transactions gating for anonymous visitors', () => {
  it('returns gated:true, premium:false, and the free window size', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/transactions', {}, fakeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { premium: boolean; gated: boolean; freeWindowDays?: number };
    expect(body.premium).toBe(false);
    expect(body.gated).toBe(true);
    expect(body.freeWindowDays).toBe(FREE_WINDOW_DAYS);
  });
});

describe('GET /export/transactions.csv', () => {
  it('returns 402 + upgradeRequired for non-premium visitors', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/export/transactions.csv', {}, fakeEnv());
    expect(res.status).toBe(402);
    expect(((await res.json()) as { upgradeRequired?: boolean }).upgradeRequired).toBe(true);
  });
});
