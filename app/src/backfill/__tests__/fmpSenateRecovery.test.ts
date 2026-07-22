import { describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import type { TickerResolver } from '../../extraction/normalizer.ts';
import {
  fmpSenateDocId,
  fmpSenateRowKey,
  mapFmpSenateRecord,
  runFmpSenateRecovery,
  type FmpSenateRecord,
} from '../fmpSenateRecovery.ts';

const BASE: FmpSenateRecord = {
  firstName: 'Jane',
  lastName: 'Smith',
  senateID: 'S001234',
  symbol: 'AAPL',
  assetDescription: 'Apple Inc.',
  assetType: 'Stock',
  type: 'Purchase',
  amount: '$1,001 - $15,000',
  owner: 'Self',
  transactionDate: '2026-07-01',
  disclosureDate: '2026-07-15',
  link: 'https://efdsearch.senate.gov/search/view/ptr/abc12345-0000-0000-0000-000000000000/',
  comment: '',
};

const resolveAll: TickerResolver = (ticker) => ticker?.trim().toUpperCase() || null;

describe('FMP Senate recovery identity', () => {
  it('uses the canonical Senate report id and a side-aware stable row key', () => {
    expect(fmpSenateDocId(BASE)).toBe('S-abc12345-0000-0000-0000-000000000000');
    expect(fmpSenateRowKey(BASE)).toBe(fmpSenateRowKey({ ...BASE }));
    expect(fmpSenateRowKey(BASE)).not.toBe(fmpSenateRowKey({ ...BASE, type: 'Sale (Full)' }));
    expect(fmpSenateRowKey(BASE, 2)).not.toBe(fmpSenateRowKey(BASE, 1));
  });

  it('maps provenance without collapsing opposite-side rows from one report', () => {
    const buy = mapFmpSenateRecord(BASE, 1, '2026-07-22T00:00:00.000Z', resolveAll);
    const sell = mapFmpSenateRecord(
      { ...BASE, type: 'Sale (Full)' },
      1,
      '2026-07-22T00:00:00.000Z',
      resolveAll,
    );
    expect(buy).not.toBeNull();
    expect(sell).not.toBeNull();
    expect(buy?.docId).toBe(sell?.docId);
    expect(buy?.rowKey).not.toBe(sell?.rowKey);
    expect(buy?.transaction.id).not.toBe(sell?.transaction.id);
    expect(buy?.transaction).toMatchObject({
      filerId: 'senate-jane-smith',
      source: 'seed_dataset',
      txType: 'P',
      firstSeenAt: '2026-07-15T00:00:00.000Z',
      filedDate: '2026-07-15',
    });
    expect(sell?.transaction.txType).toBe('S');
  });

  it('falls back deterministically when FMP omits the report link', () => {
    const noLink = { ...BASE, link: '' };
    expect(fmpSenateDocId(noLink)).toMatch(/^S-fmp-/);
    expect(fmpSenateDocId(noLink)).toBe(fmpSenateDocId({ ...noLink }));
  });
});

function fakeEnv() {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const kv = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          captured.push({ sql, params: statement.params });
          return { meta: { changes: 1 } } as D1Result;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: Array<{ run(): Promise<D1Result> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  const env = {
    DB: db,
    FMP_API_KEY: 'test-fmp-key',
    FMP_DAILY_CALL_CAP: '230',
    CONFIG_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
  } as unknown as Env;
  return { env, captured };
}

describe('runFmpSenateRecovery', () => {
  it('fetches only the bounded requested pages and writes filers, filings, and row-keyed transactions', async () => {
    const { env, captured } = fakeEnv();
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json([{ ...BASE, link: BASE.link?.replace('abc12345', `page${page}abc`) }]);
    }) as typeof fetch;

    const result = await runFmpSenateRecovery(env, {
      fromPage: 3,
      toPage: 4,
      fetchImpl,
      now: new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      ok: true,
      fromPage: 3,
      toPage: 4,
      fetched: 2,
      accepted: 2,
      inserted: 2,
      rejected: 0,
    });
    expect(urls).toHaveLength(2);
    expect(urls.map((url) => new URL(url).searchParams.get('page'))).toEqual(['3', '4']);
    expect(captured.some(({ sql }) => /provider_seeded/.test(sql))).toBe(true);
    const txWrites = captured.filter(({ sql }) => /INSERT OR IGNORE INTO transactions/i.test(sql));
    expect(txWrites).toHaveLength(2);
    expect(txWrites.every(({ sql }) => /row_key/.test(sql))).toBe(true);
    expect(txWrites.every(({ sql }) => /source IN \('primary', 'manual'\)/.test(sql))).toBe(true);
  });

  it('rejects ranges larger than five pages before spending a provider call', async () => {
    const { env } = fakeEnv();
    await expect(runFmpSenateRecovery(env, { fromPage: 0, toPage: 5 })).rejects.toThrow(
      'at most 5 pages',
    );
  });
});
