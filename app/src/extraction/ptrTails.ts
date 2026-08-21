/**
 * House PTR row-tail detection. Kept I/O-free so drain tests can count
 * glued `[ST] S date $amount` records without loading unpdf.
 */
import { houseAssetTypeCodePattern } from '../shared/assetTypes.ts';

const HOUSE_ASSET_TYPE_CODE_PATTERN = houseAssetTypeCodePattern();

/** `[ST] S 03/10/2025 03/31/2025 $1,001 - $15,000` (or Over $1,000,000). */
export const PTR_TAIL_SOURCE = String.raw`\[(?<assetType>${HOUSE_ASSET_TYPE_CODE_PATTERN})\]\s+(?<txType>P|S|E|purchase|sale|exchange)(?:\s*\([^)]*\))?\s+(?<txDate>\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?<notifyDate>\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?<amount>(?:Over\s+)?\$[\d,]+(?:\s*(?:-|–|—|to)\s*\$?[\d,]+|\s*\+)?)`;

export function ptrTailRe(): RegExp {
  return new RegExp(PTR_TAIL_SOURCE, 'gi');
}

/**
 * How many complete House PTR row-tails are in `text`. Drain uses this to
 * refuse a stored review payload that glued later self-owned rows onto the
 * first asset (prod: AMZN ticker on an Allegheny County muni).
 */
export function countHousePtrTails(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\s+/g, ' ');
  return [...normalized.matchAll(ptrTailRe())].length;
}
