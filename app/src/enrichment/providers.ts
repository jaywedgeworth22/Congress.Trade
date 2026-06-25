/**
 * src/enrichment/providers.ts
 * OWNER: enrichment
 *
 * Additional reference-data providers beyond FMP + SEC EDGAR, each implementing
 * {@link EnrichmentProvider}. Parsers are pure (unit-tested); fetches are thin
 * Workers-native `fetch` wrappers that fail soft (return null on any non-OK or
 * unparseable response) so a missing key / unknown ticker / rate-limit never
 * throws and never blocks the rest of the chain.
 *
 * Coverage (from the provider benchmark):
 *   - massive    (Polygon.io): name, market cap, SIC→sector, exchange, CIK, logo
 *   - finnhub    : name, industry, market cap, exchange, IPO date, logo (CDN)
 *   - twelvedata : name, sector, industry, exchange
 *   - intrinio   : name, sector/industry classification, exchange, CIK
 */

import { marketCapBucket, sicToSector } from './compute';
import type { EnrichmentProvider, SecurityRef } from './types';

const UA = { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' };
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && !isNaN(+v) ? +v : null;

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, { headers: UA });
    if (!res.ok) return null; // 401/403/404/429/… => "no data" (chain moves on)
    return await res.json();
  } catch {
    return null;
  }
}

// --- Massive (Polygon.io) — GET /v3/reference/tickers/{ticker} ---------------
export function parseMassiveTicker(json: unknown): Partial<SecurityRef> | null {
  const r = json && typeof json === 'object' ? ((json as Record<string, unknown>).results as Record<string, unknown>) : null;
  if (!r || !r.ticker) return null;
  const type = (str(r.type) || '').toUpperCase();
  const isEtf = type === 'ETF' || type === 'ETV' || type === 'ETN' || type === 'FUND';
  const isAdr = type.indexOf('ADR') >= 0;
  const mc = num(r.market_cap);
  const sic = str(r.sic_code);
  return {
    companyName: str(r.name),
    sector: sicToSector(sic),
    industry: str(r.sic_description),
    assetClass: isEtf ? 'etf' : isAdr ? 'adr' : 'equity',
    isEtf,
    isAdr,
    country: str(r.locale) ? String(r.locale).toUpperCase() : null,
    exchangeShort: str(r.primary_exchange),
    currency: str(r.currency_name) ? String(r.currency_name).toUpperCase() : null,
    marketCap: mc,
    marketCapBucket: marketCapBucket(mc),
    cik: str(r.cik),
    sicCode: sic,
    sicDescription: str(r.sic_description),
    source: 'massive',
  };
}
export function buildMassiveProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EnrichmentProvider {
  return {
    name: 'massive',
    async fetchRef(ticker) {
      const j = await getJson(
        `https://api.massive.com/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${encodeURIComponent(apiKey)}`,
        fetchImpl,
      );
      return parseMassiveTicker(j);
    },
  };
}

// --- Finnhub — GET /stock/profile2?symbol= (market cap is in $millions) ------
export function parseFinnhubProfile(json: unknown): Partial<SecurityRef> | null {
  const j = json as Record<string, unknown>;
  if (!j || !str(j.name)) return null;
  const mcM = num(j.marketCapitalization);
  const mc = mcM != null ? Math.round(mcM * 1e6) : null;
  return {
    companyName: str(j.name),
    industry: str(j.finnhubIndustry),
    sector: str(j.finnhubIndustry), // Finnhub has no true sector; its industry label is the best it offers
    country: str(j.country),
    exchangeShort: str(j.exchange),
    currency: str(j.currency),
    marketCap: mc,
    marketCapBucket: marketCapBucket(mc),
    ipoDate: str(j.ipo),
    source: 'finnhub',
  };
}
export function buildFinnhubProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EnrichmentProvider {
  return {
    name: 'finnhub',
    async fetchRef(ticker) {
      const j = await getJson(
        `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(apiKey)}`,
        fetchImpl,
      );
      return parseFinnhubProfile(j);
    },
  };
}

// --- Twelve Data — GET /profile?symbol= --------------------------------------
export function parseTwelveDataProfile(json: unknown): Partial<SecurityRef> | null {
  const j = json as Record<string, unknown>;
  if (!j || j.status === 'error' || !str(j.name)) return null;
  return {
    companyName: str(j.name),
    sector: str(j.sector),
    industry: str(j.industry),
    exchangeShort: str(j.exchange),
    source: 'twelvedata',
  };
}
export function buildTwelveDataProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EnrichmentProvider {
  return {
    name: 'twelvedata',
    async fetchRef(ticker) {
      const j = await getJson(
        `https://api.twelvedata.com/profile?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`,
        fetchImpl,
      );
      return parseTwelveDataProfile(j);
    },
  };
}

// --- Intrinio — GET /companies/{identifier} ----------------------------------
export function parseIntrinioCompany(json: unknown): Partial<SecurityRef> | null {
  const j = json as Record<string, unknown>;
  if (!j || !str(j.name)) return null;
  const sic = str(j.sic);
  return {
    companyName: str(j.name),
    sector: str(j.sector) ?? sicToSector(sic) ?? str(j.industry_category),
    industry: str(j.industry_group) ?? str(j.industry_category),
    exchangeShort: str(j.stock_exchange),
    cik: str(j.cik),
    sicCode: sic,
    source: 'intrinio',
  };
}
export function buildIntrinioProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EnrichmentProvider {
  return {
    name: 'intrinio',
    async fetchRef(ticker) {
      const j = await getJson(
        `https://api-v2.intrinio.com/companies/${encodeURIComponent(ticker)}?api_key=${encodeURIComponent(apiKey)}`,
        fetchImpl,
      );
      return parseIntrinioCompany(j);
    },
  };
}
