import { describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types';
import { runTickerBackfill } from '../routes';

describe('runTickerBackfill', () => {
  it('retroactively repairs preferred/depositary share rows collapsed to issuer tickers', async () => {
    const updates: Array<{ ticker: string; id: string }> = [];
    const securities = [
      { ticker: 'T', name: 'AT&T Inc.', aliases: '[]' },
      { ticker: 'JPM', name: 'JPMorgan Chase & Co.', aliases: '[]' },
    ];
    const transactions = [
      {
        id: 'tx-jpm',
        ticker: 'JPM',
        asset_name: 'JPMorgan Chase & Co. Depositary Shares, Series GG',
      },
      {
        id: 'tx-t',
        ticker: 'T',
        asset_name:
          'AT&T Inc. Depositary Shares, each representing a 1/1,000th interest in a share of 5.000% Perpetual Preferred Stock, Series A',
      },
      { id: 'tx-common', ticker: 'JPM', asset_name: 'JPMorgan Chase & Co. Common Stock' },
    ];

    const env = {
      DB: {
        prepare(sql: string) {
          return {
            _params: [] as unknown[],
            bind(...params: unknown[]) {
              this._params = params;
              return this;
            },
            async all<T>() {
              if (/FROM securities_master/i.test(sql)) return { results: securities as unknown as T[] };
              if (/FROM transactions/i.test(sql)) return { results: transactions as unknown as T[] };
              return { results: [] as T[] };
            },
          };
        },
        async batch(statements: Array<{ _params: unknown[] }>) {
          for (const stmt of statements) {
            updates.push({ ticker: String(stmt._params[0]), id: String(stmt._params[1]) });
          }
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        },
      } as unknown as D1Database,
    } as Env;

    const result = await runTickerBackfill(env, 10);
    expect(result).toEqual({ scanned: 3, resolved: 2 });
    expect(updates).toEqual([
      { id: 'tx-jpm', ticker: 'JPM^J' },
      { id: 'tx-t', ticker: 'T^A' },
    ]);
  });
});
