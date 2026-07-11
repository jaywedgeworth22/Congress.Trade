/**
 * src/prices/service.ts
 * OWNER: prices
 *
 * Budgeted price refresh. Per run: refresh the S&P 500 series once, then for the
 * tickers that most need it (newest-traded first, then backfill), fetch one EOD
 * history call each — which yields both the trade-date anchor and the current
 * price — and compute per-trade performance anchors. Shares the same daily FMP
 * budget counter as enrichment, so prices + enrichment together stay under the
 * cap and resume the next day.
 */

import type { Env } from '../shared/types';
import { all, get, run } from '../shared/db';
import { remainingBudget } from '../enrichment/compute';
import { getDailyUsed, addDailyUsed } from '../enrichment/service';
import { getSharedFmpPacer } from '../shared/pace';
import { buildFmpPriceClient, type PriceClient } from './fmp';
import { buildMassivePriceClient } from './massive';
import { buildTiingoPriceClient } from './tiingo';
import { nearestClose, type Close } from './compute';
import { resolveSecrets } from '../secrets/infisical';

const DEFAULT_DAILY_CAP = 230;
type EnvX = Env & {
  FMP_API_KEY?: string;
  FMP_DAILY_CALL_CAP?: string;
  MASSIVE_API_KEY?: string;
  TIINGO_API_KEY?: string;
  /** Which provider supplies price history: 'fmp' (default), 'massive', or 'tiingo'. */
  PRICE_PROVIDER?: string;
};

interface PricePlan {
  client: PriceClient;
  /** True only for FMP, whose calls are metered against the shared daily budget. */
  fmpBudgeted: boolean;
}

/**
 * Pick the price client from PRICE_PROVIDER (default 'fmp'), gated by configured
 * keys. 'massive' uses Polygon aggregates (unlimited on the paid plan, so it is
 * NOT metered against the FMP daily budget); 'tiingo' is the same shape — an
 * explicitly-selectable, unmetered fallback. Falls back to whichever key exists,
 * in FMP -> Massive -> Tiingo order, when PRICE_PROVIDER is unset/doesn't match
 * a configured key.
 */
function pricePlan(env: EnvX): PricePlan | null {
  const provider = (env.PRICE_PROVIDER || 'fmp').trim().toLowerCase();
  if (provider === 'massive' && env.MASSIVE_API_KEY) {
    return { client: buildMassivePriceClient(env.MASSIVE_API_KEY), fmpBudgeted: false };
  }
  if (provider === 'tiingo' && env.TIINGO_API_KEY) {
    return { client: buildTiingoPriceClient(env.TIINGO_API_KEY), fmpBudgeted: false };
  }
  if (env.FMP_API_KEY) return { client: buildFmpPriceClient(env.FMP_API_KEY), fmpBudgeted: true };
  if (env.MASSIVE_API_KEY) return { client: buildMassivePriceClient(env.MASSIVE_API_KEY), fmpBudgeted: false };
  if (env.TIINGO_API_KEY) return { client: buildTiingoPriceClient(env.TIINGO_API_KEY), fmpBudgeted: false };
  return null;
}

function isoDaysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86400000).toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface PriceRefreshResult {
  hasFmpKey: boolean;
  spxUpdated: boolean;
  tickersPriced: number;
  tradesComputed: number;
  fmpCalls: number;
  budgetRemaining: number;
  dryRun: boolean;
  errors: string[];
  /** What THIS run actually fetched (for the App B outbound push — our delta only). */
  shareSpx: Close[];
  sharePrices: Array<{ ticker: string; closes: Close[]; currentPrice: number; currentPriceDate: string }>;
}

/**
 * Tickers that have trades and missing or stale cached prices, newest-traded
 * first. A one-day cutoff avoids repeated same-day refetches before market data
 * providers publish today's close, while still keeping current prices fresh.
 */
async function selectTickersNeedingPrices(
  env: Env,
  limit: number,
  staleBefore = isoDaysAgo(1),
): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await all<{ ticker: string }>(
    env.DB,
    `SELECT t.ticker AS ticker
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       LEFT JOIN (
         SELECT ticker, MAX(date) AS latest_price_date
           FROM price_eod
          GROUP BY ticker
       ) p ON p.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.tx_date IS NOT NULL
        AND (
          p.latest_price_date IS NULL OR
          sr.current_price_date IS NULL OR
          p.latest_price_date < ? OR
          sr.current_price_date < ?
        )
      GROUP BY t.ticker
      ORDER BY MAX(t.cursor_seq) DESC
      LIMIT ?`,
    [staleBefore, staleBefore, limit],
  );
  return rows.map((r) => r.ticker);
}

