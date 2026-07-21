/**
 * src/prices/__tests__/prices.test.ts
 *
 * Unit tests for the pure price/performance core + the FMP EOD parser.
 */

import { describe, it, expect } from 'vitest';
import { pctChange, computePerformance, nearestClose, type Close } from '../compute.ts';
import { parseEodHistory } from '../fmp.ts';

describe('pctChange', () => {
  it('is the fractional change, or null for bad input', () => {
    expect(pctChange(100, 118)).toBeCloseTo(0.18, 6);
    expect(pctChange(100, 80)).toBeCloseTo(-0.2, 6);
    expect(pctChange(0, 50)).toBeNull();
    expect(pctChange(null, 50)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
  });
});

describe('computePerformance', () => {
  it('computes asset, S&P, and excess returns', () => {
    const p = computePerformance(100, 118, 1000, 1050);
    expect(p.assetReturn).toBeCloseTo(0.18, 6);
    expect(p.spxReturn).toBeCloseTo(0.05, 6);
    expect(p.excessReturn).toBeCloseTo(0.13, 6);
  });
  it('excess is null when either side is missing', () => {
    const p = computePerformance(100, 118, null, 1050);
    expect(p.assetReturn).toBeCloseTo(0.18, 6);
    expect(p.spxReturn).toBeNull();
    expect(p.excessReturn).toBeNull();
  });
});

describe('nearestClose', () => {
  const rows: Close[] = [
    { date: '2026-06-15', close: 210 },
    { date: '2026-06-12', close: 205 }, // Fri before a weekend trade
    { date: '2026-06-11', close: 204 },
  ];
  it('returns the close on or before the target (weekend/holiday safe)', () => {
    expect(nearestClose(rows, '2026-06-15')).toBe(210);
    expect(nearestClose(rows, '2026-06-14')).toBe(205); // Sun → prior Fri
    expect(nearestClose(rows, '2026-06-13')).toBe(205);
  });
  it('is null before all history', () => {
    expect(nearestClose(rows, '2026-06-01')).toBeNull();
  });
});

describe('parseEodHistory', () => {
  it('parses the v3 full shape, prefers adjClose, sorts descending', () => {
    const out = parseEodHistory({
      symbol: 'AAPL',
      historical: [
        { date: '2026-06-11', adjClose: 204, close: 203 },
        { date: '2026-06-15', adjClose: 210, close: 209 },
      ],
    });
    expect(out.map((c) => c.date)).toEqual(['2026-06-15', '2026-06-11']);
    expect(out[0].close).toBe(210); // adjClose preferred
  });
  it('parses the stable light array shape and skips malformed rows', () => {
    const out = parseEodHistory([
      { date: '2026-06-15', close: 210 },
      { date: null, close: 1 },
      { date: '2026-06-12' },
    ]);
    expect(out).toEqual([{ date: '2026-06-15', close: 210 }]);
  });
  it('returns [] for unknown shapes', () => {
    expect(parseEodHistory({})).toEqual([]);
    expect(parseEodHistory(null)).toEqual([]);
  });
});
