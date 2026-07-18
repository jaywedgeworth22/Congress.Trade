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
import { all, batchPrepared, get, run } from '../shared/db';
import { remainingBudget } from '../enrichment/compute';
import { getDailyUsed, addDailyUsed } from '../enrichment/service';
import { getSharedFmpPacer } from '../shared/pace';
import { buildFmpPriceClient, type PriceClient } from './fmp';
import { buildMassivePriceClient } from './massive';
import { buildTiingoPriceClient } from './tiingo';
import type { Close } from './compute';
import { resolveSecrets } from '../secrets/infisical';

const DEFAULT_DAILY_CAP = 230;
/**
 * How long a ticker stays negative-cached after an empty EOD-history fetch before
 * we retry it. Bounds the "delisted/foreign/non-equity ticker can never be
 * priced" set (~544 tickers) so it stops re-selecting forever, while still
 * letting a temporarily-empty ticker recover on its own.
 */
const PRICE_UNAVAILABLE_RECHECK_DAYS = 30;
/**
 * If a successful fetch's newest close is older than this many days, the ticker's
 * price series has effectively stopped (delisted/halted) even though it still has
 * cached history. We negative-cache it (with the retry TTL) so it isn't
 * re-selected + re-fetched every single day. A generous bar keeps weekends,
 * holidays, and normal provider lag from ever tripping it — only a series that is
 * weeks stale gets marked.
 */
const PRICE_STALE_LISTING_DAYS = 14;
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
/** Full ISO instant `days` before `from` (for TTL comparisons on price_checked_at). */
function isoInstantDaysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86400000).toISOString();
}

/**
 * A negative-cached ticker (price_unavailable=1) whose price_checked_at is at or
 * after this cutoff is still excluded from pricing selection + the backfill
 * pending count; older than it, it's eligible for a re-check. Shared by
 * selectTickersNeedingPrices and marketPending so the two agree on what "still
 * un-priceable" means.
 */
export function priceUnavailableCutoffIso(from = new Date()): string {
  return isoInstantDaysAgo(PRICE_UNAVAILABLE_RECHECK_DAYS, from);
}

/** The current calendar date (Y/M/D) in US Eastern time, where the market close +
 *  EOD publish happen. Computed via Intl so it's DST-correct in the Worker. */
function easternYmd(from: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(from);
  const pick = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: pick('year'), m: pick('month'), d: pick('day') };
}

/**
 * The most recent COMPLETED US trading day (YYYY-MM-DD): the latest weekday
 * strictly before *today in US Eastern time*, walking back over Sat/Sun.
 *
 * Anchored on Eastern — NOT UTC — on purpose. The daily job fires at 00:00 UTC,
 * which is the PRIOR weekday's evening in ET, before that session's EOD close is
 * reliably published. A UTC-midnight "yesterday" bar (the earlier version) then
 * demanded a close that doesn't exist yet, so the newest tickers looked stale
 * every run and were re-selected forever — the whole daily budget churning the
 * same head of the list instead of draining the backlog. Using the ET calendar
 * day and requiring the weekday strictly before it keeps the bar at/behind what
 * providers have actually published. Market holidays aren't modeled (they'd
 * over-select ~9 days/yr, each now a cheap incremental fetch), only weekends.
 */
