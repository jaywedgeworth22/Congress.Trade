import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './types';

function fakeKv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  };
}

function fakeD1() {
  const totals = { read: 0, written: 0 };
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (/INSERT INTO d1_budget/i.test(sql)) {
                totals.read += Number(params[1] ?? 0);
                totals.written += Number(params[2] ?? 0);
              }
              return { success: true };
            },
            async first<T>() {
              return { rows_read: totals.read, rows_written: totals.written } as T;
            },
          };
        },
      };
      return statement;
    },
  };
  return { db, totals, statements };
}

async function loadBudget(values: Record<string, string | undefined>) {
  vi.resetModules();
  const resolveSecret = vi.fn(async (_env: unknown, key: string) => ({
    value: values[key],
    source: values[key] ? 'infisical' : 'missing',
  }));
  vi.doMock('../secrets/infisical', () => ({ resolveSecret }));
  return { ...(await import('./d1Budget')), resolveSecret };
}

afterEach(() => {
  vi.doUnmock('../secrets/infisical');
  vi.restoreAllMocks();
});

describe('D1 row budgets', () => {
  it('uses the Infisical read threshold for soft warnings', async () => {
    const { flushD1Budget, recordD1Meta, resolveSecret } = await loadBudget({
      D1_DAILY_ROWS_READ_BUDGET: '10',
      D1_DAILY_ROWS_WRITTEN_BUDGET: '100',
    });
    const kv = fakeKv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    recordD1Meta({ rows_read: 8 });
    await flushD1Budget({
      CONFIG_KV: kv,
      // A Worker binding must not override the documented Infisical setting.
      D1_DAILY_ROWS_READ_BUDGET: '100000',
    } as unknown as Env, new Date('2036-01-02T00:00:00.000Z'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read 8/10'));
    expect(resolveSecret).toHaveBeenCalledWith(expect.anything(), 'D1_DAILY_ROWS_READ_BUDGET');
  });

  it('uses the Infisical written threshold for enforcement', async () => {
    const { isD1RowBudgetExceeded, resolveSecret } = await loadBudget({
      D1_ROW_BUDGET_ENFORCE: 'true',
      D1_DAILY_ROWS_READ_BUDGET: '100',
      D1_DAILY_ROWS_WRITTEN_BUDGET: '10',
    });
    const now = new Date('2036-01-03T00:00:00.000Z');
    const kv = fakeKv({ 'd1:rows_written:2036-01-03': '10' });

    await expect(isD1RowBudgetExceeded({ CONFIG_KV: kv } as unknown as Env, now)).resolves.toBe(true);
    expect(resolveSecret).toHaveBeenCalledWith(expect.anything(), 'D1_DAILY_ROWS_WRITTEN_BUDGET');
  });

  it('refreshes shared counters instead of trusting stale isolate-local totals', async () => {
    const { flushD1Budget, isD1RowBudgetExceeded, recordD1Meta } = await loadBudget({
      D1_ROW_BUDGET_ENFORCE: 'true',
      D1_DAILY_ROWS_READ_BUDGET: '100',
      D1_DAILY_ROWS_WRITTEN_BUDGET: '100',
    });
    const now = new Date('2036-01-04T00:00:00.000Z');
    const kv = fakeKv();

    recordD1Meta({ rows_read: 1 });
    await flushD1Budget({ CONFIG_KV: kv } as unknown as Env, now);
    await kv.put('d1:rows_read:2036-01-04', '100');

    await expect(isD1RowBudgetExceeded({ CONFIG_KV: kv } as unknown as Env, now)).resolves.toBe(true);
  });

  it('uses an atomic D1 UPSERT for concurrent isolate-safe totals', async () => {
    const { flushD1Budget, recordD1Meta } = await loadBudget({
      D1_DAILY_ROWS_READ_BUDGET: '100',
      D1_DAILY_ROWS_WRITTEN_BUDGET: '100',
    });
    const { db, totals, statements } = fakeD1();
    recordD1Meta({ rows_read: 7, rows_written: 3 });
    await flushD1Budget({ DB: db, CONFIG_KV: fakeKv() } as unknown as Env, new Date('2036-01-05T00:00:00.000Z'));

    expect(totals).toEqual({ read: 7, written: 3 });
    expect(statements.join('\n')).toMatch(/ON CONFLICT\(day\) DO UPDATE SET/);
  });
});
