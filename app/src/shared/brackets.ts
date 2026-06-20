/**
 * src/shared/brackets.ts
 * STOCK Act disclosure amount brackets. Implemented (not a stub).
 *
 * Periodic Transaction Reports disclose trade values only as a bracket, not an
 * exact amount. This module is the canonical bracket set + matching helpers the
 * normalizer uses to validate extracted [min,max] pairs.
 */

/** A single STOCK Act amount bracket in whole USD. `max === null` => open-ended top tier. */
export interface AmountBracket {
  min: number;
  max: number | null;
}

/**
 * The canonical STOCK Act bracket set (ascending). The final tier ($50,000,001+)
 * is open-ended and represented with max === null.
 */
export const STOCK_ACT_BRACKETS: readonly AmountBracket[] = [
  { min: 1_001, max: 15_000 },
  { min: 15_001, max: 50_000 },
  { min: 50_001, max: 100_000 },
  { min: 100_001, max: 250_000 },
  { min: 250_001, max: 500_000 },
  { min: 500_001, max: 1_000_000 },
  { min: 1_000_001, max: 5_000_000 },
  { min: 5_000_001, max: 25_000_000 },
  { min: 25_000_001, max: 50_000_000 },
  { min: 50_000_001, max: null },
] as const;

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
 * nothing plausibly contains the range. Implemented best-effort; the normalizer
 * decides whether to trust or route to review.
 */
export function nearestBracket(min: number, max: number | null): AmountBracket | null {
  const lo = Number.isFinite(min) ? min : 0;
  for (const b of STOCK_ACT_BRACKETS) {
    const top = b.max ?? Number.POSITIVE_INFINITY;
    const candidateMax = max ?? lo;
    if (lo >= b.min && candidateMax <= top) return b;
  }
  // Fall back to the open-ended top tier if the value is very large.
  const last = STOCK_ACT_BRACKETS[STOCK_ACT_BRACKETS.length - 1];
  if (lo >= last.min) return last;
  return null;
}
