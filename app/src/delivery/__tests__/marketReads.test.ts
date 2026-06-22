/**
 * src/delivery/__tests__/marketReads.test.ts
 *
 * Pure helpers behind the /market/* cache-read endpoints (reverse-direction
 * cross-app sharing): SQL range building and securities_ref row mapping.
 */
import { describe, it, expect } from 'vitest';
import { priceRangeQuery, mapSecurityRef } from '../rest';

describe('priceRangeQuery', () => {
  it('price_eod selects volume, requires the ticker, orders ascending', () => {
    const q = priceRangeQuery('price_eod', 'AAPL');
    expect(q.sql).toBe('SELECT date, close, volume FROM price_eod WHERE ticker = ? ORDER BY date ASC');
    expect(q.params).toEqual(['AAPL']);
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
});
