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
    expect(
      resolveResidentialProxyUrl({
        RESIDENTIAL_PROXY_HOST: 'proxy.internal',
        RESIDENTIAL_PROXY_PORT: '8888',
        RESIDENTIAL_PROXY_USERNAME: 'user1',
        RESIDENTIAL_PROXY_PASSWORD: 'pass word',
      }),
    ).toBe('http://user1:pass%20word@proxy.internal:8888');

    expect(
      resolveResidentialProxyUrl({
        RESIDENTIAL_PROXY_HOST: 'proxy.internal',
        RESIDENTIAL_PROXY_PORT: 8080,
      }),
    ).toBe('http://proxy.internal:8080');
  });

  it('returns undefined if no proxy url or host is set', () => {
    expect(resolveResidentialProxyUrl({})).toBeUndefined();
    expect(resolveResidentialProxyUrl({ RESIDENTIAL_PROXY_PORT: '8888' })).toBeUndefined();
  });
});
