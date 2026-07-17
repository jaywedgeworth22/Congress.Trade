import { describe, it, expect } from 'vitest';
import { parseMassiveAggs, buildMassivePriceClient } from '../massive';

const fetchWith = (status: number, body: unknown = '') =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

// 2024-01-02 and 2024-01-03 at 00:00 ET (epoch ms).
const aggs = {
  ticker: 'AAPL',
  results: [
    { t: Date.parse('2024-01-02T05:00:00Z'), c: 185.64, o: 187.15, v: 1 },
    { t: Date.parse('2024-01-03T05:00:00Z'), c: 184.25, o: 184.22, v: 2 },
  ],
};

describe('parseMassiveAggs', () => {
  it('maps {t,c} to descending [{date, close}]', () => {
    const out = parseMassiveAggs(aggs);
    expect(out).toEqual([
      { date: '2024-01-03', close: 184.25 },
      { date: '2024-01-02', close: 185.64 },
    ]);
  });
  it('returns [] for an empty/error body', () => {
    expect(parseMassiveAggs({ status: 'NOT_AUTHORIZED' })).toEqual([]);
    expect(parseMassiveAggs(null)).toEqual([]);
  });
});

describe('buildMassivePriceClient', () => {
  it('parses closes on 200', async () => {
    const out = await buildMassivePriceClient('k', fetchWith(200, aggs)).eodHistory('AAPL', '2024-01-01', '2024-01-05');
    expect(out[0]).toEqual({ date: '2024-01-03', close: 184.25 });
  });
  it('returns [] on 404 (unknown symbol) but throws on transient/auth/server errors', async () => {
    // 404 = genuine "no data" so a delisted/unknown ticker can be negative-cached.
    expect(await buildMassivePriceClient('k', fetchWith(404)).eodHistory('ZZZZ', 'a', 'b')).toEqual([]);
    // Auth/rate/server failures throw so the caller skips + retries instead of
    // negative-caching priceable tickers during a transient outage.
    await expect(buildMassivePriceClient('k', fetchWith(403)).eodHistory('AAPL', 'a', 'b')).rejects.toThrow('MASSIVE_HTTP_403');
    await expect(buildMassivePriceClient('k', fetchWith(429)).spxHistory('a', 'b')).rejects.toThrow('MASSIVE_HTTP_429');
    await expect(buildMassivePriceClient('k', fetchWith(500)).eodHistory('AAPL', 'a', 'b')).rejects.toThrow('MASSIVE_HTTP_500');
  });
});
