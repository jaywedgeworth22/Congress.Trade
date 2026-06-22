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
import type { SecurityRef } from './types';

const DEFAULT_DAILY_CAP = 230;

type EnvX = Env & { FMP_API_KEY?: string; FMP_DAILY_CALL_CAP?: string };

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
  opts: { max?: number; dryRun?: boolean } = {},
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
  const sec = buildSecProvider();
  const fmp = hasFmp ? buildFmpProvider(envx.FMP_API_KEY as string) : null;
  let fmpCalls = 0;

  for (const ticker of tickers) {
    result.scanned++;
    const partials = [];
    try {
      const secRef = await sec.fetchRef(ticker);
      if (secRef) partials.push(secRef);
    } catch (e) {
      result.errors.push(ticker + ' edgar: ' + (e as Error).message);
    }
    if (fmp && fmpCalls < fmpBudget) {
      try {
        const fmpRef = await fmp.fetchRef(ticker);
        fmpCalls++;
        if (fmpRef) partials.push(fmpRef);
      } catch (e) {
        fmpCalls++; // a failed call still consumes quota
        result.errors.push(ticker + ' fmp: ' + (e as Error).message);
      }
    }

    if (partials.length === 0) {
      result.failures++;
      // Only "tombstone" (mark enriched_at so we stop retrying) when FMP was
      // actually consulted — otherwise leave it for a later run once a key exists.
      if (!dryRun && hasFmp) await upsertEmpty(env, ticker, 'no provider data');
      continue;
    }
    if (!dryRun) await upsertRef(env, mergeRefs(ticker, partials));
    result.enriched++;
  }

  result.fmpCalls = fmpCalls;
  if (hasFmp && !dryRun && fmpCalls > 0) await setDailyUsed(env, usedBefore + fmpCalls);
  result.budgetRemaining = hasFmp ? remainingBudget(cap, usedBefore + fmpCalls) : 0;
  return result;
}

async function upsertRef(env: Env, ref: SecurityRef): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO securities_ref (
       ticker, company_name, sector, industry, asset_class, is_etf, is_adr,
       country, state_hq, state_of_incorp, exchange, exchange_short, currency,
       market_cap, market_cap_bucket, ipo_date, cik, sic_code, sic_description,
       source, enriched_at, enrichment_error
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(ticker) DO UPDATE SET
       company_name=excluded.company_name, sector=excluded.sector, industry=excluded.industry,
       asset_class=excluded.asset_class, is_etf=excluded.is_etf, is_adr=excluded.is_adr,
       country=excluded.country, state_hq=excluded.state_hq, state_of_incorp=excluded.state_of_incorp,
       exchange=excluded.exchange, exchange_short=excluded.exchange_short, currency=excluded.currency,
       market_cap=excluded.market_cap, market_cap_bucket=excluded.market_cap_bucket, ipo_date=excluded.ipo_date,
       cik=excluded.cik, sic_code=excluded.sic_code, sic_description=excluded.sic_description,
       source=excluded.source, enriched_at=excluded.enriched_at, enrichment_error=NULL`,
    [
      ref.ticker, ref.companyName, ref.sector, ref.industry, ref.assetClass,
      ref.isEtf ? 1 : 0, ref.isAdr ? 1 : 0, ref.country, ref.stateHq, ref.stateOfIncorp,
      ref.exchange, ref.exchangeShort, ref.currency, ref.marketCap, ref.marketCapBucket,
      ref.ipoDate, ref.cik, ref.sicCode, ref.sicDescription, ref.source,
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
