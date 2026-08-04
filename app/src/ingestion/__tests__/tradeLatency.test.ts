import { describe, expect, it } from 'vitest';
import {
  generateTradeHash,
  extractLastName,
  normalizeTradeSide,
  matchDisclosureCandidate,
} from '../tradeLatency.ts';

describe('tradeLatency', () => {
  describe('extractLastName', () => {
    it('extracts last name', () => {
      expect(extractLastName('Ro Khanna')).toBe('khanna');
      expect(extractLastName('Pelosi, Nancy')).toBe('pelosi');
      expect(extractLastName('Donald J. Trump')).toBe('trump');
      expect(extractLastName('Tuberville, Tommy')).toBe('tuberville');
    });
  });

  describe('normalizeTradeSide', () => {
    it('maps CT P/S/E codes and provider prose to buy/sell/exchange', () => {
      expect(normalizeTradeSide('P')).toBe('buy');
      expect(normalizeTradeSide('S')).toBe('sell');
      expect(normalizeTradeSide('E')).toBe('exchange');
      expect(normalizeTradeSide('purchase')).toBe('buy');
      expect(normalizeTradeSide('Sale')).toBe('sell');
      expect(normalizeTradeSide('buy')).toBe('buy');
      expect(normalizeTradeSide(null)).toBe('exchange');
    });
  });

  describe('generateTradeHash', () => {
    it('generates deterministic hash across name/type variants', () => {
      const hash1 = generateTradeHash('Ro Khanna', 'AAPL', '2026-07-24', 'buy');
      const hash2 = generateTradeHash('Khanna, Ro', 'AAPL', '2026-07-24', 'purchase');
      const hash3 = generateTradeHash('Ro Khanna', 'AAPL', '2026-07-24', 'P');
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);
      expect(hash1).toBe('khanna_AAPL_2026-07-24_buy');
    });

    it('maps sale codes to sell', () => {
      expect(generateTradeHash('Kevin Hern', 'DVN', '2024-06-28', 'S')).toBe(
        generateTradeHash('Hern, Kevin', 'DVN', '2024-06-28', 'Sale'),
      );
    });
  });

  describe('matchDisclosureCandidate', () => {
    it('matches exact trade hashes as trade-hash', () => {
      const hash = generateTradeHash('Debbie Dingell', 'HONAV', '2026-06-29', 'exchange');
      const m = matchDisclosureCandidate(
        { trade_hash: hash },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k1',
          tradeHash: hash,
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Debbie Dingell',
          providerPublishedAt: null,
        },
      );
      expect(m).toEqual({ providerKey: 'k1', matchMethod: 'trade-hash' });
    });

    it('fuzzy-matches when provider date is empty but filer/ticker/side agree', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'sessions_ARCC_2026-07-24_sell' },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k2',
          tradeHash: 'sessions_ARCC__sell',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Pete Sessions',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-missing-date');
    });
  });
});
