/**
 * src/enrichment/types.ts
 * OWNER: enrichment
 *
 * Shared contracts for asset reference-data enrichment. A provider turns a ticker
 * into a (partial) {@link SecurityRef}; the service merges one or more providers
 * into the securities_ref table. Providers are key-gated where applicable and
 * fail soft (return null) so a missing key / unknown ticker never throws.
 */

import type { MktCapBucket, SecurityRef } from "@jaywedgeworth22/congress-trading-shared";
export type { MktCapBucket, SecurityRef };

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
