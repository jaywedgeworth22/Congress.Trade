/**
 * src/enrichment/service.ts
 * OWNER: enrichment
 *
 * Budgeted enrichment runner. Each run enriches the tickers that most need it
 * (newest-traded first, then backfilling older un-enriched ones), spending at
 * most the day's remaining FMP budget. SEC EDGAR is free and always attempted;
 * FMP is layered on top when a key is configured and budget remains. A daily
 * call counter lives in CONFIG_KV so "today's needed + extra backfill" stays
 * within the cap and resumes the next day.
 */

import type { Env } from '../shared/types';
import { all, run } from '../shared/db';
import { mergeRefs, remainingBudget } from './compute';
import { buildFmpProvider } from './fmp';
import { buildSecProvider } from './sec';
import {
  buildMassiveProvider,
  buildFinnhubProvider,
  buildTwelveDataProvider,
  buildIntrinioProvider,
} from './providers';
import { createPacer } from '../shared/pace';
import type { EnrichmentProvider, SecurityRef } from './types';

const DEFAULT_DAILY_CAP = 230;

type EnvX = Env & {
  FMP_API_KEY?: string;
  FMP_DAILY_CALL_CAP?: string;
  MASSIVE_API_KEY?: string;
  INTRINIO_API_KEY?: string;
  TWELVEDATA_API_KEY?: string;
  FINNHUB_API_KEY?: string;
};

interface ChainEntry {
  name: string;
  provider: EnrichmentProvider;
  /** True only for FMP, whose calls are metered against the daily budget. */
  budgeted: boolean;
}

/**
 * Quality-ranked enrichment chain (best first), gated by configured keys.
 * Ranking is from the provider benchmark: FMP has the cleanest, widest profile
 * coverage; Massive (Polygon) adds reference + market cap + logos; Intrinio and
 * Twelve Data add classification; Finnhub adds an industry label + a directly-
 * displayable logo; SEC EDGAR is the always-on, public-domain (free) baseline.
 * These are NOT mere fallbacks — each fills fields the higher ones lack.
 */
function buildEnrichmentChain(env: EnvX, hasFmp: boolean): ChainEntry[] {
  const chain: ChainEntry[] = [];
  if (hasFmp) chain.push({ name: 'fmp', provider: buildFmpProvider(env.FMP_API_KEY as string), budgeted: true });
  if (env.MASSIVE_API_KEY) chain.push({ name: 'massive', provider: buildMassiveProvider(env.MASSIVE_API_KEY), budgeted: false });
  if (env.INTRINIO_API_KEY) chain.push({ name: 'intrinio', provider: buildIntrinioProvider(env.INTRINIO_API_KEY), budgeted: false });
  if (env.TWELVEDATA_API_KEY) chain.push({ name: 'twelvedata', provider: buildTwelveDataProvider(env.TWELVEDATA_API_KEY), budgeted: false });
  if (env.FINNHUB_API_KEY) chain.push({ name: 'finnhub', provider: buildFinnhubProvider(env.FINNHUB_API_KEY), budgeted: false });
  chain.push({ name: 'edgar', provider: buildSecProvider(), budgeted: false }); // free public-domain baseline, always last
  return chain;
}

/** Display-critical coverage: stop walking the chain early once these are set. */
function isCovered(partials: Array<Partial<SecurityRef>>): boolean {
  let name = false;
  let sector = false;
  let mcap = false;
  for (const p of partials) {
    if (p.companyName) name = true;
    if (p.sector) sector = true;
    if (p.marketCap != null) mcap = true;
  }
  return name && sector && mcap;
}

function dayKey(now = new Date()): string {
  return 'fmp:calls:' + now.toISOString().slice(0, 10);
}