export async function runPriceRefresh(
  env: Env,
  opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {},
): Promise<PriceRefreshResult> {
  const runtimeSecrets = await resolveSecrets(env, [
    'FMP_API_KEY',
    'FMP_DAILY_CALL_CAP',
    'MASSIVE_API_KEY',
    'PRICE_PROVIDER',
    'TIINGO_API_KEY',
  ]);
  const envx = { ...(env as EnvX), ...runtimeSecrets };
  const dryRun = opts.dryRun === true;
  const result: PriceRefreshResult = {
    hasFmpKey: !!envx.FMP_API_KEY,
    spxUpdated: false,
    tickersPriced: 0,
    tradesComputed: 0,
    fmpCalls: 0,
    budgetRemaining: 0,
    dryRun,
    errors: [],
    shareSpx: [],
    sharePrices: [],
  };
  const plan = pricePlan(envx);
  if (!plan) return result; // no usable price provider configured
  const { client, fmpBudgeted } = plan;

  const cap = parseInt(envx.FMP_DAILY_CALL_CAP || '', 10) || DEFAULT_DAILY_CAP;
  // Massive isn't metered against the FMP budget; cap its per-run work instead.
  const used = fmpBudgeted ? await getDailyUsed(env) : 0;
  let budget = fmpBudgeted ? remainingBudget(cap, used, opts.max) : opts.max ?? cap;
  result.budgetRemaining = budget;
  if (budget <= 0) return result;

  // Shared per-isolate FMP pacer (same instance enrichment + the disclosure
  // probe use), so concurrent FMP work stays under the per-minute cap together.
  // Fall back to FMP_MAX_PER_MINUTE when the caller omits it (e.g. an admin
  // endpoint), so the shared singleton isn't memoized into a no-op.
  const fmpMaxPerMinute =
    opts.maxPerMinute ?? (parseInt((envx as { FMP_MAX_PER_MINUTE?: string }).FMP_MAX_PER_MINUTE || '', 10) || undefined);
  const pace = getSharedFmpPacer(fmpMaxPerMinute);
  let calls = 0;

  // 1) Refresh the S&P 500 series (one call), covering the oldest trade onward.
  const oldest = await get<{ d: string }>(
    env.DB,
    "SELECT MIN(tx_date) AS d FROM transactions WHERE tx_date IS NOT NULL AND tx_date <> ''",
  );
  const spxFrom = oldest?.d ? isoDaysAgo(7, new Date(oldest.d)) : isoDaysAgo(365 * 5);
  let spx: Close[] = [];
  try {
    await pace();
    spx = await client.spxHistory(spxFrom, today());
    calls++;
    budget--;
    if (spx.length && !dryRun) {
      for (let i = 0; i < spx.length; i += 100) {
        await env.DB.batch(
          spx.slice(i, i + 100).map((c) =>
            env.DB.prepare(
              'INSERT INTO spx_eod (date, close) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET close=excluded.close',
            ).bind(c.date, c.close),
          ),
        );
      }
      result.spxUpdated = true;
      result.shareSpx = spx;
    }
  } catch (e) {
    result.errors.push('spx: ' + (e as Error).message);
  }

  // 2) Per-ticker EOD history + per-trade performance anchors.
  const tickers = await selectTickersNeedingPrices(env, budget);
  for (const ticker of tickers) {
    if (budget <= 0) break;
    const trades = await all<{ id: string; tx_date: string; filed_date: string | null }>(
      env.DB,
      `SELECT t.id AS id, t.tx_date AS tx_date,
              COALESCE(f.filed_date, f.first_seen_at) AS filed_date
         FROM transactions t
         LEFT JOIN filings f ON f.doc_id = t.doc_id
        WHERE t.ticker = ? AND t.tx_date IS NOT NULL AND t.tx_date <> ''`,
      [ticker],
    );
    if (trades.length === 0) continue;
    let from = trades[0].tx_date;
    for (const t of trades) if (t.tx_date < from) from = t.tx_date;
    let hist: Close[] = [];
    try {
      await pace();
      hist = await client.eodHistory(ticker, isoDaysAgo(7, new Date(from)), today());
      calls++;
      budget--;
    } catch (e) {
      result.errors.push(ticker + ': ' + (e as Error).message);
      continue;
    }
    if (hist.length === 0) continue;
    result.tickersPriced++;
    if (dryRun) continue;

    // Cache closes.
    for (let i = 0; i < hist.length; i += 100) {
      await env.DB.batch(
        hist.slice(i, i + 100).map((c) =>
          env.DB.prepare(
            'INSERT INTO price_eod (ticker, date, close) VALUES (?, ?, ?) ON CONFLICT(ticker, date) DO UPDATE SET close=excluded.close',
          ).bind(ticker, c.date, c.close),
        ),
      );
    }
    // Current price = latest cached close. When we know the share count, also
    // recompute market_cap (= shares_outstanding * price) + its bucket so the cap
    // tracks the latest close instead of going stale at the enrichment snapshot.
    // The bucket thresholds mirror marketCapBucket() in enrichment/compute.ts.
    const latest = hist[0];
    await run(
      env.DB,
      `INSERT INTO securities_ref (ticker, current_price, current_price_date)
         VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         current_price=excluded.current_price,
         current_price_date=excluded.current_price_date,
         market_cap = CASE
           WHEN securities_ref.shares_outstanding IS NOT NULL AND securities_ref.shares_outstanding > 0
             THEN securities_ref.shares_outstanding * excluded.current_price
           ELSE securities_ref.market_cap END,
         market_cap_bucket = CASE
           WHEN securities_ref.shares_outstanding IS NULL OR securities_ref.shares_outstanding <= 0
             THEN securities_ref.market_cap_bucket
           WHEN securities_ref.shares_outstanding * excluded.current_price >= 200000000000 THEN 'mega'
           WHEN securities_ref.shares_outstanding * excluded.current_price >=  10000000000 THEN 'large'
           WHEN securities_ref.shares_outstanding * excluded.current_price >=   2000000000 THEN 'mid'
           WHEN securities_ref.shares_outstanding * excluded.current_price >=    300000000 THEN 'small'
           WHEN securities_ref.shares_outstanding * excluded.current_price >=     50000000 THEN 'micro'
           ELSE 'nano' END`,
      [ticker, latest.close, latest.date],
    );
    result.sharePrices.push({ ticker, closes: hist, currentPrice: latest.close, currentPriceDate: latest.date });
    // Per-trade anchors.
    const nowIso = new Date().toISOString();
    const stmts = trades.map((t) => {
      // Filing-date anchors: the close on/before the disclosure date (the only
      // price a copy-trader could have acted on). Fall back to the trade date
      // when no filing date is known, so the anchor is never null for a priced
      // trade that has a trade date.
      const filedDate = t.filed_date || t.tx_date;
      return env.DB.prepare(
        `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tx_id) DO UPDATE SET
           price_at_trade=excluded.price_at_trade, spx_at_trade=excluded.spx_at_trade,
           price_at_filing=excluded.price_at_filing, spx_at_filing=excluded.spx_at_filing,
           computed_at=excluded.computed_at`,
      ).bind(
        t.id,
        nearestClose(hist, t.tx_date),
        spx.length ? nearestClose(spx, t.tx_date) : null,
        nearestClose(hist, filedDate),
        spx.length ? nearestClose(spx, filedDate) : null,
        nowIso,
      );
    });
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    result.tradesComputed += trades.length;
  }

  result.fmpCalls = calls;
  if (fmpBudgeted && !dryRun && calls > 0) await addDailyUsed(env, calls);
  result.budgetRemaining = fmpBudgeted ? remainingBudget(cap, used + calls) : Math.max(0, budget - calls);
  return result;
}

/** The latest cached S&P close (for read-time current-return computation). */
export async function latestSpxClose(env: Env): Promise<number | null> {
  const row = await get<{ close: number }>(env.DB, 'SELECT close FROM spx_eod ORDER BY date DESC LIMIT 1');
  return row ? row.close : null;
}
