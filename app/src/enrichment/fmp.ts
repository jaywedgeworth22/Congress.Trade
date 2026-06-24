/**
 * src/enrichment/fmp.ts
 * OWNER: enrichment
 *
 * Financial Modeling Prep provider — the richer (key-gated) enrichment source.
 * The response PARSER is a pure function (unit-tested); the fetch wrapper is a
 * thin Workers-native `fetch` (no SDK), matching the rest of the codebase.
 */

import { marketCapBucket } from './compute';
import { assertFmpTierOk } from '../shared/fmpStatus';
import type { EnrichmentProvider, SecurityRef } from './types';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Parse an FMP `/stable/profile?symbol=` response (an array with a single
 * object) into a partial SecurityRef. Returns null when the symbol isn't found
 * — including FMP's `{ "Error Message": … }` shape, which isn't an array.
 *
 * Tolerates both the current `/stable/` field names (`marketCap`; `exchange` is
 * the short code, `exchangeFullName` the full name) and the retired `/v3/` ones
 * (`mktCap`; `exchange` was the full name, `exchangeShortName` the short code),
 * so the parser stays source-agnostic.
 */
export function parseFmpProfile(json: unknown): Partial<SecurityRef> | null {
  const arr = Array.isArray(json) ? json : null;
  const p = arr && arr.length ? (arr[0] as Record<string, unknown>) : null;
  if (!p || !p.symbol) return null;
  const mc =
    typeof p.mktCap === 'number' ? p.mktCap : typeof p.marketCap === 'number' ? p.marketCap : null;
  const isEtf = p.isEtf === true;
  const isAdr = p.isAdr === true;
  const isFund = p.isFund === true;
  return {
    companyName: str(p.companyName),
    sector: str(p.sector),
    industry: str(p.industry),
    assetClass: isEtf ? 'etf' : isAdr ? 'adr' : isFund ? 'fund' : 'equity',
    isEtf,
    isAdr,
    country: str(p.country),
    stateHq: str(p.state),
    // `/stable/` reports the full venue in `exchangeFullName` and the short code
    // in `exchange`; `/v3/` was the reverse. Coalesce so either source maps right.
    exchange: str(p.exchangeFullName) ?? str(p.exchange),
    exchangeShort: str(p.exchangeShortName) ?? str(p.exchange),
    currency: str(p.currency),
    marketCap: mc,
    marketCapBucket: marketCapBucket(mc),
    ipoDate: str(p.ipoDate),
    cik: str(p.cik),
    source: 'fmp',
  };
}

/** Build the FMP provider. Caller guarantees a non-empty apiKey. */
export function buildFmpProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): EnrichmentProvider {
  return {
    name: 'fmp',
    async fetchRef(ticker: string): Promise<Partial<SecurityRef> | null> {
      // `/stable/profile` — the `/v3/profile/{symbol}` path was retired by FMP on
      // 2025-08-31 (non-legacy keys get `{ "Error Message": "Legacy Endpoint …" }`).
      const url =
        'https://financialmodelingprep.com/stable/profile?symbol=' +
        encodeURIComponent(ticker) +
        '&apikey=' +
        encodeURIComponent(apiKey);
      const res = await fetchImpl(url, {
        headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' },
      });
      if (!res.ok) {
        assertFmpTierOk(res.status); // throws on 401/402/403/429 (key/plan broken)
        return null; // other non-OK (404, …) => treat as "no data"
      }
      return parseFmpProfile(await res.json());
    },
  };
}
