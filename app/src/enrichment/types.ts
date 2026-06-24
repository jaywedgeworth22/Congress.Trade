/**
 * src/enrichment/types.ts
 * OWNER: enrichment
 *
 * Shared contracts for asset reference-data enrichment. A provider turns a ticker
 * into a (partial) {@link SecurityRef}; the service merges one or more providers
 * into the securities_ref table. Providers are key-gated where applicable and
 * fail soft (return null) so a missing key / unknown ticker never throws.
 */

/** Market-cap size bucket (standard industry thresholds). */
export type MktCapBucket = 'mega' | 'large' | 'mid' | 'small' | 'micro' | 'nano';

/** Reference data for one security, keyed by ticker (mirrors securities_ref). */
export interface SecurityRef {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  /** equity | etf | adr | fund | other */
  assetClass: string | null;
  isEtf: boolean;
  isAdr: boolean;
  country: string | null;
  stateHq: string | null;
  stateOfIncorp: string | null;
  exchange: string | null;
  exchangeShort: string | null;
  currency: string | null;
  marketCap: number | null;
  marketCapBucket: MktCapBucket | null;
  ipoDate: string | null;
  cik: string | null;
  sicCode: string | null;
  sicDescription: string | null;
  /** Which provider(s) produced this row. */
  source: string | null;
}

/**
 * A single enrichment source. `fetchRef` returns the fields it can resolve for a
 * ticker, or null when it has nothing (unknown ticker, no key, error). It must
 * not throw for the normal "not found" case.
 */
export interface EnrichmentProvider {
  /** Stable provider id, e.g. 'fmp' | 'edgar'. */
  readonly name: string;
  fetchRef(ticker: string): Promise<Partial<SecurityRef> | null>;
}
