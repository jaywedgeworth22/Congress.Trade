/**
 * src/prices/fmp.ts
 * OWNER: prices
 *
 * FMP price client. The response PARSER is pure (unit-tested); fetches are
 * Workers-native. Uses split/dividend-adjusted closes. The S&P 500 benchmark is
 * fetched as SPY (the ETF) rather than the ^GSPC index, because index symbols
 * require an entitlement most plans lack, while SPY is a plain equity symbol.
 */

import { assertFmpTierOk } from '../shared/fmpStatus';
import type { Close } from './compute';
import { trackedFetch } from '../shared/thirdPartyTelemetry';

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

// `/stable/` endpoint — the `/api/v3/historical-price-full/` path is on the same
// retirement track as the v3 profile endpoint. `dividend-adjusted` returns
// `adjClose`, matching the split/dividend-adjusted series already cached.
const BASE = 'https://financialmodelingprep.com/stable/historical-price-eod/dividend-adjusted';

export interface PriceClient {
  /** Daily closes for a ticker between two YYYY-MM-DD dates (descending). */
  eodHistory(symbol: string, from: string, to: string): Promise<Close[]>;
  /** S&P 500 daily closes (via SPY) between two dates (descending). */
  spxHistory(from: string, to: string): Promise<Close[]>;
}

export function buildFmpPriceClient(apiKey: string, fetchImpl: typeof fetch = fetch): PriceClient {
  async function hist(symbolEncoded: string, from: string, to: string): Promise<Close[]> {
    const url =
      BASE + '?symbol=' + symbolEncoded + '&from=' + from + '&to=' + to + '&apikey=' + encodeURIComponent(apiKey);
    const res = await trackedFetch(url, {
      headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' },
    }, { service: 'market-prices', operation: 'fetch-price-history' }, fetchImpl);
    if (!res.ok) {
      assertFmpTierOk(res.status); // throws on 401/402/403/429 (key/plan broken)
      return []; // other non-OK (404, …) => treat as "no data"
    }
    return parseEodHistory(await res.json());
  }
  return {
    eodHistory: (symbol, from, to) => hist(encodeURIComponent(symbol), from, to),
    spxHistory: (from, to) => hist('SPY', from, to),
  };
}
