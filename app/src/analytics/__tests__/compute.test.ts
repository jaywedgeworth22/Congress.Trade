/**
 * src/analytics/__tests__/compute.test.ts
 *
 * Unit tests for the pure analytics post-processing helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateMemberPerformance,
  bracketMidpoint,
  lagBucket,
  netSentiment,
  percentileFromHistogram,
  round,
  summarizeLag,
  topPerGroup,
  type LagRow,
  type MemberPerfRow,
} from '../compute';

describe('bracketMidpoint', () => {
  it('returns the midpoint of a closed bracket', () => {
    expect(bracketMidpoint(1001, 15000)).toBe(8000.5);
    expect(bracketMidpoint(15001, 50000)).toBe(32500.5);
  });
  it('falls back to the floor for the open top tier (max == null)', () => {
    expect(bracketMidpoint(50000001, null)).toBe(50000001);
  });
  it('returns 0 when the amount is entirely missing', () => {
    expect(bracketMidpoint(null, null)).toBe(0);
  });
});

describe('netSentiment', () => {
  it('is the buy share of directional activity', () => {
    expect(netSentiment(3, 1)).toBe(0.75);
    expect(netSentiment(0, 4)).toBe(0);
    expect(netSentiment(5, 0)).toBe(1);
  });
  it('is null when there is no directional activity', () => {
    expect(netSentiment(0, 0)).toBeNull();
  });
});

describe('round', () => {
  it('rounds to the requested precision', () => {
    expect(round(0.123456, 2)).toBe(0.12);
    expect(round(0.125, 2)).toBe(0.13);
    expect(round(1234.5)).toBe(1234.5);
  });
});

describe('lagBucket', () => {
  it('assigns days to the right display bucket', () => {
    expect(lagBucket(0)).toBe('0–7d');
    expect(lagBucket(7)).toBe('0–7d');
    expect(lagBucket(8)).toBe('8–14d');
    expect(lagBucket(30)).toBe('15–30d');
    expect(lagBucket(45)).toBe('31–45d');
    expect(lagBucket(60)).toBe('46–60d');
    expect(lagBucket(900)).toBe('60d+');
  });
});

describe('percentileFromHistogram', () => {
  const rows: LagRow[] = [
    { lagDays: 1, count: 10 },
    { lagDays: 10, count: 10 },
    { lagDays: 100, count: 10 },
  ];
  it('computes weighted percentiles', () => {
    expect(percentileFromHistogram(rows, 50)).toBe(10);
    expect(percentileFromHistogram(rows, 90)).toBe(100);
    expect(percentileFromHistogram(rows, 0)).toBe(1);
  });
  it('returns null for an empty histogram', () => {
    expect(percentileFromHistogram([], 50)).toBeNull();
    expect(percentileFromHistogram([{ lagDays: 5, count: 0 }], 50)).toBeNull();
  });
});

describe('summarizeLag', () => {
  it('summarizes count, median, p90, over-45 share, and buckets', () => {
    const rows: LagRow[] = [
      { lagDays: 3, count: 5 }, // 0–7d
      { lagDays: 12, count: 3 }, // 8–14d
      { lagDays: 50, count: 2 }, // 46–60d, also > 45
    ];
    const s = summarizeLag(rows);
    expect(s.count).toBe(10);
    expect(s.medianLagDays).toBe(3);
    expect(s.overFortyFivePct).toBe(0.2);
    const byBucket = Object.fromEntries(s.distribution.map((d) => [d.bucket, d.count]));
    expect(byBucket['0–7d']).toBe(5);
    expect(byBucket['8–14d']).toBe(3);
    expect(byBucket['46–60d']).toBe(2);
    // every fixed bucket is present (zero-filled)
    expect(s.distribution).toHaveLength(6);
  });
  it('handles an empty histogram with null stats', () => {
    const s = summarizeLag([]);
    expect(s.count).toBe(0);
    expect(s.medianLagDays).toBeNull();
    expect(s.overFortyFivePct).toBeNull();
    expect(s.distribution.every((d) => d.count === 0)).toBe(true);
  });
});

describe('topPerGroup', () => {
  it('keeps the first n items per group key in input order', () => {
    const items = [
      { k: 'a', v: 1 },
      { k: 'a', v: 2 },
      { k: 'a', v: 3 },
      { k: 'b', v: 9 },
    ];
    const out = topPerGroup(items, (x) => x.k, 2);
    expect(out.get('a')!.map((x) => x.v)).toEqual([1, 2]);
    expect(out.get('b')!.map((x) => x.v)).toEqual([9]);
  });
});

describe('aggregateMemberPerformance', () => {
  const row = (over: Partial<MemberPerfRow> = {}): MemberPerfRow => ({
    isOption: false,
    priceAtTrade: 100,
    currentPrice: 120,
    spxAtTrade: 100,
    ...over,
  });

  it('returns all-null stats for an empty / unpriced set', () => {
    const empty = aggregateMemberPerformance([], 110);
    expect(empty).toMatchObject({
      tradeCount: 0,
      scoredCount: 0,
      winRate: null,
      medianReturn: null,
      medianExcess: null,
    });
    // Rows present but no usable price anchors -> counted but not scored.
    const unpriced = aggregateMemberPerformance(
      [row({ priceAtTrade: null }), row({ currentPrice: null })],
      110,
    );
    expect(unpriced.tradeCount).toBe(2);
    expect(unpriced.scoredCount).toBe(0);
    expect(unpriced.medianReturn).toBeNull();
  });

  it('excludes options from the scored set but counts them in tradeCount', () => {
    const out = aggregateMemberPerformance([row(), row({ isOption: true })], 100);
    expect(out.tradeCount).toBe(2);
    expect(out.scoredCount).toBe(1);
  });

  it('computes return, alpha vs S&P, and win-rate as fractions', () => {
    // S&P flat (100->100) so excess == asset return for both trades.
    // Trade A: stock +20% (100->120) => excess +0.20 (win)
    // Trade B: stock -10% (200->180) => excess -0.10 (loss)
    const out = aggregateMemberPerformance(
      [
        row({ priceAtTrade: 100, currentPrice: 120, spxAtTrade: 100 }),
        row({ priceAtTrade: 200, currentPrice: 180, spxAtTrade: 100 }),
      ],
      100,
    );
    expect(out.scoredCount).toBe(2);
    expect(out.medianReturn).toBeCloseTo(0.05, 5); // median of +0.20 and -0.10
    expect(out.winRate).toBeCloseTo(0.5, 5); // 1 of 2 beat the market
    expect(out.medianExcess).toBeCloseTo(0.05, 5); // median of +0.20 and -0.10
  });

  it('leaves excess null (but still scores the return) when no S&P anchor exists', () => {
    const out = aggregateMemberPerformance([row({ spxAtTrade: null })], null);
    expect(out.scoredCount).toBe(1);
    expect(out.medianReturn).toBeCloseTo(0.2, 5);
    expect(out.winRate).toBeNull();
    expect(out.medianExcess).toBeNull();
  });
});
