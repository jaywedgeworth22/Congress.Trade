/**
 * src/enrichment/sec.ts
 * OWNER: enrichment
 *
 * SEC EDGAR provider — the FREE (no-key) enrichment fallback. Resolves a ticker
 * to a CIK via the public company_tickers.json, then reads the submissions JSON
 * for SIC (→ coarse sector), state of incorporation, exchange, ETF flag, and
 * name. Parsers are pure (unit-tested); fetches are Workers-native and require a
 * descriptive User-Agent per SEC policy.
 */

import { sicToSector } from './compute';
import type { EnrichmentProvider, SecurityRef } from './types';
import { trackedFetch } from '../shared/thirdPartyTelemetry';

const UA = 'congress.trade admin@congress.trade';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Zero-pad a CIK to the 10-digit form used by the submissions endpoint. */
export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, '');
  return digits.padStart(10, '0');
}

/**
 * Parse SEC's company_tickers.json ({ "0": {cik_str, ticker, title}, … }) into
 * an uppercase-ticker → padded-CIK map.
 */
export function parseCompanyTickers(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!json || typeof json !== 'object') return map;
  for (const v of Object.values(json as Record<string, unknown>)) {
    const o = v as { cik_str?: unknown; ticker?: unknown };
    const ticker = typeof o.ticker === 'string' ? o.ticker.toUpperCase() : null;
    if (!ticker || o.cik_str == null) continue;
    if (!map.has(ticker)) map.set(ticker, padCik(o.cik_str as string | number));
  }
  return map;
}

/** Parse a SEC submissions JSON document into a partial SecurityRef. */
export function parseSecSubmissions(json: unknown): Partial<SecurityRef> | null {
  if (!json || typeof json !== 'object') return null;
  const d = json as Record<string, unknown>;
  const sic = str(d.sic);
  const exchanges = Array.isArray(d.exchanges) ? (d.exchanges as unknown[]) : [];
  const exchange = exchanges.length && typeof exchanges[0] === 'string' ? (exchanges[0] as string) : null;
  const category = str(d.category); // e.g. "Exchange Traded Fund" for ETFs
  const isEtf = !!category && /exchange traded fund|etf/i.test(category);
  return {
    companyName: str(d.name),
    sector: sicToSector(sic),
    isEtf,
    assetClass: isEtf ? 'etf' : null,
    stateOfIncorp: str(d.stateOfIncorporation),
    exchange,
    exchangeShort: exchange,
    cik: d.cik != null ? padCik(d.cik as string | number) : null,
    sicCode: sic,
    sicDescription: str(d.sicDescription),
    source: 'edgar',
  };
}

/**
 * Build the SEC provider. Lazily loads + caches the ticker→CIK map on first use
 * (one ~10MB fetch, cached for the life of the isolate / `cacheTtl`).
 *
 * Only a SUCCESSFUL fetch is cached. A failed fetch (network error, non-OK
 * response) used to still assign `cikMap = new Map()` — and because a Map
 * object is truthy even when empty, `if (cikMap) return cikMap;` then kept
 * returning that permanently-empty map for the rest of the isolate's life,
 * silently blinding every subsequent EDGAR lookup (every ticker resolves to
 * "no CIK") until the isolate recycled. Returning a fresh, UNCACHED empty map
 * on failure instead lets the very next call retry the fetch.
 */
export function buildSecProvider(fetchImpl: typeof fetch = fetch): EnrichmentProvider {
  let cikMap: Map<string, string> | null = null;
  async function ensureMap(): Promise<Map<string, string>> {
    if (cikMap) return cikMap;
    const res = await trackedFetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'user-agent': UA, accept: 'application/json' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    } as RequestInit, { service: 'security-enrichment', operation: 'fetch-sec-ticker-map' }, fetchImpl);
    if (!res.ok) return new Map(); // do NOT cache — retry the fetch next call
    cikMap = parseCompanyTickers(await res.json());
    return cikMap;
  }
  return {
    name: 'edgar',
    async fetchRef(ticker: string): Promise<Partial<SecurityRef> | null> {
      const cik = (await ensureMap()).get(ticker.toUpperCase());
      if (!cik) return null;
      const res = await trackedFetch('https://data.sec.gov/submissions/CIK' + cik + '.json', {
        headers: { 'user-agent': UA, accept: 'application/json' },
      }, { service: 'security-enrichment', operation: 'fetch-sec-submissions' }, fetchImpl);
      if (!res.ok) return null;
      return parseSecSubmissions(await res.json());
    },
  };
}
