/**
 * src/extraction/amounts.ts
 * OWNER: extraction agent
 *
 * Amount-range parsing shared by the HTML / text-PDF extractors and the
 * normalizer. STOCK Act PTRs disclose value as a bracket string such as
 * "$1,001 - $15,000" or "$50,000,001 +". This converts such strings to a
 * numeric [min, max] pair and snaps it onto the canonical bracket set in
 * src/shared/brackets.ts when possible.
 */

import { matchBracket, nearestBracket, STOCK_ACT_BRACKETS } from '../shared/brackets.ts';
import type { AmountBracket } from '../shared/brackets.ts';

export interface AmountRange {
  /** Lower bound in whole USD, or null when unparseable. */
  min: number | null;
  /** Upper bound in whole USD; null for the open-ended top tier OR unparseable. */
  max: number | null;
  /** True when [min,max] is exactly a canonical STOCK Act bracket. */
  exact: boolean;
}

/** Parse a single dollar token like "$1,001" / "1001" / "$50,000,001+" -> number. */
function parseDollar(token: string): number | null {
  const cleaned = token.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Parse a STOCK Act amount-range string into a numeric [min,max] pair.
 *
 * Handles:
 *   "$1,001 - $15,000"          -> { min:1001,  max:15000 }
 *   "$1,001 to $15,000"         -> { min:1001,  max:15000 }
 *   "$1,001–$15,000" (en dash)  -> { min:1001,  max:15000 }
 *   "$50,000,001 +"             -> { min:50000001, max:null } (open top tier)
 *   "Over $50,000,000"          -> snaps to open top tier
 *   ""/garbage                  -> { min:null, max:null }
 */
export function parseAmountRange(raw: string): AmountRange {
  const text = (raw || '').trim();
  if (!text) return { min: null, max: null, exact: false };

  // Open-ended top tier: "$50,000,001 +" / "$50,000,000+" / "Over $X".
  if (/\+\s*$/.test(text) || /\bover\b/i.test(text) || /\bgreater than\b/i.test(text)) {
    const nums = (text.match(/[\d,]+(?:\.\d+)?/g) ?? []).map((t) => parseDollar(t)).filter(isNum);
    const lo = nums.length ? Math.min(...nums) : null;
    if (lo !== null) {
      const snapped = snapToBracket(lo, null);
      return { min: snapped?.min ?? lo, max: snapped?.max ?? null, exact: snapped !== null };
    }
  }

  // Split on the range separator (hyphen, en/em dash, or the word "to").
  const parts = text
    .split(/\s*(?:-|–|—|to|through|–|—)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    const lo = parseDollar(parts[0]);
    const hi = parseDollar(parts[parts.length - 1]);
    if (lo !== null && hi !== null) {
      const exactB = matchBracket(lo, hi);
      if (exactB) return { min: exactB.min, max: exactB.max, exact: true };
      const snapped = snapToBracket(lo, hi);
      if (snapped) return { min: snapped.min, max: snapped.max, exact: true };
      return { min: lo, max: hi, exact: false };
    }
  }

  // Single value present — try to find the bracket whose min matches.
  const single = parseDollar(text);
  if (single !== null) {
    const byMin = STOCK_ACT_BRACKETS.find((b: AmountBracket) => b.min === single);
    if (byMin) return { min: byMin.min, max: byMin.max, exact: true };
    const snapped = snapToBracket(single, single);
    if (snapped) return { min: snapped.min, max: snapped.max, exact: true };
    return { min: single, max: null, exact: false };
  }

  return { min: null, max: null, exact: false };
}

/** Snap an approximate [lo,hi] onto the nearest canonical bracket. */
function snapToBracket(lo: number, hi: number | null): AmountBracket | null {
  // Prefer a bracket whose bounds nearly equal the parsed values.
  for (const b of STOCK_ACT_BRACKETS) {
    const bMax = b.max ?? Number.POSITIVE_INFINITY;
    const hiVal = hi ?? bMax;
    if (Math.abs(b.min - lo) <= 1 && (b.max === null ? hi === null : Math.abs(bMax - hiVal) <= 1)) {
      return b;
    }
  }
  return nearestBracket(lo, hi);
}

function isNum(n: number | null): n is number {
  return n !== null && Number.isFinite(n);
}
