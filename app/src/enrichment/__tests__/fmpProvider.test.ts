import { describe, it, expect } from 'vitest';
import { buildFmpProvider } from '../fmp';

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
});
