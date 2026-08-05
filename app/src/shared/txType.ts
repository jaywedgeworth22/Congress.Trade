/**
 * Canonical transaction-type **storage/API codes**: P | S | E
 * (STOCK Act / OGE form letters — do not rename without a data migration).
 *
 * Product-facing labels (UI, iOS, docs, share copy):
 *   P → Buy   (short letter B also accepted on input)
 *   S → Sell
 *   E → Exchange
 *
 * Upstream sources (UW dumps, Senate eFD, House "S (partial)", seed CSVs,
 * vision transcriptions) emit many aliases. Map them here so API/UI/analytics
 * never surface raw strings like `sale_full` or `purchase`.
 */
import type { TxType } from './types.ts';

/** Human label for a stored code. Unknown/empty → null. */
export function txTypeLabel(code: string | null | undefined): string | null {
  const c = canonicalizeTxType(code);
  if (c === 'P') return 'Buy';
  if (c === 'S') return 'Sell';
  if (c === 'E') return 'Exchange';
  return null;
}

/**
 * Short product letter for badges/CSV when a single letter is preferred.
 * Storage stays P; display letter for buys is B.
 */
export function txTypeDisplayLetter(code: string | null | undefined): string | null {
  const c = canonicalizeTxType(code);
  if (c === 'P') return 'B';
  if (c === 'S') return 'S';
  if (c === 'E') return 'E';
  return null;
}

/**
 * Map any raw provider/admin/form/transcription label to P|S|E.
 * Accepts product short letter **B** as buy (alias of P).
 * Returns null when empty or unrecognised.
 */
export function canonicalizeTxType(raw: string | null | undefined): TxType | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!s) return null;

  // Exact single-letter codes (P storage + B product alias for buy).
  if (s === 'p' || s === 'b') return 'P';
  if (s === 's') return 'S';
  if (s === 'e') return 'E';

  // Exchange before sale: "sale and exchange" is rare; prefer exchange tokens.
  if (s.includes('exchange') || s === 'exch') return 'E';

  // Sales: full, partial, sell, sold, S (partial), sale_full, etc.
  if (
    s.includes('sale') ||
    s.includes('sell') ||
    s.includes('sold') ||
    s === 's partial' ||
    s === 's full'
  ) {
    return 'S';
  }

  // Buys: purchase, buy, bought, and transcription "B".
  if (s.includes('purchase') || s.includes('buy') || s.includes('bought')) return 'P';

  return null;
}

/**
 * Like {@link canonicalizeTxType}, but never returns null — unrecognised /
 * empty values become Buy (P). Use only at display/export edges where a
 * missing type would otherwise render as garbage.
 */
export function canonicalizeTxTypeOrBuy(raw: string | null | undefined): TxType {
  return canonicalizeTxType(raw) ?? 'P';
}

/** @deprecated use {@link canonicalizeTxTypeOrBuy} */
export function canonicalizeTxTypeOrPurchase(raw: string | null | undefined): TxType {
  return canonicalizeTxTypeOrBuy(raw);
}
