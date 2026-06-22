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
import { createPacer } from '../shared/pace';
import { buildFmpPriceClient } from './fmp';
import { nearestClose, type Close } from './compute';

const DEFAULT_DAILY_CAP = 230;
type EnvX = Env & { FMP_API_KEY?: string; FMP_DAILY_CALL_CAP?: string };

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
}

/** Tickers that have trades but no cached prices yet (newest-traded first). */
async function selectTickersNeedingPrices(env: Env, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await all<{ ticker: string }>(
    env.DB,
    `SELECT t.ticker AS ticker
       FROM transactions t
       LEFT JOIN price_eod p ON p.ticker = t.ticker
      WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.tx_date IS NOT NULL
        AND p.ticker IS NULL
      GROUP BY t.ticker
      ORDER BY MAX(t.cursor_seq) DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.ticker);
}

export async function runPriceRefresh(
  env: Env,
  opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {},
): Promise<PriceRefreshResult> {
  const envx = env as EnvX;
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
  };
  if (!envx.FMP_API_KEY) return result; // price data is FMP-only

  const cap = parseInt(envx.FMP_DAILY_CALL_CAP || '', 10) || DEFAULT_DAILY_CAP;
  const used = await getDailyUsed(env);
  let budget = remainingBudget(cap, used, opts.max);
  result.budgetRemaining = budget;
  if (budget <= 0) return result;

  const client = buildFmpPriceClient(envx.FMP_API_KEY);
  const pace = createPacer(opts.maxPerMinute);
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
    }
  } catch (e) {
    result.errors.push('spx: ' + (e as Error).message);
  }

  // 2) Per-ticker EOD history + per-trade performance anchors.
  const tickers = await selectTickersNeedingPrices(env, budget);
  for (const ticker of tickers) {
    if (budget <= 0) break;
    const trades = await all<{ id: string; tx_date: string }>(
      env.DB,
      "SELECT id, tx_date FROM transactions WHERE ticker = ? AND tx_date IS NOT NULL AND tx_date <> ''",
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
    // Current price = latest cached close.
    const latest = hist[0];
    await run(
      env.DB,
      `INSERT INTO securities_ref (ticker, current_price, current_price_date)
         VALUES (?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET current_price=excluded.current_price, current_price_date=excluded.current_price_date`,
      [ticker, latest.close, latest.date],
    );
    // Per-trade anchors.
    const nowIso = new Date().toISOString();
    const stmts = trades.map((t) =>
      env.DB.prepare(
        `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, computed_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT(tx_id) DO UPDATE SET price_at_trade=excluded.price_at_trade, spx_at_trade=excluded.spx_at_trade, computed_at=excluded.computed_at`,
      ).bind(t.id, nearestClose(hist, t.tx_date), spx.length ? nearestClose(spx, t.tx_date) : null, nowIso),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    result.tradesComputed += trades.length;
  }

  result.fmpCalls = calls;
  if (!dryRun && calls > 0) await addDailyUsed(env, calls);
  result.budgetRemaining = remainingBudget(cap, used + calls);
  return result;
}

/** The latest cached S&P close (for read-time current-return computation). */
export async function latestSpxClose(env: Env): Promise<number | null> {
  const row = await get<{ close: number }>(env.DB, 'SELECT close FROM spx_eod ORDER BY date DESC LIMIT 1');
  return row ? row.close : null;
}
