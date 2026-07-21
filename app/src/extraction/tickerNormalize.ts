/**
 * src/extraction/tickerNormalize.ts
 * OWNER: extraction
 *
 * Deterministic, $0 ticker normalization used as a FALLBACK when the
 * securities_master resolver can't find an exact symbol / alias / name match.
 *
 * Implementation lives in `@jaywedgeworth22/congress-trading-shared` so App A
 * and App B share one ticker-normalization contract. This module re-exports
 * the shared helpers for local import paths used throughout extraction.
 *
 * Why this exists: `unresolved_ticker` is the dominant review-queue reason
 * (~90% of the live queue) — but the vision read is almost always correct. The
 * gap is downstream: securities_master is well-populated (~10k symbols) yet
 *   (a) carries NO aliases (the alias table is empty in prod),
 *   (b) doesn't list preferred / depositary series symbols (e.g. "T$A",
 *       "JPM^J", "JPM-PJ"),
 *   (c) stores a single punctuation form for class shares ("BRK-B", not
 *       "BRK.B" / "BRKB"), and
 *   (d) is missing a long tail of perfectly valid current symbols
 *       (single-letter like "K"/"BK", OTC/ADRs like "NSRGY"/"NTDOF", and
 *       recent listings) — and a well-formed symbol that simply isn't in our
 *       master list should NOT be penalized into review.
 *
 * Resolution tiers (most → least confident); every function here is pure:
 *   1. preferred/depositary variants: "T$A" → "T^A",
 *      "JPM-PJ" / "JPM.PRJ" → "JPM^J".
 *   2. punctuation variants: "BRK.B" ↔ "BRK-B" ↔ "BRKB".
 *   3. curated stale → current alias map (delistings / renames / M&A).
 *   4. syntactic acceptance: a *well-formed* symbol absent from the master is
 *      accepted as-is; a malformed / header-contaminated string is rejected so
 *      it still flags `unresolved_ticker` and routes to human review.
 */

export {
  WELL_FORMED_TICKER,
  isPlaceholderTicker,
  stripPreferredSeries,
  normalizePreferredTickerVariant,
  resolvePreferredTickerFromAssetName,
  punctuationVariants,
  isWellFormedTicker,
  resolveTickerDeterministic,
  resolveContinuousTicker,
} from '@jaywedgeworth22/congress-trading-shared';
