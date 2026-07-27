/**
 * src/delivery/__tests__/marketReads.test.ts
 *
 * Pure helpers behind the /market/* cache-read endpoints (reverse-direction
 * cross-app sharing): SQL range building and securities_ref row mapping.
 */
import { describe, it, expect } from 'vitest';
import { priceRangeQuery, mapSecurityRef } from '../rest.ts';

describe('priceRangeQuery', () => {
  it('price_eod without bounds caps at the LATEST 1000 rows, re-sorted ascending', () => {
    const q = priceRangeQuery('price_eod', 'AAPL');
    expect(q.sql).toBe(
      'SELECT date, close, volume FROM (SELECT date, close, volume FROM price_eod WHERE ticker = ? ORDER BY date DESC LIMIT 1000) ORDER BY date ASC',
    );
    expect(q.params).toEqual(['AAPL']);
  });

  it('spx_eod without bounds also caps at the latest 1000', () => {
    const q = priceRangeQuery('spx_eod', null);
    expect(q.sql).toBe(
      'SELECT date, close FROM (SELECT date, close FROM spx_eod ORDER BY date DESC LIMIT 1000) ORDER BY date ASC',
    );
    expect(q.params).toEqual([]);
  });

  it('applies inclusive from/to bounds (date-only) for a ticker', () => {
    const q = priceRangeQuery('price_eod', 'MSFT', '2025-01-01T00:00:00Z', '2025-06-30');
    expect(q.sql).toBe(
      'SELECT date, close, volume FROM price_eod WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date ASC',
    );
    expect(q.params).toEqual(['MSFT', '2025-01-01', '2025-06-30']);
  });

  it('spx_eod has no ticker predicate and no volume column', () => {
    const q = priceRangeQuery('spx_eod', null, '2025-01-01');
    expect(q.sql).toBe('SELECT date, close FROM spx_eod WHERE date >= ? ORDER BY date ASC');
    expect(q.params).toEqual(['2025-01-01']);
  });
});

describe('mapSecurityRef', () => {
  it('maps snake_case columns to the import camelCase shape (incl. bool coercion)', () => {
    const ref = mapSecurityRef({
      ticker: 'AAPL',
      company_name: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      asset_class: 'equity',
      is_etf: 0,
      is_adr: 1,
      country: 'US',
      state_hq: 'CA',
      state_of_incorp: 'DE',
      exchange: 'NASDAQ',
      exchange_short: 'NASDAQ',
      currency: 'USD',
      market_cap: 3.2e12,
      market_cap_bucket: 'mega',
      ipo_date: '1980-12-12',
      cik: '0000320193',
      sic_code: '3571',
      sic_description: 'Electronic Computers',
      source: 'fmp+sec',
      enriched_at: '2026-06-22T00:00:00Z',
      current_price: 210.1,
      current_price_date: '2026-06-20',
    });
    expect(ref.isEtf).toBe(false);
    expect(ref.isAdr).toBe(true);
    expect(ref.companyName).toBe('Apple Inc.');
    expect(ref.exchangeShort).toBe('NASDAQ');
    expect(ref.marketCap).toBe(3.2e12);
    expect(ref.currentPrice).toBe(210.1);
  });

  it('clamps invalid marketCapBucket to null to protect getRefs batch', () => {
    expect(mapSecurityRef(minimalRow({ market_cap_bucket: 'giant' })).marketCapBucket).toBeNull();
    expect(mapSecurityRef(minimalRow({ market_cap_bucket: 'MEGA' })).marketCapBucket).toBeNull();
    expect(mapSecurityRef(minimalRow({ market_cap_bucket: '' })).marketCapBucket).toBeNull();
    expect(mapSecurityRef(minimalRow({ market_cap_bucket: null })).marketCapBucket).toBeNull();
    expect(mapSecurityRef(minimalRow({ market_cap_bucket: undefined })).marketCapBucket).toBeNull();
    expect(mapSecurityRef(minimalRow({ market_cap_bucket: 'mid' })).marketCapBucket).toBe('mid');
    expect(mapSecurityRef(minimalRow({ market_cap_bucket: 'nano' })).marketCapBucket).toBe('nano');
  });

  it('clamps malformed currentPriceDate to null (YYYY-MM-DD guard)', () => {
    expect(mapSecurityRef(minimalRow({ current_price_date: 'not-a-date' })).currentPriceDate).toBeNull();
    expect(mapSecurityRef(minimalRow({ current_price_date: '2026/06/20' })).currentPriceDate).toBeNull();
    expect(mapSecurityRef(minimalRow({ current_price_date: '' })).currentPriceDate).toBeNull();
    expect(mapSecurityRef(minimalRow({ current_price_date: null })).currentPriceDate).toBeNull();
    expect(mapSecurityRef(minimalRow({ current_price_date: '2026-06-20' })).currentPriceDate).toBe('2026-06-20');
    expect(mapSecurityRef(minimalRow({ current_price_date: '2024-01-01' })).currentPriceDate).toBe('2024-01-01');
  });
});

function minimalRow(overrides: Record<string, unknown> = {}) {
  return {
    ticker: 'AAA',
    company_name: null, sector: null, industry: null, asset_class: null,
    is_etf: 0, is_adr: 0, country: null, state_hq: null, state_of_incorp: null,
    exchange: null, exchange_short: null, currency: null, market_cap: null,
    market_cap_bucket: null, ipo_date: null, cik: null, sic_code: null,
    sic_description: null, source: null, enriched_at: null,
    current_price: null, current_price_date: null,
    ...overrides,
  } as Parameters<typeof mapSecurityRef>[0];
}
