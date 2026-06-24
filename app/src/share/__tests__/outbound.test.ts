import { describe, it, expect, vi } from 'vitest';
import { shareWithPeer } from '../outbound';
import type { Env } from '../../shared/types';
import type { SecurityRef } from '../../enrichment/types';

const ref = (ticker: string): SecurityRef => ({
  ticker, companyName: ticker + ' Inc', sector: 'Technology', industry: null, assetClass: 'equity',
  isEtf: false, isAdr: false, country: 'US', stateHq: null, stateOfIncorp: null, exchange: null,
  exchangeShort: 'NASDAQ', currency: 'USD', marketCap: 1e12, marketCapBucket: 'mega', ipoDate: null,
  cik: null, sicCode: null, sicDescription: null, source: 'fmp',
});
const env = (over: Record<string, unknown> = {}): Env => over as unknown as Env;
const delta = { refs: [ref('AAPL')], prices: [{ ticker: 'AAPL', closes: [{ date: '2026-06-23', close: 294.3 }], currentPrice: 294.3, currentPriceDate: '2026-06-23' }], spx: [{ date: '2026-06-23', close: 733.58 }] };

describe('shareWithPeer', () => {
  it('no-ops when the peer is not configured', async () => {
    const res = await shareWithPeer(env(), delta, (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    expect(res).toEqual({ sent: false, reason: 'peer not configured' });
  });

  it('no-ops when there is nothing to share (avoids empty POSTs)', async () => {
    const res = await shareWithPeer(
      env({ APP_B_IMPORT_URL: 'https://b/import', APP_B_INGEST_TOKEN: 't' }),
      { refs: [], prices: [], spx: [] },
      (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('nothing to share');
  });

  it('POSTs the mapped delta with the bearer token and reports counts', async () => {
    const spy = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://b/import');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
      const body = JSON.parse(init.body as string);
      expect(body.refs[0]).toMatchObject({ ticker: 'AAPL', sector: 'Technology', marketCap: 1e12 });
      expect(body.refs[0].marketCapBucket).toBeUndefined(); // import recomputes the bucket itself
      expect(body.prices[0].closes[0]).toEqual({ date: '2026-06-23', close: 294.3 });
      expect(body.spx[0]).toEqual({ date: '2026-06-23', close: 733.58 });
      return new Response('{"ok":true}', { status: 200 });
    });
    const res = await shareWithPeer(
      env({ APP_B_IMPORT_URL: 'https://b/import', APP_B_INGEST_TOKEN: 'tok' }),
      delta,
      spy as unknown as typeof fetch,
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(res).toEqual({ sent: true, status: 200, counts: { refs: 1, prices: 1, spx: 1 } });
  });

  it('reports a failed peer import without throwing', async () => {
    const res = await shareWithPeer(
      env({ APP_B_IMPORT_URL: 'https://b/import', APP_B_INGEST_TOKEN: 'tok' }),
      delta,
      (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    );
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/HTTP 401/);
  });
});
