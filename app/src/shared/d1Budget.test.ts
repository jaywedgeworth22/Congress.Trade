import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './types';

function fakeKv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  };
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
});
