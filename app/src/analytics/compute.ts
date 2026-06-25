/**
 * src/analytics/compute.ts
 * OWNER: analytics
 *
 * Pure post-processing helpers for the analytics layer: the bracket-midpoint
 * math (the TypeScript mirror of BRACKET_MIDPOINT_SQL), buy/sell sentiment, and
 * the filing-lag distribution summary (SQLite has no percentile function, so we
 * compute median / p90 in the Worker from a returned histogram). All functions
 * are pure + deterministic so they unit-test without a database.
 */

import { computePerformance } from '../prices/compute';

/**
 * Estimated dollar value of one STOCK Act bracket. Mirror of
 * BRACKET_MIDPOINT_SQL: midpoint of [min,max]; open top tier (max == null) →
 * floor (min); missing amount → 0.
 */
export function bracketMidpoint(min: number | null, max: number | null): number {
  if (max != null && min != null) return (min + max) / 2;
  if (min != null) return min; // open-ended top tier ($50M+) or max missing
  return 0;
}

/**
 * Buy/sell sentiment in [0,1]: share of directional (P+S) activity that is
 * buying. 1 = all buys, 0 = all sells, 0.5 = balanced. null when there is no
 * directional activity (avoids a divide-by-zero that would read as "all sells").
 */
export function netSentiment(buys: number, sells: number): number | null {
  const total = buys + sells;
  if (total <= 0) return null;
  return buys / total;
}

/** Round to `dp` decimal places (helper for stable JSON numbers). */
export function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Filing-lag distribution
// ---------------------------------------------------------------------------

/** Fixed buckets (in days) for the disclosure-lag histogram, in display order. */
export const LAG_BUCKETS: ReadonlyArray<{ label: string; max: number | null }> = [
  { label: '0–7d', max: 7 },
  { label: '8–14d', max: 14 },
  { label: '15–30d', max: 30 },
  { label: '31–45d', max: 45 },
  { label: '46–60d', max: 60 },
  { label: '60d+', max: null },
];

/** Assign a lag (in whole days) to its display bucket label. */
export function lagBucket(days: number): string {
  for (const b of LAG_BUCKETS) {
    if (b.max == null || days <= b.max) return b.label;
  }
  return LAG_BUCKETS[LAG_BUCKETS.length - 1].label;
}

export interface LagRow {
  lagDays: number;
  count: number;
}

export interface LagSummary {
  count: number;
  medianLagDays: number | null;
  p90LagDays: number | null;
  /** Fraction (0..1) of disclosures filed more than 45 days after the trade. */
  overFortyFivePct: number | null;
  distribution: Array<{ bucket: string; count: number }>;
}

/**
 * Weighted percentile (0..100) over a histogram of (value,count) pairs. Returns
 * the smallest value whose cumulative count reaches the percentile rank. null
 * for an empty histogram.
 */
export function percentileFromHistogram(rows: LagRow[], percentile: number): number | null {
  const sorted = rows
    .filter((r) => Number.isFinite(r.lagDays) && r.count > 0)
    .sort((a, b) => a.lagDays - b.lagDays);
  const total = sorted.reduce((s, r) => s + r.count, 0);
  if (total === 0) return null;
  const rank = (percentile / 100) * total;
  let cum = 0;
  for (const r of sorted) {
    cum += r.count;
    if (cum >= rank) return r.lagDays;
  }
  return sorted[sorted.length - 1].lagDays;
}

/**
 * Summarize a filing-lag histogram into count, median, p90, the share filed
 * after the 45-day STOCK Act deadline, and the fixed-bucket distribution.
 */
export function summarizeLag(rows: LagRow[]): LagSummary {
  const clean = rows.filter((r) => Number.isFinite(r.lagDays) && r.count > 0);
  const count = clean.reduce((s, r) => s + r.count, 0);
  const distribution = LAG_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }));
  const indexByLabel = new Map(distribution.map((d, i) => [d.bucket, i]));
  let over45 = 0;
  for (const r of clean) {
    const idx = indexByLabel.get(lagBucket(r.lagDays));
    if (idx != null) distribution[idx].count += r.count;
    if (r.lagDays > 45) over45 += r.count;
  }
  return {
    count,
    medianLagDays: percentileFromHistogram(clean, 50),
    p90LagDays: percentileFromHistogram(clean, 90),
    overFortyFivePct: count > 0 ? round(over45 / count, 4) : null,
    distribution,
  };
}

/**
 * Pick the top `n` items per group key from a flat list, preserving the list's
 * existing order within each group (callers pre-sort). Used to fold the
 * cluster-buy "members" follow-up query into per-cluster top-member lists.
 */
export function topPerGroup<T>(items: T[], keyOf: (x: T) => string, n: number): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const arr = out.get(k);
    if (arr) {
      if (arr.length < n) arr.push(item);
    } else {
      out.set(k, [item]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Member realized-performance aggregate ("skill" signal)
// ---------------------------------------------------------------------------

/** Median of a numeric list, or null when empty. */
function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** One trade's cached performance anchors (from tx_performance + securities_ref). */
export interface MemberPerfRow {
  isOption: boolean;
  priceAtTrade: number | null;
  currentPrice: number | null;
  spxAtTrade: number | null;
}

/**
 * Realized-performance aggregate for one member's trades. All return figures are
 * FRACTIONS (0.18 = +18%), matching computePerformance / the /performance
 * endpoint. `winRate` is the share (0..1) of scored trades that beat the S&P.
 *
 * This is the security's move SINCE the disclosed trade (the same basis as
 * /performance), not cost-basis P&L — for buys it reads as "did the pick go up,
 * and did it beat the market." Options and unpriced tickers are excluded from
 * the scored set so they don't dilute the stats.
 */
export interface MemberPerfSummary {
  tradeCount: number; // total trades in the window
  scoredCount: number; // trades with usable price anchors
  winRate: number | null; // share with positive excess return (0..1)
  medianReturn: number | null;
  medianExcess: number | null;
  avgReturn: number | null;
  avgExcess: number | null;
}

const mean = (nums: number[]): number | null =>
  nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length, 4) : null;

export function aggregateMemberPerformance(
  rows: MemberPerfRow[],
  currentSpx: number | null,
): MemberPerfSummary {
  const returns: number[] = [];
  const excesses: number[] = [];
  for (const r of rows) {
    if (r.isOption || r.priceAtTrade == null || r.currentPrice == null) continue;
    const perf = computePerformance(r.priceAtTrade, r.currentPrice, r.spxAtTrade, currentSpx);
    if (perf.assetReturn == null) continue;
    returns.push(perf.assetReturn);
    if (perf.excessReturn != null) excesses.push(perf.excessReturn);
  }
  const wins = excesses.filter((x) => x > 0).length;
  const med = (nums: number[]): number | null => {
    const m = median(nums);
    return m == null ? null : round(m, 4);
  };
  return {
    tradeCount: rows.length,
    scoredCount: returns.length,
    winRate: excesses.length ? round(wins / excesses.length, 4) : null,
    medianReturn: med(returns),
    medianExcess: med(excesses),
    avgReturn: mean(returns),
    avgExcess: mean(excesses),
  };
}
