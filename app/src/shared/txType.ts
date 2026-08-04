/**
 * Canonical transaction-type codes: P = Purchase, S = Sale, E = Exchange.
 * Maps competitor aliases (sale_full, purchase, buy, …) used by UW dumps.
 */
import type { TxType } from './types.ts';

export function canonicalizeTxType(raw: string | null | undefined): TxType | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'p') return 'P';
  if (s === 's') return 'S';
  if (s === 'e') return 'E';
  if (s.includes('exchange') || s === 'exch') return 'E';
  if (s.includes('sale') || s.includes('sell') || s.includes('sold')) return 'S';
  if (s.includes('purchase') || s.includes('buy') || s.includes('bought')) return 'P';
  return null;
}
