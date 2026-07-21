import { describe, it, expect } from 'vitest';
import {
  parseMassiveTicker,
  parseFinnhubProfile,
  parseTwelveDataProfile,
  parseIntrinioCompany,
  parseTiingoTicker,
  buildMassiveProvider,
  buildTiingoProvider,
} from '../providers.ts';

const fetchWith = (status: number, body: unknown = '') =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('parseMassiveTicker (Polygon)', () => {
  it('maps SIC→sector, market cap, logo, and ETF type', () => {
    const ref = parseMassiveTicker({
      results: {
        ticker: 'AAPL', name: 'Apple Inc.', market_cap: 4.377e12, type: 'CS',
        sic_code: '3571', sic_description: 'ELECTRONIC COMPUTERS', primary_exchange: 'XNAS',
        currency_name: 'usd', locale: 'us', cik: '0000320193',
        weighted_shares_outstanding: 15_000_000_000, share_class_shares_outstanding: 14_900_000_000,
        branding: { icon_url: 'https://api.massive.com/v1/.../icon.png' },
      },
    });
    expect(ref?.companyName).toBe('Apple Inc.');
    expect(ref?.sector).toBe('Manufacturing'); // SIC 3571 → Manufacturing division
    expect(ref?.marketCap).toBe(4.377e12);
    expect(ref?.marketCapBucket).toBe('mega');
    expect(ref?.sharesOutstanding).toBe(15_000_000_000); // prefers the weighted figure
    expect(ref?.isEtf).toBe(false);
    expect(ref?.source).toBe('massive');
  });
  it('flags ETFs from the type field', () => {
    const ref = parseMassiveTicker({ results: { ticker: 'SPY', name: 'SPDR S&P 500', type: 'ETF' } });
    expect(ref?.isEtf).toBe(true);
    expect(ref?.assetClass).toBe('etf');
  });
  it('returns null on an empty / error body', () => {
    expect(parseMassiveTicker({ status: 'NOT_AUTHORIZED' })).toBeNull();
    expect(parseMassiveTicker(null)).toBeNull();
  });
});

describe('parseFinnhubProfile', () => {
  it('converts market cap from millions and keeps the CDN logo', () => {
    const ref = parseFinnhubProfile({
      name: 'Apple Inc', finnhubIndustry: 'Technology', marketCapitalization: 4322488,
      shareOutstanding: 14900, // millions
      exchange: 'NASDAQ NMS - GLOBAL MARKET', currency: 'USD', ipo: '1980-12-12',
      logo: 'https://static.finnhub.io/logo/87cb30d8.png',
    });
    expect(ref?.marketCap).toBe(4322488000000);
    expect(ref?.sector).toBe('Technology');
    expect(ref?.sharesOutstanding).toBe(14_900_000_000); // 14900M → shares
  });
  it('returns null without a name', () => expect(parseFinnhubProfile({})).toBeNull());
});

describe('parseTwelveDataProfile', () => {
  it('takes the clean sector + industry', () => {
    const ref = parseTwelveDataProfile({ name: 'Apple Inc.', sector: 'Technology', industry: 'Consumer Electronics', exchange: 'NASDAQ' });
    expect(ref?.sector).toBe('Technology');
    expect(ref?.industry).toBe('Consumer Electronics');
  });
  it('returns null on the API error envelope', () =>
    expect(parseTwelveDataProfile({ status: 'error', message: 'limit' })).toBeNull());
});

describe('parseIntrinioCompany', () => {
  it('falls back through sector → SIC → industry_category', () => {
    const ref = parseIntrinioCompany({ name: 'Apple Inc.', sic: '3571', industry_category: 'Computer Hardware', cik: '0000320193' });
    expect(ref?.companyName).toBe('Apple Inc.');
    expect(ref?.sector).toBe('Manufacturing'); // no top-level sector → SIC 3571
    expect(ref?.cik).toBe('0000320193');
  });
});

describe('parseTiingoTicker', () => {
  it('maps name + exchange (free tier has no sector/market cap)', () => {
    const ref = parseTiingoTicker({
      ticker: 'AAPL', name: 'Apple Inc', exchangeCode: 'NASDAQ',
      startDate: '1980-12-12', endDate: '2026-07-09', description: 'Apple Inc. designs…',
    });
    expect(ref?.companyName).toBe('Apple Inc');
    expect(ref?.exchangeShort).toBe('NASDAQ');
    expect(ref?.source).toBe('tiingo');
    expect(ref?.sector).toBeUndefined();
  });
  it('returns null without a name', () => expect(parseTiingoTicker({})).toBeNull());
  it('returns null on an empty / error body', () => {
    expect(parseTiingoTicker(null)).toBeNull();
    expect(parseTiingoTicker({ detail: 'Not Found.' })).toBeNull();
  });
});

describe('provider fetch wrapper fails soft', () => {
  it('returns null on non-OK (no throw) so the chain continues', async () => {
    expect(await buildMassiveProvider('k', fetchWith(429)).fetchRef('AAPL')).toBeNull();
    expect(await buildMassiveProvider('k', fetchWith(403)).fetchRef('AAPL')).toBeNull();
  });
  it('fetches a Tiingo ref on 200 and fails soft (no throw) on non-OK / missing key gating upstream', async () => {
    const ref = await buildTiingoProvider('k', fetchWith(200, { name: 'Apple Inc', exchangeCode: 'NASDAQ' })).fetchRef('AAPL');
    expect(ref?.companyName).toBe('Apple Inc');
    expect(await buildTiingoProvider('k', fetchWith(404, { detail: 'Not Found.' })).fetchRef('ZZZZ')).toBeNull();
    expect(await buildTiingoProvider('k', fetchWith(429)).fetchRef('AAPL')).toBeNull();
  });
});
