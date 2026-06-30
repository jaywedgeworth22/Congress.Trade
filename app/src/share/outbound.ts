/**
 * src/share/outbound.ts
 * OWNER: foundation
 *
 * The return half of the cross-app data share. App B pushes the prices/refs it
 * fetched into Congress.Trade's /securities/import; this pushes the prices/refs
 * *we* fetched back to App B's equivalent endpoint, so the two apps act as one
 * shared cache and neither double-fetches.
 *
 * No-loop guarantee: we only send what THIS run fetched (the deltas returned by
 * runPriceRefresh / runEnrichment). Because our refresh is gap-fill + staleness-
 * gated, anything App B keeps fresh is never re-fetched here, so it never ends up
 * in our delta — an import we received from App B is never echoed back.
 *
 * Env-gated: a no-op unless BOTH APP_B_IMPORT_URL and APP_B_INGEST_TOKEN are set.
 */

import {
  SharePayloadSchema,
  type PriceClose,
  type PriceSeries,
  type SecurityRefInput,
} from '@jaywedgeworth22/congress-trading-shared';
import type { SecurityRef } from '../enrichment/types';
import { resolveSecrets } from '../secrets/infisical';
import type { Env } from '../shared/types';

type PeerEnv = Env & { APP_B_IMPORT_URL?: string; APP_B_INGEST_TOKEN?: string };

export interface PeerShareInput {
  refs?: SecurityRef[];
  prices?: PriceSeries[];
  spx?: PriceClose[];
}

export interface PeerShareResult {
  sent: boolean;
  reason?: string;
  status?: number;
  counts?: { refs: number; prices: number; spx: number };
}

/** The REF fields App B's /securities/import consumes (mirrors its REF_KEYS). */
function toImportRef(r: SecurityRef): SecurityRefInput {
  return {
    ticker: r.ticker,
    companyName: r.companyName,
    sector: r.sector,
    industry: r.industry,
    assetClass: r.assetClass,
    isEtf: r.isEtf,
    isAdr: r.isAdr,
    country: r.country,
    stateHq: r.stateHq,
    stateOfIncorp: r.stateOfIncorp,
    exchange: r.exchange,
    exchangeShort: r.exchangeShort,
    currency: r.currency,
    marketCap: r.marketCap,
    sharesOutstanding: r.sharesOutstanding,
    ipoDate: r.ipoDate,
    cik: r.cik,
    sicCode: r.sicCode,
    sicDescription: r.sicDescription,
  };
}

/**
 * POST our freshly-fetched delta to App B's import endpoint. Returns a structured
 * result (never throws) so the daily job can log it without aborting.
 */
export async function shareWithPeer(
  env: Env,
  input: PeerShareInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PeerShareResult> {
  const runtimeSecrets = await resolveSecrets(env, ['APP_B_IMPORT_URL', 'APP_B_INGEST_TOKEN']);
  const { APP_B_IMPORT_URL: url, APP_B_INGEST_TOKEN: token } = { ...(env as PeerEnv), ...runtimeSecrets };
  if (!url || !token) return { sent: false, reason: 'peer not configured' };

  const refs = input.refs ?? [];
  const prices = input.prices ?? [];
  const spx = input.spx ?? [];
  if (refs.length === 0 && prices.length === 0 && spx.length === 0) {
    return { sent: false, reason: 'nothing to share' };
  }

  const payload = {
    refs: refs.map(toImportRef),
    prices,
    spx: spx.map((c) => ({ date: c.date, close: c.close })),
  };
  const parsed = SharePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { sent: false, reason: 'invalid shared payload: ' + parsed.error.issues[0]?.message };
  }
  const body = JSON.stringify(parsed.data);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body,
    });
    const counts = { refs: refs.length, prices: prices.length, spx: spx.length };
    if (!res.ok) return { sent: false, reason: 'peer import failed: HTTP ' + res.status, status: res.status, counts };
    return { sent: true, status: res.status, counts };
  } catch (e) {
    return { sent: false, reason: 'peer import error: ' + (e as Error).message };
  }
}