export function lastTradingDay(from = new Date()): string {
  const { y, m, d } = easternYmd(from);
  // Anchor the ET calendar day at UTC midnight so the day/weekend math is exact.
  const day = new Date(Date.UTC(y, m - 1, d));
  day.setUTCDate(day.getUTCDate() - 1); // the prior session (today's isn't published yet)
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
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
 * first. Freshness is judged against the last COMPLETED trading day (not calendar
 * yesterday) so a ticker already carrying Friday's close isn't re-selected all
 * weekend, and negative-cached tickers (empty EOD history, within the re-check
 * TTL) are excluded so the pool actually drains. Selection reads the maintained,
 * indexed `securities_ref.latest_price_date` instead of scanning the whole
 * price_eod table with a `MAX(date) GROUP BY ticker` subquery.
 */
export async function selectTickersNeedingPrices(
  env: Env,
  limit: number,
  opts: { freshThrough?: string; unavailableCutoff?: string } = {},
): Promise<string[]> {
  if (limit <= 0) return [];
  const freshThrough = opts.freshThrough ?? lastTradingDay();
  const unavailableCutoff = opts.unavailableCutoff ?? priceUnavailableCutoffIso();
  const rows = await all<{ ticker: string }>(
    env.DB,
    `SELECT t.ticker AS ticker
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.tx_date IS NOT NULL
        AND (sr.latest_price_date IS NULL OR sr.latest_price_date < ?)
        AND NOT (
          COALESCE(sr.price_unavailable, 0) = 1
          AND sr.price_checked_at IS NOT NULL
          AND sr.price_checked_at >= ?
        )
      GROUP BY t.ticker
      ORDER BY MAX(t.cursor_seq) DESC
      LIMIT ?`,
    [freshThrough, unavailableCutoff, limit],
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
    'FMP_MAX_PER_MINUTE',
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
    opts.maxPerMinute ?? (parseInt(envx.FMP_MAX_PER_MINUTE || '', 10) || undefined);
  const pace = getSharedFmpPacer(fmpMaxPerMinute);
  let calls = 0;

  // 1) Refresh the S&P 500 series (one call). Same gap-based window as per-ticker:
  //    backfill from the oldest trade only when the cached SPX series doesn't yet
  //    cover it (so older trades' spx_at_trade/spx_at_filing anchors can be
  //    computed); once complete, use the cheap 7-day incremental window instead of
  //    re-downloading the whole ~3,500-row series every run.
  const spxCached = await get<{ mn: string | null; mx: string | null }>(
    env.DB,
    'SELECT MIN(date) AS mn, MAX(date) AS mx FROM spx_eod',
  );
  const oldestTradeRow = await get<{ d: string | null }>(
    env.DB,
    "SELECT MIN(tx_date) AS d FROM transactions WHERE tx_date IS NOT NULL AND tx_date <> ''",
  );
  let spxFrom: string;
  if (spxCached?.mx) {
    const hasGapBelowCache =
      oldestTradeRow?.d != null && spxCached.mn != null && oldestTradeRow.d < spxCached.mn;
    spxFrom = hasGapBelowCache
      ? isoDaysAgo(7, new Date(oldestTradeRow.d as string))
      : isoDaysAgo(7, new Date(spxCached.mx));
  } else {
    spxFrom = oldestTradeRow?.d ? isoDaysAgo(7, new Date(oldestTradeRow.d)) : isoDaysAgo(365 * 5);
  }
  let spx: Close[] = [];
  try {
    await pace();
    spx = await client.spxHistory(spxFrom, today());
    calls++;
    budget--;
    if (spx.length && !dryRun) {
      for (let i = 0; i < spx.length; i += 100) {
        await batchPrepared(
          env.DB,
          spx.slice(i, i + 100).map((c) =>
            env.DB.prepare(
              // No-op guard: only write when the close actually changed, so the
              // re-fetched overlap window doesn't churn identical rows.
              'INSERT INTO spx_eod (date, close) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET close=excluded.close WHERE spx_eod.close <> excluded.close',
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
    const nowIso = new Date().toISOString();
    const trades = await all<{ id: string; tx_date: string }>(
      env.DB,
      `SELECT t.id AS id, t.tx_date AS tx_date
         FROM transactions t
        WHERE t.ticker = ? AND t.tx_date IS NOT NULL AND t.tx_date <> ''`,
      [ticker],
    );
    if (trades.length === 0) continue;

    // Decide the fetch window from the CACHED coverage (min + max date):
    //  - cold cache (no rows): fetch the full trade-based history once.
    //  - a gap below the cache (oldest trade predates the earliest cached close,
    //    e.g. a historical backfill added an older trade): fetch from the oldest
    //    trade so its trade/filing anchors can be computed.
    //  - otherwise the historical range is already complete: use the cheap 7-day
    //    incremental window off the latest cached close. This is the key guard —
    //    without checking the earliest cached close, a ticker whose oldest trade
    //    predates its cache (i.e. essentially every ticker) would re-download its
    //    entire multi-year series every stale day; the no-op upsert guard avoids
    //    row writes but not the provider transfer or per-row D1 work.
    const cached = await get<{ mn: string | null; mx: string | null }>(
      env.DB,
      'SELECT MIN(date) AS mn, MAX(date) AS mx FROM price_eod WHERE ticker = ?',
      [ticker],
    );
    let oldestTrade = trades[0].tx_date;
    for (const t of trades) if (t.tx_date < oldestTrade) oldestTrade = t.tx_date;
    let from: string;
    if (cached?.mx) {
      const hasGapBelowCache = cached.mn != null && oldestTrade < cached.mn;
      from = hasGapBelowCache
        ? isoDaysAgo(7, new Date(oldestTrade))
        : isoDaysAgo(7, new Date(cached.mx));
    } else {
      from = isoDaysAgo(7, new Date(oldestTrade));
    }
    let hist: Close[] = [];
    try {
      await pace();
      hist = await client.eodHistory(ticker, from, today());
      calls++;
      budget--;
    } catch (e) {
      result.errors.push(ticker + ': ' + (e as Error).message);
      continue;
    }
    if (hist.length === 0) {
      // Reaching here means the provider returned a CONFIRMED empty result (a 2xx
      // with no rows, or a 404 "unknown symbol") — the price clients THROW on
      // transient/global failures (401/402/403/429/5xx), which are caught above
      // and skip the ticker without marking it. So an empty here is a genuine
      // "no closes for this ticker" (delisted, foreign, or non-equity), never a
      // rate-limit/outage. Negative-cache it: without this, the backfill loop's
      // done:true — which requires "traded tickers with no price_eod row == 0" —
      // is unreachable for the ~544 such tickers, so the loop (and its D1
      // write/read spend) never stopped. The re-check TTL in
      // selectTickersNeedingPrices lets a temporarily-empty ticker recover later.
      if (!dryRun) {
        await run(
          env.DB,
          `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at)
             VALUES (?, 1, ?)
           ON CONFLICT(ticker) DO UPDATE SET
             price_unavailable = 1,
             price_checked_at = excluded.price_checked_at`,
          [ticker, nowIso],
        );
      }
      continue;
    }
    result.tickersPriced++;
    if (dryRun) continue;

    // Cache closes. The no-op guard skips unchanged rows in the re-fetched
    // overlap window so identical closes aren't rewritten every pass.
    for (let i = 0; i < hist.length; i += 100) {
      await batchPrepared(
        env.DB,
        hist.slice(i, i + 100).map((c) =>
          env.DB.prepare(
            'INSERT INTO price_eod (ticker, date, close) VALUES (?, ?, ?) ON CONFLICT(ticker, date) DO UPDATE SET close=excluded.close WHERE price_eod.close <> excluded.close',
          ).bind(ticker, c.date, c.close),
        ),
      );
    }
    // Current price = latest cached close; record latest_price_date (the indexed
    // column selection + freshness read from instead of scanning price_eod). If
    // the newest available close is weeks stale, the series has stopped
    // (delisted/halted) even though the fetch wasn't empty — negative-cache it
    // (TTL-bounded) so it isn't re-selected + re-fetched daily forever; otherwise
    // clear any prior negative-cache. When we know the share count, recompute
    // market_cap (= shares_outstanding * price) + its bucket so the cap tracks the
    // latest close. The bucket thresholds mirror marketCapBucket() in
    // enrichment/compute.ts.
    const latest = hist[0];
    const priceStalled = latest.date < isoDaysAgo(PRICE_STALE_LISTING_DAYS);
    await run(
      env.DB,
      `INSERT INTO securities_ref (ticker, current_price, current_price_date, latest_price_date, price_unavailable, price_checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         current_price=excluded.current_price,
         current_price_date=excluded.current_price_date,
         latest_price_date=excluded.latest_price_date,
         price_unavailable=excluded.price_unavailable,
         price_checked_at=excluded.price_checked_at,
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
      [ticker, latest.close, latest.date, latest.date, priceStalled ? 1 : 0, nowIso],
    );
    result.sharePrices.push({ ticker, closes: hist, currentPrice: latest.close, currentPriceDate: latest.date });
    // Per-trade anchors: recompute from the CACHED price_eod / spx_eod series (not
    // the freshly-fetched window, which now spans only recent days) so narrowing
    // the fetch never overwrites historical trade/filing anchors with nulls.
    // Filing anchor = the close on/before the disclosure date (the only price a
    // copy-trader could have acted on), falling back to the trade date.
    await run(
      env.DB,
      `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at)
       SELECT t.id,
         (SELECT close FROM price_eod p WHERE p.ticker = t.ticker AND p.date <= t.tx_date ORDER BY p.date DESC LIMIT 1),
         (SELECT close FROM spx_eod s WHERE s.date <= t.tx_date ORDER BY s.date DESC LIMIT 1),
         (SELECT close FROM price_eod p WHERE p.ticker = t.ticker AND p.date <= COALESCE(f.filed_date, f.first_seen_at, t.tx_date) ORDER BY p.date DESC LIMIT 1),
         (SELECT close FROM spx_eod s WHERE s.date <= COALESCE(f.filed_date, f.first_seen_at, t.tx_date) ORDER BY s.date DESC LIMIT 1),
         ?
       FROM transactions t
       LEFT JOIN filings f ON f.doc_id = t.doc_id
       WHERE t.ticker = ? AND t.tx_date IS NOT NULL AND t.tx_date <> ''
       ON CONFLICT(tx_id) DO UPDATE SET
         price_at_trade=excluded.price_at_trade, spx_at_trade=excluded.spx_at_trade,
         price_at_filing=excluded.price_at_filing, spx_at_filing=excluded.spx_at_filing,
         computed_at=excluded.computed_at`,
      [nowIso, ticker],
    );
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
