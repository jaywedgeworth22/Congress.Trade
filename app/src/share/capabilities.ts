/**
 * src/share/capabilities.ts
 * OWNER: share
 *
 * Cross-app capabilities manifest so a sibling trading app can discover what
 * congress.trade exposes without hard-coding paths, limits, or score parameters.
 * Served by GET /api/export/capabilities (token-gated).
 */

import { PIT_SCORE_WEIGHTS, MEMBER_SKILL_HORIZONS } from '../export/pitScores';

export const CAPABILITIES_VERSION = 'congress-trade-crossapp-v1';

export interface CrossAppCapabilities {
  version: string;
  contract: string;
  description: string;
  importEndpoints: {
    securitiesImport: string;
    methods: string[];
    auth: string;
  };
  readEndpoints: Array<{
    path: string;
    method: string;
    description: string;
    params?: string[];
    auth: string;
  }>;
  exportEndpoints: Array<{
    path: string;
    method: string;
    description: string;
    format: string;
    auth: string;
  }>;
  importLimits: Record<string, number>;
  pitScoreConfig: {
    version: number;
    weights: Record<string, number>;
    horizons: { key: string; days: number; weight: number }[];
    format: string;
  };
}

/**
 * Build the full capabilities manifest.  Called by the export router so the
 * response always reflects the live constants from pitScores.ts.
 */
export function buildCapabilities(): CrossAppCapabilities {
  return {
    version: CAPABILITIES_VERSION,
    contract: 'congress.trade ↔ trading client cross-app v1',
    description:
      'Congress.Trade provides congressional trade data, PIT scores, market snapshots, and feed APIs for a sibling trading app.',
    importEndpoints: {
      securitiesImport: '/api/admin/securities/import',
      methods: ['POST'],
      auth: 'Bearer INGEST_TOKEN',
    },
    readEndpoints: [
      {
        path: '/api/transactions',
        method: 'GET',
        description: 'Paged congressional trade feed with cursor-based polling',
        params: ['since', 'ticker', 'member', 'chamber', 'type', 'from', 'to', 'limit', 'order'],
        auth: 'none (public)',
      },
      {
        path: '/api/client/v1/feed',
        method: 'GET',
        description: 'Client-contract feed with enriched DTOs (ClientTrade shape)',
        params: ['since', 'ticker', 'member', 'chamber', 'type', 'from', 'to', 'limit', 'order'],
        auth: 'none (public)',
      },
      {
        path: '/api/market/bundle/:ticker',
        method: 'GET',
        description: 'Single-ticker ref + prices + SPX in one round-trip',
        params: ['from', 'to'],
        auth: 'none (public)',
      },
      {
        path: '/api/market/ref/:ticker',
        method: 'GET',
        description: 'Security reference metadata for one ticker',
        auth: 'none (public)',
      },
      {
        path: '/api/market/refs',
        method: 'GET',
        description: 'Bulk security reference metadata (≤500 tickers)',
        params: ['tickers'],
        auth: 'none (public)',
      },
      {
        path: '/api/market/prices/:ticker',
        method: 'GET',
        description: 'Daily EOD closes for one ticker',
        params: ['from', 'to'],
        auth: 'none (public)',
      },
      {
        path: '/api/market/spx',
        method: 'GET',
        description: 'S&P 500 daily closes',
        params: ['from', 'to'],
        auth: 'none (public)',
      },
      {
        path: '/api/logos/ticker',
        method: 'GET',
        description: 'Same-origin cached logo proxy for a ticker',
        params: ['symbol'],
        auth: 'none (public)',
      },
    ],
    exportEndpoints: [
      {
        path: '/api/export/congress-pit-scores',
        method: 'GET',
        description: 'Point-in-time congressional score export for backtesting',
        format: 'json or ndjson',
        auth: 'Bearer INGEST_TOKEN',
      },
      {
        path: '/api/export/bulk-snapshot',
        method: 'GET',
        description: 'Daily market-data snapshot manifest (R2 object keys + schema)',
        format: 'json',
        auth: 'Bearer INGEST_TOKEN',
      },
      {
        path: '/api/export/bulk-snapshot/file',
        method: 'GET',
        description: 'Stream one table NDJSON from the bulk snapshot',
        format: 'ndjson',
        auth: 'Bearer INGEST_TOKEN',
      },
      {
        path: '/api/export/capabilities',
        method: 'GET',
        description: 'This manifest — cross-app capabilities discovery',
        format: 'json',
        auth: 'Bearer INGEST_TOKEN',
      },
    ],
    importLimits: {
      maxRefsPerCall: 2000,
      maxSpxPerCall: 5000,
      maxPriceClosesPerCall: 20000,
      maxInsiderPerCall: 5000,
      maxShortVolumePerCall: 5000,
      maxFundamentalsPerCall: 5000,
      maxAnalystPerCall: 5000,
    },
    pitScoreConfig: {
      version: 2,
      weights: { ...PIT_SCORE_WEIGHTS },
      horizons: MEMBER_SKILL_HORIZONS.map((h) => ({
        key: h.key,
        days: h.days,
        weight: h.weight,
      })),
      format: 'ndjson (default) or json',
    },
  };
}
