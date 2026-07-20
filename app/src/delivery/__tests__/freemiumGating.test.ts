import { describe, it, expect } from 'vitest';
import {
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsExportQuery,
  MAX_EXPORT_ROWS,
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

  it('floors a fractional maxRows instead of embedding it verbatim (would be invalid SQL)', () => {
    const q = buildTransactionsExportQuery({}, 500.7);
    expect(q.limit).toBe(500);
    expect(q.sql).toContain('LIMIT 500');
    expect(q.sql).not.toContain('500.7');
  });

  it('treats a non-finite maxRows (NaN/Infinity) as absent, falling back to MAX_EXPORT_ROWS', () => {
    expect(buildTransactionsExportQuery({}, NaN).limit).toBe(MAX_EXPORT_ROWS);
    expect(buildTransactionsExportQuery({}, Infinity).limit).toBe(MAX_EXPORT_ROWS);
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

describe('GET /transactions is public (ungated)', () => {
  it('returns a transactions array with no gating flags for anonymous visitors', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/transactions', {}, fakeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: unknown[]; gated?: boolean; premium?: boolean };
    expect(Array.isArray(body.transactions)).toBe(true);
    // No freemium gate on the feed itself — premium is enforced on export.
    expect(body.gated).toBeUndefined();
    expect(body.premium).toBeUndefined();
  });
});

describe('GET /export/transactions.csv', () => {
  it('returns 200 text/csv for anyone (un-gated)', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/export/transactions.csv', {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
  });
});
