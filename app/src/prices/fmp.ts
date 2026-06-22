/**
 * src/prices/fmp.ts
 * OWNER: prices
 *
 * FMP price client. The response PARSER is pure (unit-tested); fetches are
 * Workers-native. Uses adjusted closes when available. The S&P 500 is fetched
 * as the index ^GSPC (URL-encoded %5EGSPC), the free-tier benchmark.
 */

import type { Close } from './compute';

/**
 * Parse an FMP historical-price response into descending [{date, close}].
 * Accepts both the v3 full shape ({ historical: [{date, adjClose, close}] }) and
 * the stable "light" array shape ([{date, close}]). Prefers adjClose.
 */
export function parseEodHistory(json: unknown): Close[] {
  let arr: unknown[] | null = null;
  if (Array.isArray(json)) arr = json;
  else if (json && typeof json === 'object' && Array.isArray((json as { historical?: unknown[] }).historical)) {
    arr = (json as { historical: unknown[] }).historical;
  }
  if (!arr) return [];
  const out: Close[] = [];
  for (const r of arr) {
    const o = r as { date?: unknown; adjClose?: unknown; close?: unknown };
    const date = typeof o.date === 'string' ? o.date.slice(0, 10) : null;
    const close =
      typeof o.adjClose === 'number' ? o.adjClose : typeof o.close === 'number' ? o.close : null;
    if (date && close != null) out.push({ date, close });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // descending
  return out;
}

const BASE = 'https://financialmodelingprep.com/api/v3/historical-price-full/';

export interface PriceClient {
  /** Daily closes for a ticker between two YYYY-MM-DD dates (descending). */
  eodHistory(symbol: string, from: string, to: string): Promise<Close[]>;
  /** S&P 500 (^GSPC) daily closes between two dates (descending). */
  spxHistory(from: string, to: string): Promise<Close[]>;
}

export function buildFmpPriceClient(apiKey: string, fetchImpl: typeof fetch = fetch): PriceClient {
  async function hist(symbolEncoded: string, from: string, to: string): Promise<Close[]> {
    const url = BASE + symbolEncoded + '?from=' + from + '&to=' + to + '&apikey=' + encodeURIComponent(apiKey);
    const res = await fetchImpl(url, {
      headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' },
    });
    if (!res.ok) return [];
    return parseEodHistory(await res.json());
  }
  return {
    eodHistory: (symbol, from, to) => hist(encodeURIComponent(symbol), from, to),
    spxHistory: (from, to) => hist('%5EGSPC', from, to),
  };
}