/** FMP calls already spent today (from the KV day-counter). */
export async function getDailyUsed(env: Env): Promise<number> {
  try {
    const v = await env.CONFIG_KV.get(dayKey());
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
async function setDailyUsed(env: Env, n: number): Promise<void> {
  try {
    await env.CONFIG_KV.put(dayKey(), String(n), { expirationTtl: 172800 });
  } catch {
    /* best effort */
  }
}

/** Add `n` to today's FMP call counter (shared by enrichment + price refresh). */
export async function addDailyUsed(env: Env, n: number): Promise<number> {
  const used = await getDailyUsed(env);
  const next = used + Math.max(0, Math.floor(n));
  await setDailyUsed(env, next);
  return next;
}

/** Distinct tickers that still need enrichment, newest-traded first. */
export async function selectTickersToEnrich(env: Env, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await all<{ ticker: string }>(
    env.DB,
    `SELECT t.ticker AS ticker
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> ''
        AND (sr.ticker IS NULL OR sr.enriched_at IS NULL)
      GROUP BY t.ticker
      ORDER BY MAX(t.cursor_seq) DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.ticker);
}

export interface EnrichResult {
  hasFmpKey: boolean;
  dailyCap: number;
  usedBefore: number;
  scanned: number;
  enriched: number;
  fmpCalls: number;
  failures: number;
  budgetRemaining: number;
  dryRun: boolean;
  errors: string[];
}

/**
 * Run one budgeted enrichment pass. `max` caps how many tickers this invocation
 * processes (also bounded by the remaining FMP budget when a key is set).
 */
export async function runEnrichment(
  env: Env,
  opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {},
): Promise<EnrichResult> {
  const envx = env as EnvX;
  const dryRun = opts.dryRun === true;
  const cap = parseInt(envx.FMP_DAILY_CALL_CAP || '', 10) || DEFAULT_DAILY_CAP;
  const hasFmp = !!envx.FMP_API_KEY;
  const usedBefore = await getDailyUsed(env);
  const fmpBudget = hasFmp ? remainingBudget(cap, usedBefore, opts.max) : 0;
  // With a key, the run is bounded by the FMP budget; without one we still do
  // SEC-only enrichment (free) up to `max` (default 200).
  const selectLimit = hasFmp ? fmpBudget : opts.max != null ? Math.max(0, Math.floor(opts.max)) : 200;

  const result: EnrichResult = {
    hasFmpKey: hasFmp,
    dailyCap: cap,
    usedBefore,
    scanned: 0,
    enriched: 0,
    fmpCalls: 0,
    failures: 0,
    budgetRemaining: fmpBudget,
    dryRun,
    errors: [],
  };
  if (selectLimit <= 0) return result;

  const tickers = await selectTickersToEnrich(env, selectLimit);
  const chain = buildEnrichmentChain(envx, hasFmp);
  const hasKeyedProvider = chain.some((e) => e.name !== 'edgar');
  const pace = createPacer(opts.maxPerMinute);
  let fmpCalls = 0;

  for (const ticker of tickers) {
    result.scanned++;
    // Quality-ranked chain (best first). Each provider fills only what better
    // ones missed; we stop early once the display-critical fields are covered.
    const collected: Array<Partial<SecurityRef>> = [];
    let finnhubLogo: string | null = null;
    for (const entry of chain) {
      if (entry.budgeted && fmpCalls >= fmpBudget) continue; // out of FMP budget
      try {
        if (entry.name !== 'edgar') await pace(); // EDGAR is free + unmetered
        const ref = await entry.provider.fetchRef(ticker);
        if (entry.budgeted) fmpCalls++;
        if (ref) {
          collected.push(ref);
          if (entry.name === 'finnhub' && ref.logoUrl) finnhubLogo = ref.logoUrl;
        }
      } catch (e) {
        if (entry.budgeted) fmpCalls++; // a failed call still consumes quota
        result.errors.push(ticker + ' ' + entry.name + ': ' + (e as Error).message);
      }
      if (isCovered(collected)) break; // display-critical fields satisfied
    }

    if (collected.length === 0) {
      result.failures++;
      // Tombstone (set enriched_at so we stop retrying) only when a keyed
      // provider was actually consulted; a key-less SEC-only miss stays eligible.
      if (!dryRun && hasKeyedProvider) await upsertEmpty(env, ticker, 'no provider data');
      continue;
    }
    // mergeRefs is last-wins; the chain is best-first, so reverse so the best
    // provider's non-null fields win. Prefer Finnhub's directly-displayable logo.
    const merged = mergeRefs(ticker, [...collected].reverse());
    if (finnhubLogo) merged.logoUrl = finnhubLogo;
    if (!dryRun) await upsertRef(env, merged);
    result.enriched++;
  }

  result.fmpCalls = fmpCalls;
  if (hasFmp && !dryRun && fmpCalls > 0) await setDailyUsed(env, usedBefore + fmpCalls);
  result.budgetRemaining = hasFmp ? remainingBudget(cap, usedBefore + fmpCalls) : 0;
  return result;
}

/** Upsert one fully-formed SecurityRef (used by the runner + the import API). */
export async function upsertSecurityRef(env: Env, ref: SecurityRef): Promise<void> {
  return upsertRef(env, ref);
}

/**
 * Non-destructive upsert for SHARED data from another app (the import API).
 * Unlike upsertRef, this never overwrites an existing non-null column with an
 * incoming null (so a partial ref — e.g. only company/sector/marketCap — fills
 * gaps without erasing fields App A already enriched), and it does NOT set
 * enriched_at: an imported partial leaves the ticker eligible for App A's own
 * FMP/SEC enrichment to complete (CIK, exchange, country, …). is_etf/is_adr and
 * source are preserved on conflict (set only when first inserting the row).
 */
export async function importSecurityRef(env: Env, ref: SecurityRef): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO securities_ref (
       ticker, company_name, sector, industry, asset_class, is_etf, is_adr,
       country, state_hq, state_of_incorp, exchange, exchange_short, currency,
       market_cap, market_cap_bucket, ipo_date, cik, sic_code, sic_description, logo_url, source
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ticker) DO UPDATE SET
       company_name=COALESCE(excluded.company_name, securities_ref.company_name),
       sector=COALESCE(excluded.sector, securities_ref.sector),
       industry=COALESCE(excluded.industry, securities_ref.industry),
       asset_class=COALESCE(excluded.asset_class, securities_ref.asset_class),
       country=COALESCE(excluded.country, securities_ref.country),
       state_hq=COALESCE(excluded.state_hq, securities_ref.state_hq),
       state_of_incorp=COALESCE(excluded.state_of_incorp, securities_ref.state_of_incorp),
       exchange=COALESCE(excluded.exchange, securities_ref.exchange),
       exchange_short=COALESCE(excluded.exchange_short, securities_ref.exchange_short),
       currency=COALESCE(excluded.currency, securities_ref.currency),
       market_cap=COALESCE(excluded.market_cap, securities_ref.market_cap),
       market_cap_bucket=COALESCE(excluded.market_cap_bucket, securities_ref.market_cap_bucket),
       ipo_date=COALESCE(excluded.ipo_date, securities_ref.ipo_date),
       cik=COALESCE(excluded.cik, securities_ref.cik),
       sic_code=COALESCE(excluded.sic_code, securities_ref.sic_code),
       sic_description=COALESCE(excluded.sic_description, securities_ref.sic_description),
       logo_url=COALESCE(excluded.logo_url, securities_ref.logo_url)`,
    [
      ref.ticker, ref.companyName, ref.sector, ref.industry, ref.assetClass,
      ref.isEtf ? 1 : 0, ref.isAdr ? 1 : 0, ref.country, ref.stateHq, ref.stateOfIncorp,
      ref.exchange, ref.exchangeShort, ref.currency, ref.marketCap, ref.marketCapBucket,
      ref.ipoDate, ref.cik, ref.sicCode, ref.sicDescription, ref.logoUrl, ref.source,
    ],
  );
}

async function upsertRef(env: Env, ref: SecurityRef): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO securities_ref (
       ticker, company_name, sector, industry, asset_class, is_etf, is_adr,
       country, state_hq, state_of_incorp, exchange, exchange_short, currency,
       market_cap, market_cap_bucket, ipo_date, cik, sic_code, sic_description,
       logo_url, source, enriched_at, enrichment_error
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(ticker) DO UPDATE SET
       company_name=excluded.company_name, sector=excluded.sector, industry=excluded.industry,
       asset_class=excluded.asset_class, is_etf=excluded.is_etf, is_adr=excluded.is_adr,
       country=excluded.country, state_hq=excluded.state_hq, state_of_incorp=excluded.state_of_incorp,
       exchange=excluded.exchange, exchange_short=excluded.exchange_short, currency=excluded.currency,
       market_cap=excluded.market_cap, market_cap_bucket=excluded.market_cap_bucket, ipo_date=excluded.ipo_date,
       cik=excluded.cik, sic_code=excluded.sic_code, sic_description=excluded.sic_description,
       logo_url=excluded.logo_url, source=excluded.source, enriched_at=excluded.enriched_at, enrichment_error=NULL`,
    [
      ref.ticker, ref.companyName, ref.sector, ref.industry, ref.assetClass,
      ref.isEtf ? 1 : 0, ref.isAdr ? 1 : 0, ref.country, ref.stateHq, ref.stateOfIncorp,
      ref.exchange, ref.exchangeShort, ref.currency, ref.marketCap, ref.marketCapBucket,
      ref.ipoDate, ref.cik, ref.sicCode, ref.sicDescription, ref.logoUrl, ref.source,
      new Date().toISOString(),
    ],
  );
}

async function upsertEmpty(env: Env, ticker: string, err: string): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO securities_ref (ticker, enriched_at, enrichment_error) VALUES (?,?,?)
     ON CONFLICT(ticker) DO UPDATE SET enriched_at=excluded.enriched_at, enrichment_error=excluded.enrichment_error`,
    [ticker, new Date().toISOString(), err],
  );
}
