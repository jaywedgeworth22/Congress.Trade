import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { resetD1WriteGovernor } from '../../shared/d1Budget.ts';
import { insertFilingIfNew, type DiscoveredFiling } from '../watcher.ts';

const DISCOVERED: DiscoveredFiling = {
  docId: 'S-abc12345',
  chamber: 'senate',
  sourceUrl: 'https://efdsearch.senate.gov/search/view/ptr/abc12345/',
  filedDate: '07/15/2026',
  filerId: 'senate-jane-smith',
  filerName: 'Jane Smith',
};

function envWithExistingFiling(providerSeed: boolean) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async run() {
          writes.push({ sql, params: statement.params });
          let changes = 1;
          if (/INSERT OR IGNORE INTO filings/i.test(sql)) changes = 0;
          if (/ingest_status = 'provider_seeded'/i.test(sql)) changes = providerSeed ? 1 : 0;
          return { meta: { changes } } as D1Result;
        },
        async all<T>() {
          if (/FROM filings/i.test(sql) && /provider_seeded/i.test(sql) && providerSeed) {
            return { results: [{ doc_id: DISCOVERED.docId }] as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: Array<{ run(): Promise<D1Result> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return { env: { DB: db } as unknown as Env, writes };
}

beforeEach(() => resetD1WriteGovernor());
afterEach(() => resetD1WriteGovernor());

describe('official discovery upgrades FMP provider seeds', () => {
  it('reopens only the narrowly-tagged provider seed for the official pipeline', async () => {
    const { env, writes } = envWithExistingFiling(true);
    const result = await insertFilingIfNew(env, DISCOVERED, '2026-07-22T00:00:00.000Z');

    expect(result).toBe('inserted');
    const upgrade = writes.find(({ sql }) => /provider_seeded/.test(sql));
    expect(upgrade?.sql).toContain("extractor = 'fmp-senate-latest'");
    expect(upgrade?.sql).toContain("ingest_status = 'new'");
    expect(upgrade?.params).toEqual(expect.arrayContaining(['S-abc12345', 'senate-jane-smith']));
  });

  it('leaves an unrelated pre-existing filing classified as a duplicate', async () => {
    const { env } = envWithExistingFiling(false);
    await expect(insertFilingIfNew(env, DISCOVERED, '2026-07-22T00:00:00.000Z')).resolves.toBe('duplicate');
  });
});
