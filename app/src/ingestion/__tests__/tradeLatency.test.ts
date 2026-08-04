import { describe, expect, it } from 'vitest';
import {
  generateTradeHash,
  extractLastName,
  normalizeTradeSide,
  matchDisclosureCandidate,
  parseTradeHash,
  raceFirstSeenAt,
  LATENCY_MAX_CONCURRENT_DELTA_HOURS,
  LATENCY_SCORE_WINDOW_HOURS,
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

    it('fuzzy-matches when provider ticker is empty but filer/date/side agree', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'beyer_AAPL_2026-07-27_buy' },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k3',
          tradeHash: 'beyer__2026-07-27_buy',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Don Beyer',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-no-ticker');
    });
  });

  describe('parseTradeHash', () => {
    it('parses normal and empty-ticker hashes', () => {
      expect(parseTradeHash('himes_BAC_2026-07-20_sell')).toEqual({
        lastName: 'himes',
        ticker: 'BAC',
        date: '2026-07-20',
        side: 'sell',
      });
      expect(parseTradeHash('beyer__2026-07-27_buy')).toMatchObject({
        lastName: 'beyer',
        date: '2026-07-27',
        side: 'buy',
      });
    });
  });

  describe('raceFirstSeenAt', () => {
    it('uses now when first_seen is outside the score window', () => {
      const now = '2026-08-04T12:00:00.000Z';
      expect(raceFirstSeenAt('2024-01-01T00:00:00.000Z', now, 168)).toBe(now);
      expect(raceFirstSeenAt('2026-08-03T12:00:00.000Z', now, 168)).toBe('2026-08-03T12:00:00.000Z');
    });
  });

  describe('scoreboard constants', () => {
    it('keeps a 7-day window and 48h concurrent-race cap', () => {
      expect(LATENCY_SCORE_WINDOW_HOURS).toBe(336);
      expect(LATENCY_MAX_CONCURRENT_DELTA_HOURS).toBe(48);
    });
  });
});
