import { describe, it, expect } from 'vitest';
import {
  parseMassiveTicker,
  parseFinnhubProfile,
  parseTwelveDataProfile,
  parseIntrinioCompany,
  buildMassiveProvider,
} from '../providers';

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
        branding: { icon_url: 'https://api.massive.com/v1/.../icon.png' },
      },
    });
    expect(ref?.companyName).toBe('Apple Inc.');
    expect(ref?.sector).toBe('Manufacturing'); // SIC 3571 → Manufacturing division
    expect(ref?.marketCap).toBe(4.377e12);
    expect(ref?.marketCapBucket).toBe('mega');
    expect(ref?.isEtf).toBe(false);
    expect(ref?.logoUrl).toContain('icon.png');
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
      exchange: 'NASDAQ NMS - GLOBAL MARKET', currency: 'USD', ipo: '1980-12-12',
      logo: 'https://static.finnhub.io/logo/87cb30d8.png',
    });
    expect(ref?.marketCap).toBe(4322488000000);
    expect(ref?.sector).toBe('Technology');
    expect(ref?.logoUrl).toContain('static.finnhub.io');
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

describe('provider fetch wrapper fails soft', () => {
  it('returns null on non-OK (no throw) so the chain continues', async () => {
    expect(await buildMassiveProvider('k', fetchWith(429)).fetchRef('AAPL')).toBeNull();
    expect(await buildMassiveProvider('k', fetchWith(403)).fetchRef('AAPL')).toBeNull();
  });
});
