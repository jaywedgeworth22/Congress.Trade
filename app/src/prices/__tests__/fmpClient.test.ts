import { describe, it, expect } from 'vitest';
import { buildFmpPriceClient } from '../fmp.ts';

const fetchWith = (status: number, body: unknown = '') =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;

describe('buildFmpPriceClient — tier-error surfacing', () => {
  it('throws FMP_HTTP_403 on the S&P call when the plan is forbidden', async () => {
    await expect(
      buildFmpPriceClient('k', fetchWith(403)).spxHistory('2024-01-01', '2024-02-01'),
    ).rejects.toThrow('FMP_HTTP_403');
  });

  it('returns [] (no throw) on 404 for an unknown ticker', async () => {
    expect(
      await buildFmpPriceClient('k', fetchWith(404)).eodHistory('ZZZZ', '2024-01-01', '2024-02-01'),
    ).toEqual([]);
  });

  it('throws FMP_HTTP_500 on a server error (transient — must not read as no-data)', async () => {
    // A 5xx must NOT be swallowed as [], or the price refresh would negative-cache
    // priceable tickers during an FMP outage.
    await expect(
      buildFmpPriceClient('k', fetchWith(500)).eodHistory('AAPL', '2024-01-01', '2024-02-01'),
    ).rejects.toThrow('FMP_HTTP_500');
  });

  it('parses closes on 200', async () => {
    const closes = await buildFmpPriceClient(
      'k',
      fetchWith(200, { historical: [{ date: '2024-01-03', adjClose: 12 }, { date: '2024-01-02', close: 10 }] }),
    ).eodHistory('AAPL', '2024-01-01', '2024-02-01');
    expect(closes[0]).toEqual({ date: '2024-01-03', close: 12 });
  });
});
