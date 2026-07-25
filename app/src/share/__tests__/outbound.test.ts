import { describe, it, expect, vi } from 'vitest';
import { shareWithPeer } from '../outbound.ts';
import type { Env } from '../../shared/types.ts';
import type { SecurityRef } from '../../enrichment/types.ts';

const ref = (ticker: string): SecurityRef => ({
  ticker, companyName: ticker + ' Inc', sector: 'Technology', industry: null, assetClass: 'equity',
  isEtf: false, isAdr: false, country: 'US', stateHq: null, stateOfIncorp: null, exchange: null,
  exchangeShort: 'NASDAQ', currency: 'USD', marketCap: 1e12, marketCapBucket: 'mega',
  sharesOutstanding: 4e9, ipoDate: null,
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
      expect(body.refs[0]).toMatchObject({ ticker: 'AAPL', sector: 'Technology', marketCap: 1e12, sharesOutstanding: 4e9 });
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
    expect(res).toEqual({ sent: true, status: 200, counts: { refs: 1, prices: 1, spx: 1, trades: 0 } });
  });

  it('POSTs trade events with source provenance and ISO 8601 timestamps', async () => {
    const tradePayload = {
      trades: [
        {
          docId: 'H-2026-20024100',
          chamber: 'house' as const,
          source: 'house_clerk',
          sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdf/2026/20024100.pdf',
          filerName: 'Nancy Pelosi',
          ticker: 'NVDA',
          txType: 'P',
          transactionDate: '2026-07-15',
          transactionTimestamp: '2026-07-15T00:00:00Z',
          disclosureDate: '2026-07-22',
          disclosureTimestamp: '2026-07-22T14:30:00Z',
          extractedTimestamp: '2026-07-22T14:31:05Z',
          amountMin: 1000001,
          amountMax: 5000000,
        },
      ],
    };
    const spy = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.trades[0]).toMatchObject({
        docId: 'H-2026-20024100',
        chamber: 'house',
        source: 'house_clerk',
        sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdf/2026/20024100.pdf',
        ticker: 'NVDA',
        disclosureTimestamp: '2026-07-22T14:30:00Z',
      });
      return new Response('{"ok":true}', { status: 200 });
    });
    const res = await shareWithPeer(
      env({ APP_B_IMPORT_URL: 'https://b/import', APP_B_INGEST_TOKEN: 'tok' }),
      tradePayload,
      spy as unknown as typeof fetch,
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(res).toEqual({ sent: true, status: 200, counts: { refs: 0, prices: 0, spx: 0, trades: 1 } });
  });

  it('rejects invalid shared payloads before POSTing', async () => {
    const spy = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const res = await shareWithPeer(
      env({ APP_B_IMPORT_URL: 'https://b/import', APP_B_INGEST_TOKEN: 'tok' }),
      { spx: [{ date: '2026-02-31', close: 1 }] },
      spy as unknown as typeof fetch,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/invalid shared payload/);
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
