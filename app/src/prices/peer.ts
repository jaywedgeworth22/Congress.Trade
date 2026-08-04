/**
 * src/prices/peer.ts
 * OWNER: prices
 *
 * Peer price client (cache-aside). Hits the public /api/market/* endpoints of a
 * sibling app (e.g. Socratic.Trade) to pull prices it already fetched.
 *
 * Modes:
 *  - soft (default): empty / non-2xx / network → [] so a secondary client can
 *    take over (legacy peer-first fallback stack).
 *  - strict: sole source (PRICE_PROVIDER=peer). Auth/plan failures throw
 *    PEER_HTTP_<status> so the refresh run aborts visibly instead of silently
 *    falling through to Massive/FMP. Empty series still returns [] (ticker
 *    simply has no history on the peer).
 */

import type { Close } from './compute.ts';
import type { PriceClient } from './fmp.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export interface PeerPriceClientOptions {
  /**
   * When true, non-2xx (except 404) and network failures throw PEER_HTTP_* so a
   * peer-only price plan does not look like "no data". Soft mode (default)
   * returns [] so a secondary provider can fall through.
   */
  strict?: boolean;
}

/**
 * Builds a PriceClient that fetches from a peer's REST API.
 */
export function buildPeerPriceClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  authToken?: string,
  opts: PeerPriceClientOptions = {},
): PriceClient {
  const origin = new URL(baseUrl).origin;
  const strict = opts.strict === true;
  // The peer's read endpoints are bearer-gated; send the same token we already
  // push with (APP_B_INGEST_TOKEN). Omitted entirely when unset so the client
  // stays usable against an open peer.
  const headers: Record<string, string> = {
    'user-agent': 'congress.trade/0.1 (+https://congress.trade) PeerClient',
  };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;

  async function getCloses(
    url: string,
    operation: 'fetch-peer-price-history' | 'fetch-peer-spx-history',
  ): Promise<Close[]> {
    try {
      const res = await trackedFetch(url, {
        headers,
      }, { service: 'market-prices', operation, dynamicTarget: 'peer-app' }, fetchImpl);
      if (res.status === 404) return [];
      if (!res.ok) {
        if (strict) throw new Error(`PEER_HTTP_${res.status}`);
        return [];
      }
      const data = await res.json() as { closes?: Close[] };
      return data.closes ?? [];
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('PEER_HTTP_')) throw e;
      if (strict) {
        const msg = e instanceof Error ? e.message : String(e ?? 'network');
        throw new Error(`PEER_HTTP_0:${msg.slice(0, 80)}`);
      }
      return [];
    }
  }

  async function eodHistory(symbol: string, from: string, to: string): Promise<Close[]> {
    const url = `${origin}/api/market/prices/${encodeURIComponent(symbol)}?from=${from}&to=${to}`;
    return getCloses(url, 'fetch-peer-price-history');
  }

  async function spxHistory(from: string, to: string): Promise<Close[]> {
    const url = `${origin}/api/market/spx?from=${from}&to=${to}`;
    return getCloses(url, 'fetch-peer-spx-history');
  }

  return { eodHistory, spxHistory };
}
