/**
 * src/prices/peer.ts
 * OWNER: prices
 *
 * Peer price client (cache-aside). Hits the public /api/market/* endpoints of a
 * sibling app (e.g. Socratic.Trade) to pull prices it already fetched. Used as a
 * zero-cost first pass before falling back to paid providers.
 */

import type { Close } from './compute.ts';
import type { PriceClient } from './fmp.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

/**
 * Builds a PriceClient that fetches from a peer's REST API.
 * Returns empty arrays if the peer 404s or has no data, signaling the fallback
 * client to take over.
 */
export function buildPeerPriceClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  authToken?: string,
): PriceClient {
  const origin = new URL(baseUrl).origin;
  // The peer's read endpoints are going bearer-gated; send the same token we
  // already push with (APP_B_INGEST_TOKEN). Omitted entirely when unset so the
  // client stays usable against an open peer.
  const headers: Record<string, string> = {
    'user-agent': 'congress.trade/0.1 (+https://congress.trade) PeerClient',
  };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;

  async function eodHistory(symbol: string, from: string, to: string): Promise<Close[]> {
    const url = `${origin}/api/market/prices/${encodeURIComponent(symbol)}?from=${from}&to=${to}`;
    try {
      const res = await trackedFetch(url, {
        headers,
      }, { service: 'market-prices', operation: 'fetch-peer-price-history' }, fetchImpl);
      if (!res.ok) return []; // Missing or error -> allow fallback
      const data = await res.json() as { closes?: Close[] };
      return data.closes ?? [];
    } catch {
      return []; // Network error -> allow fallback
    }
  }

  async function spxHistory(from: string, to: string): Promise<Close[]> {
    const url = `${origin}/api/market/spx?from=${from}&to=${to}`;
    try {
      const res = await trackedFetch(url, {
        headers,
      }, { service: 'market-prices', operation: 'fetch-peer-spx-history' }, fetchImpl);
      if (!res.ok) return [];
      const data = await res.json() as { closes?: Close[] };
      return data.closes ?? [];
    } catch {
      return [];
    }
  }

  return { eodHistory, spxHistory };
}
