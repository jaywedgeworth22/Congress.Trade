import { describe, expect, it } from 'vitest';
import { generateTradeHash, extractLastName } from '../tradeLatency.ts';

describe('tradeLatency', () => {
  describe('extractLastName', () => {
    it('extracts last name', () => {
      expect(extractLastName('Ro Khanna')).toBe('khanna');
      expect(extractLastName('Pelosi, Nancy')).toBe('pelosi');
      expect(extractLastName('Donald J. Trump')).toBe('trump');
      expect(extractLastName('Tuberville, Tommy')).toBe('tuberville');
    });
  });

  describe('generateTradeHash', () => {
    it('generates deterministic hash', () => {
      const hash1 = generateTradeHash('Ro Khanna', 'AAPL', '2026-07-24', 'buy');
      const hash2 = generateTradeHash('Khanna, Ro', 'AAPL', '2026-07-24', 'purchase');
      expect(hash1).toBe(hash2);
    });
  });
});
