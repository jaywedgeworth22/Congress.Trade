/**
 * src/prices/massive.ts
 * OWNER: prices
 *
 * Massive (Polygon.io) price client — same {@link PriceClient} interface as the
 * FMP client, so the price service can use either (or both, as a fallback chain)
 * via the PRICE_PROVIDER setting. Uses the daily aggregates endpoint with
 * `adjusted=true` (split-adjusted closes). The S&P benchmark is fetched as SPY
 * (a plain equity), because Massive's index symbols (I:SPX) need a separate
 * Indices entitlement that the Stocks plan lacks.
 */

import type { Close } from './compute';
import type { PriceClient } from './fmp';

/**
 * Parse a Massive/Polygon daily-aggs response into descending [{date, close}].
 * Shape: { results: [{ t: <ms epoch>, c: <close>, o,h,l,v,… }] }. `t` is the
 * start of the trading day; sliced to a UTC YYYY-MM-DD (correct for US sessions).
 */
export function parseMassiveAggs(json: unknown): Close[] {
  const arr =
    json && typeof json === 'object' && Array.isArray((json as { results?: unknown[] }).results)
      ? ((json as { results: unknown[] }).results as Array<{ t?: unknown; c?: unknown }>)
      : null;
  if (!arr) return [];
  const out: Close[] = [];
  for (const r of arr) {
    const date = typeof r.t === 'number' ? new Date(r.t).toISOString().slice(0, 10) : null;
    const close = typeof r.c === 'number' ? r.c : null;
    if (date && close != null) out.push({ date, close });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // descending
  return out;
}

const BASE = 'https://api.massive.com/v2/aggs/ticker/';

export function buildMassivePriceClient(apiKey: string, fetchImpl: typeof fetch = fetch): PriceClient {
  async function aggs(symbol: string, from: string, to: string): Promise<Close[]> {
    const url =
      BASE +
      encodeURIComponent(symbol) +
      '/range/1/day/' +
      from +
      '/' +
      to +
      '?adjusted=true&sort=desc&limit=50000&apiKey=' +
      encodeURIComponent(apiKey);
    const res = await fetchImpl(url, {
      headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' },
    });
    if (!res.ok) return []; // 401/403/404/429 → "no data" so a chain falls through
    return parseMassiveAggs(await res.json());
  }
  return {
    eodHistory: (symbol, from, to) => aggs(symbol, from, to),
    spxHistory: (from, to) => aggs('SPY', from, to),
  };
}
