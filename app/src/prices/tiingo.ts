/**
 * src/prices/tiingo.ts
 * OWNER: prices
 *
 * Tiingo price client — same {@link PriceClient} interface as the FMP/Massive
 * clients, so the price service can use it as an additional PRICE_PROVIDER
 * option or fallback. Uses the `/tiingo/daily/{ticker}/prices` end-of-day
 * endpoint, preferring the split/dividend-adjusted close. The S&P benchmark is
 * fetched as SPY (a plain equity), matching the FMP/Massive clients — Tiingo's
 * free tier has no S&P 500 index symbol.
 */

import type { Close } from './compute';
import type { PriceClient } from './fmp';
import { trackedFetch } from '../shared/thirdPartyTelemetry';

/**
 * Parse a Tiingo `/prices` response into descending [{date, close}]. Shape:
 * [{ date: "2024-01-02T00:00:00.000Z", close, adjClose, … }]. Prefers adjClose.
 */
export function parseTiingoPrices(json: unknown): Close[] {
  const arr = Array.isArray(json) ? (json as Array<{ date?: unknown; close?: unknown; adjClose?: unknown }>) : null;
  if (!arr) return [];
  const out: Close[] = [];
  for (const r of arr) {
    const date = typeof r.date === 'string' ? r.date.slice(0, 10) : null;
    const close = typeof r.adjClose === 'number' ? r.adjClose : typeof r.close === 'number' ? r.close : null;
    if (date && close != null) out.push({ date, close });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // descending
  return out;
}

const BASE = 'https://api.tiingo.com/tiingo/daily/';

export function buildTiingoPriceClient(apiKey: string, fetchImpl: typeof fetch = fetch): PriceClient {
  async function hist(symbol: string, from: string, to: string): Promise<Close[]> {
    const url =
      BASE +
      encodeURIComponent(symbol) +
      '/prices?startDate=' +
      from +
      '&endDate=' +
      to +
      '&token=' +
      encodeURIComponent(apiKey);
    const res = await trackedFetch(url, {
      headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' },
    }, { service: 'market-prices', operation: 'fetch-price-history' }, fetchImpl);
    if (!res.ok) return []; // 401/403/404/429 → "no data" so a chain falls through
    return parseTiingoPrices(await res.json());
  }
  return {
    eodHistory: (symbol, from, to) => hist(symbol, from, to),
    spxHistory: (from, to) => hist('SPY', from, to),
  };
}
