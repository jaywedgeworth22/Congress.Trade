/**
 * src/prices/fallback.ts
 * OWNER: prices
 *
 * A fallback price client that tries a primary client first, and if it fails or
 * returns no data, falls back to a secondary client.
 */

import type { Close } from './compute.ts';
import type { PriceClient } from './fmp.ts';

export function buildFallbackPriceClient(primary: PriceClient, secondary: PriceClient): PriceClient {
  async function eodHistory(symbol: string, from: string, to: string): Promise<Close[]> {
    try {
      const closes = await primary.eodHistory(symbol, from, to);
      if (closes && closes.length > 0) {
        return closes;
      }
    } catch {
      // Primary threw an error, fall through to secondary
    }
    return secondary.eodHistory(symbol, from, to);
  }

  async function spxHistory(from: string, to: string): Promise<Close[]> {
    try {
      const closes = await primary.spxHistory(from, to);
      if (closes && closes.length > 0) {
        return closes;
      }
    } catch {
      // Primary threw an error, fall through to secondary
    }
    return secondary.spxHistory(from, to);
  }

  return { eodHistory, spxHistory };
}
