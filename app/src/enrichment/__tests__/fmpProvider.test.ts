import { describe, it, expect } from 'vitest';
import { buildFmpProvider } from '../fmp.ts';

const fetchWith = (status: number, body: unknown = '') =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;

describe('buildFmpProvider fetchRef — tier-error surfacing', () => {
  it('throws FMP_HTTP_401 on an unauthorized response (invalid/expired key)', async () => {
    await expect(buildFmpProvider('k', fetchWith(401)).fetchRef('AAPL')).rejects.toThrow('FMP_HTTP_401');
  });

  it('throws FMP_HTTP_429 on rate limit (effectively dropped to free)', async () => {
    await expect(buildFmpProvider('k', fetchWith(429)).fetchRef('AAPL')).rejects.toThrow('FMP_HTTP_429');
  });

  it('returns null (no throw) on 404 — unknown symbol is "no data", not an alert', async () => {
    expect(await buildFmpProvider('k', fetchWith(404)).fetchRef('ZZZZ')).toBeNull();
  });

  it('parses a profile on 200', async () => {
    const ref = await buildFmpProvider(
      'k',
      fetchWith(200, [{ symbol: 'AAPL', companyName: 'Apple', sector: 'Technology' }]),
    ).fetchRef('AAPL');
    expect(ref?.companyName).toBe('Apple');
    expect(ref?.sector).toBe('Technology');
  });

  it('maps the /stable/ field shape (marketCap; exchange = short, exchangeFullName = full)', async () => {
    const ref = await buildFmpProvider(
      'k',
      fetchWith(200, [
        {
          symbol: 'AAPL',
          companyName: 'Apple Inc.',
          sector: 'Technology',
          marketCap: 4322488870800,
          exchange: 'NASDAQ',
          exchangeFullName: 'NASDAQ Global Select',
          country: 'US',
        },
      ]),
    ).fetchRef('AAPL');
    expect(ref?.marketCap).toBe(4322488870800);
    expect(ref?.marketCapBucket).toBe('mega');
    expect(ref?.exchangeShort).toBe('NASDAQ');
    expect(ref?.exchange).toBe('NASDAQ Global Select');
  });

  it('derives shares outstanding from marketCap / price (no extra call)', async () => {
    const ref = await buildFmpProvider(
      'k',
      fetchWith(200, [{ symbol: 'AAPL', companyName: 'Apple Inc.', marketCap: 3_000_000_000_000, price: 200 }]),
    ).fetchRef('AAPL');
    expect(ref?.sharesOutstanding).toBe(15_000_000_000); // 3e12 / 200
  });

  it('leaves shares outstanding null when price is missing or zero', async () => {
    const ref = await buildFmpProvider(
      'k',
      fetchWith(200, [{ symbol: 'AAPL', companyName: 'Apple Inc.', marketCap: 3_000_000_000_000, price: 0 }]),
    ).fetchRef('AAPL');
    expect(ref?.sharesOutstanding ?? null).toBeNull();
  });

  it('treats FMP\'s { "Error Message" } object (non-array) as no data', async () => {
    const ref = await buildFmpProvider(
      'k',
      fetchWith(200, { 'Error Message': 'Legacy Endpoint : no longer supported' }),
    ).fetchRef('AAPL');
    expect(ref).toBeNull();
  });
});
