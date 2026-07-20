// =============================================================================
// congress-trading-shared — STOCK Act disclosure amount brackets
// =============================================================================

/** A single STOCK Act amount bracket in whole USD. `max === null` => open-ended top tier. */
export interface AmountBracket {
  min: number;
  max: number | null;
}

/**
 * The canonical STOCK Act bracket set (ascending). The final tier ($50,000,001+)
 * is open-ended and represented with max === null.
 */
export const STOCK_ACT_BRACKETS: readonly AmountBracket[] = Object.freeze([
  Object.freeze({ min: 1_001, max: 15_000 }),
  Object.freeze({ min: 15_001, max: 50_000 }),
  Object.freeze({ min: 50_001, max: 100_000 }),
  Object.freeze({ min: 100_001, max: 250_000 }),
  Object.freeze({ min: 250_001, max: 500_000 }),
  Object.freeze({ min: 500_001, max: 1_000_000 }),
  Object.freeze({ min: 1_000_001, max: 5_000_000 }),
  Object.freeze({ min: 5_000_001, max: 25_000_000 }),
  Object.freeze({ min: 25_000_001, max: 50_000_000 }),
  Object.freeze({ min: 50_000_001, max: null }),
]);

/**
 * Return the canonical bracket exactly matching the provided bounds, or null if
 * the pair is not a valid STOCK Act bracket. `max` may be null (open top tier).
 */
export function matchBracket(min: number, max: number | null): AmountBracket | null {
  for (const b of STOCK_ACT_BRACKETS) {
    if (b.min === min && b.max === max) return b;
  }
  return null;
}

/** True iff [min,max] is one of the canonical STOCK Act brackets. */
export function isValidBracket(min: number, max: number | null): boolean {
  return matchBracket(min, max) !== null;
}

/**
 * Snap an arbitrary [min,max] guess to the closest containing canonical bracket.
 * Useful when an extractor produces near-but-not-exact bounds. Returns null when
 * nothing plausibly contains the range.
 */
export function nearestBracket(min: number, max: number | null): AmountBracket | null {
  if (!Number.isFinite(min) || min < 0) return null;
  if (max !== null && (!Number.isFinite(max) || max < min)) return null;

  const last = STOCK_ACT_BRACKETS[STOCK_ACT_BRACKETS.length - 1];
  if (max === null) {
    // A null maximum means an open-ended range, not an unknown single point.
    // Accept the common "$50,000,000+" spelling one dollar below the canonical
    // $50,000,001 lower bound, but never collapse another open range into a
    // finite bracket.
    return min >= last.min - 1 ? last : null;
  }

  const lo = min;
  for (const b of STOCK_ACT_BRACKETS) {
    const top = b.max ?? Number.POSITIVE_INFINITY;
    if (lo >= b.min && lo <= top && max >= b.min && max <= top) return b;
  }
  // Fall back to the open-ended top tier if the value is very large.
  if (lo >= last.min) return last;
  return null;
}
