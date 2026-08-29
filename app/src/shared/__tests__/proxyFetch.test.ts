import { describe, expect, it, vi } from 'vitest';
import {
  createProxiedFetch,
  getDenoHttpClient,
  resolveResidentialProxyUrl,
} from '../proxyFetch.ts';

describe('proxyFetch', () => {
  it('returns baseFetch when no proxyUrl is provided', () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const fetcher = createProxiedFetch(undefined, mockFetch);
    expect(fetcher).toBe(mockFetch);
  });

  it('returns baseFetch when empty string is provided', () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;
    const fetcher = createProxiedFetch('   ', mockFetch);
    expect(fetcher).toBe(mockFetch);
  });

  it('resolves proxy URL from various environment formats', () => {
    expect(
      resolveResidentialProxyUrl({ RESIDENTIAL_PROXY_URL: 'http://100.113.106.39:3128' }),
    ).toBe('http://100.113.106.39:3128');

    expect(
      resolveResidentialProxyUrl({ SENATE_PROXY_URL: 'http://100.113.106.39:8080' }),
    ).toBe('http://100.113.106.39:8080');

    expect(
      resolveResidentialProxyUrl({
        RESIDENTIAL_PROXY_URL: 'http://100.113.106.39:3128',
        SENATE_PROXY_URL: 'http://other:8080',
      }),
    ).toBe('http://100.113.106.39:3128');
  });

  it('returns undefined if no proxy url is set', () => {
    expect(resolveResidentialProxyUrl({})).toBeUndefined();
  });
});
