import { describe, it, expect } from 'vitest';
import { buildPeerPriceClient } from '../peer.ts';

const DUMMY_TOKEN = 'test-dummy-token';

/** Fetch mock that records each (url, init) call and replies 200 with closes. */
const recordingFetch = (calls: Array<{ url: string; init?: RequestInit }>) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ closes: [{ date: '2024-01-02', close: 10 }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;

describe('buildPeerPriceClient — bearer auth', () => {
  it('sends authorization: Bearer on the prices endpoint when a token is provided', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = buildPeerPriceClient('https://peer.example', recordingFetch(calls), DUMMY_TOKEN);
    const closes = await client.eodHistory('AAPL', '2024-01-01', '2024-02-01');
    expect(closes).toEqual([{ date: '2024-01-02', close: 10 }]);
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0].init)['authorization']).toBe(`Bearer ${DUMMY_TOKEN}`);
  });

  it('sends authorization: Bearer on the spx endpoint when a token is provided', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = buildPeerPriceClient('https://peer.example', recordingFetch(calls), DUMMY_TOKEN);
    await client.spxHistory('2024-01-01', '2024-02-01');
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0].init)['authorization']).toBe(`Bearer ${DUMMY_TOKEN}`);
  });

  it('omits the authorization header when no token is provided', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = buildPeerPriceClient('https://peer.example', recordingFetch(calls));
    await client.eodHistory('AAPL', '2024-01-01', '2024-02-01');
    await client.spxHistory('2024-01-01', '2024-02-01');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = headersOf(call.init);
      expect(headers['authorization']).toBeUndefined();
      expect(headers['user-agent']).toContain('congress.trade');
    }
  });

  it('still returns [] on error responses (fallback preserved) with a token set', async () => {
    const unauthorized = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const client = buildPeerPriceClient('https://peer.example', unauthorized, DUMMY_TOKEN);
    expect(await client.eodHistory('AAPL', '2024-01-01', '2024-02-01')).toEqual([]);
  });
});
