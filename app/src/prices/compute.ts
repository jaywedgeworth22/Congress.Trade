/**
 * src/prices/compute.ts
 * OWNER: prices
 *
 * Pure price/performance math: percent change, the asset-vs-S&P performance
 * triple, and the nearest-prior-trading-day lookup over a descending close
 * series (handles weekends/holidays). All deterministic — unit-tested without
 * network or DB.
 */

export interface Close {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface Performance {
  /** (current - atTrade) / atTrade, or null when inputs are missing. */
  assetReturn: number | null;
  /** S&P 500 return over the same window, or null. */
  spxReturn: number | null;
  /** assetReturn - spxReturn (excess vs the market), or null. */
  excessReturn: number | null;
}

/** Fractional change from→to (e.g. 0.18 = +18%). null for missing/≤0 base. */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return (to - from) / from;
}

/** Asset return, S&P return, and excess return from the four price anchors. */
export function computePerformance(
  priceAtTrade: number | null,
  currentPrice: number | null,
  spxAtTrade: number | null,
  currentSpx: number | null,
): Performance {
  const assetReturn = pctChange(priceAtTrade, currentPrice);
  const spxReturn = pctChange(spxAtTrade, currentSpx);
  const excessReturn = assetReturn != null && spxReturn != null ? assetReturn - spxReturn : null;
  return { assetReturn, spxReturn, excessReturn };
}

/**
 * Close on the nearest trading day on or before `date`. `rowsDesc` must be sorted
 * by date descending. Returns null when `date` precedes all available history.
 */
export function nearestClose(rowsDesc: Close[], date: string): number | null {
  for (const r of rowsDesc) {
    if (r.date <= date) return r.close;
  }
  return null;
}
