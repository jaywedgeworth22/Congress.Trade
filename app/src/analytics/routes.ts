/**
 * src/analytics/routes.ts
 * OWNER: analytics
 *
 * Read-only analytics API mounted under /api/analytics by index.ts. Turns the
 * congressional-trade corpus into trend views that cut through the noise:
 * leaderboards, consensus ("cluster") buys, momentum, time series, party split,
 * sector mix, disclosure timeliness, and per-ticker deep dives.
 *
 * Every endpoint:
 *   - accepts the shared params window / chamber / party / source / minConf
 *     (+ endpoint-specific limit / sort / granularity / minMembers),
 *   - reports dollars as ESTIMATES from STOCK Act bracket midpoints
 *     (estimatedAmounts: true in the envelope),
 *   - is cached in CONFIG_KV for a short TTL (analytics tolerate minutes of
 *     staleness; a KV miss/error just recomputes), and
 *   - degrades to a valid empty envelope rather than a 500 on no data.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types';
import { all, get, parseJson } from '../shared/db';
import {
  asChamber,
  asPartyBucket,
  asSourceFilter,
  asWindow,
  autoGranularity,
  isGranularity,
  type CommonFilters,
  type Granularity,
  type Window,
} from './sql';
import {
  asMemberSort,
  asTickerSort,
  buildClusterBuysQuery,
  buildClusterMembersQuery,
  buildFilingLagHistogramQuery,
  buildLateFilersQuery,
  buildMemberLeaderboardQuery,
  buildMemberStatsQuery,
  buildMemberTopTickersQuery,
  buildMemberRecentTradesQuery,
  buildPartySplitQuery,
  buildPartySplitOverTimeQuery,
  buildSectorBreakdownQuery,
  buildSummaryQuery,
  buildTickerLeaderboardQuery,
  buildTickerRecentTradesQuery,
  buildTickerSummaryQuery,
  buildTickerTimeSeriesQuery,
  buildTickerTopTradersQuery,
  buildTrendingQuery,
  buildVolumeOverTimeQuery,
} from './builders';
import {
  bracketMidpoint,
  netSentiment,
  round,
  summarizeLag,
  topPerGroup,
  type LagRow,
} from './compute';

// ---------------------------------------------------------------------------
// Small coercion + envelope helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
/** Estimated-dollar values are rounded to whole dollars (they're estimates). */
function usd(v: unknown): number {
  return Math.round(num(v));
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

interface CommonQuery extends CommonFilters {
  window: Window;
}

/** Resolve the shared filter params from the query string. */
function commonFromQuery(q: Record<string, string>): CommonQuery {
  const minConf = q.minConf !== undefined && q.minConf !== '' ? Number(q.minConf) : undefined;
  return {
    window: asWindow(q.window),
    chamber: asChamber(q.chamber),
    party: asPartyBucket(q.party),
    source: asSourceFilter(q.source),
    minConf: minConf !== undefined && Number.isFinite(minConf) ? minConf : undefined,
  };
}

function granularityFromQuery(q: Record<string, string>, w: Window): Granularity {
  return isGranularity(q.granularity) ? q.granularity : autoGranularity(w);
}

/** Stable cache key from an endpoint name + the resolved params object. */
function cacheKey(name: string, obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj)
    .sort()
    .map((k) => `${k}=${obj[k] ?? ''}`)
    .join('&');
  return `analytics:${name}:${sorted}`;
}

/** Read-through cache over CONFIG_KV. A miss or any KV error just recomputes. */
async function cached<T>(env: Env, key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  try {
    const hit = await env.CONFIG_KV.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* fall through to compute */
  }
  const value = await fn();
  try {
    await env.CONFIG_KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSec) });
  } catch {
    /* best-effort cache; ignore */
  }
  return value;
}

/** Common envelope fields stamped on every response. */
function meta(f: CommonQuery, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    window: f.window,
    chamber: f.chamber ?? null,
    party: f.party ?? null,
    source: f.source ?? 'all',
    estimatedAmounts: true,
    asOf: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function buildAnalyticsRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /summary -------------------------------------------------------
  r.get('/summary', async (c) => {
    const f = commonFromQuery(c.req.query());
    const data = await cached(c.env, cacheKey('summary', f as never), 60, async () => {
      const built = buildSummaryQuery(f);
      const row = (await get<Record<string, unknown>>(c.env.DB, built.sql, built.params)) ?? {};
      const buyCount = num(row.buy_count);
      const sellCount = num(row.sell_count);
      const totalTrades = num(row.total_trades);
      return meta(f, {
        totalTrades,
        uniqueMembers: num(row.unique_members),
        uniqueTickers: num(row.unique_tickers),
        buyCount,
        sellCount,
        exchangeCount: num(row.exchange_count),
        estimatedVolumeUsd: usd(row.est_volume),
        estimatedNetFlowUsd: usd(row.est_net_flow),
        optionCount: num(row.option_count),
        resolvedTickerPct:
          totalTrades > 0 ? round(num(row.resolved_ticker_count) / totalTrades, 4) : null,
        netSentiment: netSentiment(buyCount, sellCount),
      });
    });
    return c.json(data);
  });

  // --- GET /ticker-leaderboard -------------------------------------------
  r.get('/ticker-leaderboard', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const sort = asTickerSort(q.sort);
    const limit = q.limit ? Number(q.limit) : undefined;
    const key = cacheKey('ticker-leaderboard', { ...f, sort, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildTickerLeaderboardQuery({ ...f, sort, limit });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const tickers = rows.map((row) => {
        const buyCount = num(row.buy_count);
        const sellCount = num(row.sell_count);
        return {
          ticker: str(row.ticker),
          name: str(row.name),
          tradeCount: num(row.trade_count),
          buyCount,
          sellCount,
          memberCount: num(row.member_count),
          estVolumeUsd: usd(row.est_volume),
          estNetFlowUsd: usd(row.est_net_flow),
          netSentiment: netSentiment(buyCount, sellCount),
        };
      });
      return meta(f, { sort, count: tickers.length, tickers });
    });
    return c.json(data);
  });

  // --- GET /member-leaderboard -------------------------------------------
  r.get('/member-leaderboard', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const sort = asMemberSort(q.sort);
    const limit = q.limit ? Number(q.limit) : undefined;
    const key = cacheKey('member-leaderboard', { ...f, sort, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildMemberLeaderboardQuery({ ...f, sort, limit });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const members = rows.map((row) => {
        const buyCount = num(row.buy_count);
        const sellCount = num(row.sell_count);
        return {
          filerId: str(row.filer_id),
          fullName: str(row.full_name),
          party: str(row.party),
          partyBucket: asPartyBucket(row.party) ?? 'O',
          chamber: str(row.chamber),
          state: str(row.state),
          photoUrl: str(row.photo_url),
          tradeCount: num(row.trade_count),
          buyCount,
          sellCount,
          uniqueTickers: num(row.unique_tickers),
          estVolumeUsd: usd(row.est_volume),
          estNetFlowUsd: usd(row.est_net_flow),
          netSentiment: netSentiment(buyCount, sellCount),
        };
      });
      return meta(f, { sort, count: members.length, members });
    });
    return c.json(data);
  });

  // --- GET /cluster-buys --------------------------------------------------
  r.get('/cluster-buys', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const minMembers = q.minMembers ? Number(q.minMembers) : undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    const key = cacheKey('cluster-buys', { ...f, minMembers, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildClusterBuysQuery({ ...f, minMembers, limit });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      // Follow-up: representative members for each cluster ticker (one query).
      const tickers = Array.from(new Set(rows.map((row) => str(row.ticker)).filter(Boolean))) as string[];
      let byKey = new Map<string, Array<Record<string, unknown>>>();
      if (tickers.length) {
        const mq = buildClusterMembersQuery(tickers, f);
        const mrows = await all<Record<string, unknown>>(c.env.DB, mq.sql, mq.params);
        byKey = topPerGroup(mrows, (x) => `${str(x.ticker)}:${str(x.tx_type)}`, 5);
      }
      const clusters = rows.map((row) => {
        const k = `${str(row.ticker)}:${str(row.tx_type)}`;
        const topMembers = (byKey.get(k) ?? []).map((m) => ({
          filerId: str(m.filer_id),
          fullName: str(m.full_name),
          partyBucket: asPartyBucket(m.party) ?? 'O',
          photoUrl: str(m.photo_url),
          tradeCount: num(m.trade_count),
        }));
        return {
          ticker: str(row.ticker),
          name: str(row.name),
          txType: str(row.tx_type),
          memberCount: num(row.member_count),
          tradeCount: num(row.trade_count),
          estVolumeUsd: usd(row.est_volume),
          firstSeen: str(row.first_seen),
          lastSeen: str(row.last_seen),
          parties: { D: num(row.d_members), R: num(row.r_members), O: num(row.o_members) },
          topMembers,
        };
      });
      return meta(f, { count: clusters.length, clusters });
    });
    return c.json(data);
  });

  // --- GET /trending ------------------------------------------------------
  r.get('/trending', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const limit = q.limit ? Number(q.limit) : undefined;
    const key = cacheKey('trending', { ...f, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildTrendingQuery({ ...f, limit });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const trending = rows.map((row) => {
        const recentCount = num(row.recent_count);
        const priorCount = num(row.prior_count);
        return {
          ticker: str(row.ticker),
          name: str(row.name),
          recentCount,
          priorCount,
          deltaCount: recentCount - priorCount,
          changePct: priorCount > 0 ? round((recentCount - priorCount) / priorCount, 3) : null,
          recentMembers: num(row.recent_members),
          estRecentVolumeUsd: usd(row.recent_volume),
          estRecentNetFlowUsd: usd(row.recent_net_flow),
        };
      });
      return meta(f, { count: trending.length, trending });
    });
    return c.json(data);
  });

  // --- GET /volume-over-time ---------------------------------------------
  r.get('/volume-over-time', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const granularity = granularityFromQuery(q, f.window);
    const key = cacheKey('volume-over-time', { ...f, granularity });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildVolumeOverTimeQuery({ ...f, granularity });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const series = rows.map((row) => ({
        period: str(row.period),
        buys: num(row.buys),
        sells: num(row.sells),
        estBuyVolUsd: usd(row.est_buy_vol),
        estSellVolUsd: usd(row.est_sell_vol),
      }));
      return meta(f, { granularity, count: series.length, series });
    });
    return c.json(data);
  });

  // --- GET /party-split ---------------------------------------------------
  r.get('/party-split', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const granularity = granularityFromQuery(q, f.window);
    const key = cacheKey('party-split', { ...f, granularity });
    const data = await cached(c.env, key, 300, async () => {
      const overallQ = buildPartySplitQuery(f);
      const periodQ = buildPartySplitOverTimeQuery({ ...f, granularity });
      const [overallRows, periodRows] = await Promise.all([
        all<Record<string, unknown>>(c.env.DB, overallQ.sql, overallQ.params),
        all<Record<string, unknown>>(c.env.DB, periodQ.sql, periodQ.params),
      ]);
      const empty = () => ({ buys: 0, sells: 0, estVolumeUsd: 0, estNetFlowUsd: 0, members: 0 });
      const overall: Record<string, ReturnType<typeof empty>> = { D: empty(), R: empty(), O: empty() };
      for (const row of overallRows) {
        const p = (str(row.party) ?? 'O') as 'D' | 'R' | 'O';
        if (!overall[p]) overall[p] = empty();
        overall[p] = {
          buys: num(row.buys),
          sells: num(row.sells),
          estVolumeUsd: usd(row.est_volume),
          estNetFlowUsd: usd(row.est_net_flow),
          members: num(row.members),
        };
      }
      // Pivot the per-period rows into one record per period.
      const byPeriod = new Map<string, Record<string, number | string | null>>();
      for (const row of periodRows) {
        const period = str(row.period) ?? '';
        const p = str(row.party) ?? 'O';
        const rec = byPeriod.get(period) ?? {
          period,
          D_buys: 0,
          D_sells: 0,
          R_buys: 0,
          R_sells: 0,
          O_buys: 0,
          O_sells: 0,
        };
        rec[`${p}_buys`] = num(row.buys);
        rec[`${p}_sells`] = num(row.sells);
        byPeriod.set(period, rec);
      }
      return meta(f, {
        granularity,
        overall,
        byPeriod: Array.from(byPeriod.values()),
      });
    });
    return c.json(data);
  });

  // --- GET /sector-breakdown ---------------------------------------------
  r.get('/sector-breakdown', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const limit = q.limit ? Number(q.limit) : undefined;
    const key = cacheKey('sector-breakdown', { ...f, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildSectorBreakdownQuery({ ...f, limit });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const sectors = rows.map((row) => ({
        assetType: str(row.asset_type) ?? 'Unknown',
        tradeCount: num(row.trade_count),
        buyCount: num(row.buy_count),
        sellCount: num(row.sell_count),
        estVolumeUsd: usd(row.est_volume),
        uniqueTickers: num(row.unique_tickers),
      }));
      return meta(f, { count: sectors.length, sectors });
    });
    return c.json(data);
  });

  // --- GET /filing-lag ----------------------------------------------------
  r.get('/filing-lag', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const key = cacheKey('filing-lag', f as never);
    const data = await cached(c.env, key, 600, async () => {
      const histQ = buildFilingLagHistogramQuery(f);
      const lateQ = buildLateFilersQuery(f);
      const [histRows, lateRows] = await Promise.all([
        all<Record<string, unknown>>(c.env.DB, histQ.sql, histQ.params),
        all<Record<string, unknown>>(c.env.DB, lateQ.sql, lateQ.params),
      ]);
      const lag: LagRow[] = histRows.map((row) => ({
        lagDays: num(row.lag_days),
        count: num(row.cnt),
      }));
      const topLateFilers = lateRows.map((row) => ({
        filerId: str(row.filer_id),
        fullName: str(row.full_name),
        partyBucket: asPartyBucket(row.party) ?? 'O',
        chamber: str(row.chamber),
        photoUrl: str(row.photo_url),
        avgLagDays: round(num(row.avg_lag_days), 1),
        maxLagDays: Math.round(num(row.max_lag_days)),
        lateCount: num(row.late_count),
        tradeCount: num(row.trade_count),
      }));
      return meta(f, { summary: summarizeLag(lag), topLateFilers });
    });
    return c.json(data);
  });

  // --- GET /ticker/:ticker (deep dive) -----------------------------------
  r.get('/ticker/:ticker', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const tickerParam = (c.req.param('ticker') || '').toUpperCase();
    if (!/^[A-Z0-9._-]{1,20}$/.test(tickerParam)) {
      return c.json({ error: 'invalid ticker' }, 400);
    }
    const granularity = granularityFromQuery(q, f.window);
    const key = cacheKey(`ticker:${tickerParam}`, { ...f, granularity });
    const data = await cached(c.env, key, 300, async () => {
      const sumQ = buildTickerSummaryQuery(tickerParam, f);
      const tsQ = buildTickerTimeSeriesQuery(tickerParam, { ...f, granularity });
      const buyersQ = buildTickerTopTradersQuery(tickerParam, 'P', f);
      const sellersQ = buildTickerTopTradersQuery(tickerParam, 'S', f);
      const recentQ = buildTickerRecentTradesQuery(tickerParam, f);
      const [sumRow, tsRows, buyerRows, sellerRows, recentRows, refRow] = await Promise.all([
        get<Record<string, unknown>>(c.env.DB, sumQ.sql, sumQ.params),
        all<Record<string, unknown>>(c.env.DB, tsQ.sql, tsQ.params),
        all<Record<string, unknown>>(c.env.DB, buyersQ.sql, buyersQ.params),
        all<Record<string, unknown>>(c.env.DB, sellersQ.sql, sellersQ.params),
        all<Record<string, unknown>>(c.env.DB, recentQ.sql, recentQ.params),
        get<Record<string, unknown>>(
          c.env.DB,
          'SELECT company_name, sector, industry, asset_class, country, exchange_short, currency, market_cap, market_cap_bucket, ipo_date FROM securities_ref WHERE ticker = ?',
          [tickerParam],
        ),
      ]);
      const s = sumRow ?? {};
      const buyCount = num(s.buy_count);
      const sellCount = num(s.sell_count);
      const mapTrader = (row: Record<string, unknown>) => ({
        filerId: str(row.filer_id),
        fullName: str(row.full_name),
        partyBucket: asPartyBucket(row.party) ?? 'O',
        photoUrl: str(row.photo_url),
        tradeCount: num(row.trade_count),
        estVolumeUsd: usd(row.est_volume),
      });
      const ref = refRow
        ? {
            companyName: str(refRow.company_name),
            sector: str(refRow.sector),
            industry: str(refRow.industry),
            assetClass: str(refRow.asset_class),
            country: str(refRow.country),
            exchangeShort: str(refRow.exchange_short),
            currency: str(refRow.currency),
            marketCap: refRow.market_cap == null ? null : num(refRow.market_cap),
            marketCapBucket: str(refRow.market_cap_bucket),
            ipoDate: str(refRow.ipo_date),
          }
        : null;
      return meta(f, {
        ticker: tickerParam,
        granularity,
        ref,
        summary: {
          totalTrades: num(s.total_trades),
          buyCount,
          sellCount,
          memberCount: num(s.member_count),
          estVolumeUsd: usd(s.est_volume),
          estNetFlowUsd: usd(s.est_net_flow),
          netSentiment: netSentiment(buyCount, sellCount),
          firstTrade: str(s.first_trade),
          lastTrade: str(s.last_trade),
        },
        series: tsRows.map((row) => ({
          period: str(row.period),
          buys: num(row.buys),
          sells: num(row.sells),
        })),
        topBuyers: buyerRows.map(mapTrader),
        topSellers: sellerRows.map(mapTrader),
        recentTrades: recentRows.map((row) => ({
          txDate: str(row.tx_date),
          txType: str(row.tx_type),
          owner: str(row.owner),
          isOption: num(row.is_option) === 1,
          estValueUsd: Math.round(
            bracketMidpoint(
              row.amount_min == null ? null : num(row.amount_min),
              row.amount_max == null ? null : num(row.amount_max),
            ),
          ),
          fullName: str(row.full_name),
          partyBucket: asPartyBucket(row.party) ?? 'O',
          photoUrl: str(row.photo_url),
        })),
      });
    });
    return c.json(data);
  });

  // --- GET /member/:filerId (politician deep dive) -----------------------
  r.get('/member/:filerId', async (c) => {
    const q = c.req.query();
    // Member view defaults to the full history (window=all) unless overridden.
    const f = { ...commonFromQuery(q), window: asWindow(q.window, 'all') };
    const filerId = c.req.param('filerId') || '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(filerId)) {
      return c.json({ error: 'invalid member id' }, 400);
    }
    const key = cacheKey(`member:${filerId}`, f as never);
    const data = await cached(c.env, key, 300, async () => {
      const statsQ = buildMemberStatsQuery(filerId, f);
      const topQ = buildMemberTopTickersQuery(filerId, f);
      const recentQ = buildMemberRecentTradesQuery(filerId, f);
      const [profileRow, statsRow, topRows, recentRows] = await Promise.all([
        get<Record<string, unknown>>(
          c.env.DB,
          'SELECT bioguide_id, chamber, full_name, party, state, district, committees, photo_url FROM filers WHERE bioguide_id = ?',
          [filerId],
        ),
        get<Record<string, unknown>>(c.env.DB, statsQ.sql, statsQ.params),
        all<Record<string, unknown>>(c.env.DB, topQ.sql, topQ.params),
        all<Record<string, unknown>>(c.env.DB, recentQ.sql, recentQ.params),
      ]);
      const s = statsRow ?? {};
      const buyCount = num(s.buy_count);
      const sellCount = num(s.sell_count);
      const committees = profileRow
        ? parseJson<string[]>(profileRow.committees, [])
        : [];
      return meta(f, {
        filerId,
        profile: profileRow
          ? {
              fullName: str(profileRow.full_name),
              party: str(profileRow.party),
              partyBucket: asPartyBucket(profileRow.party) ?? 'O',
              chamber: str(profileRow.chamber),
              state: str(profileRow.state),
              district: str(profileRow.district),
              committees: Array.isArray(committees) ? committees : [],
              photoUrl: str(profileRow.photo_url),
            }
          : null,
        stats: {
          totalTrades: num(s.total_trades),
          buyCount,
          sellCount,
          uniqueTickers: num(s.unique_tickers),
          estVolumeUsd: usd(s.est_volume),
          estNetFlowUsd: usd(s.est_net_flow),
          netSentiment: netSentiment(buyCount, sellCount),
          avgLagDays: s.avg_lag_days == null ? null : round(num(s.avg_lag_days), 1),
          firstTrade: str(s.first_trade),
          lastTrade: str(s.last_trade),
        },
        topTickers: topRows.map((row) => ({
          ticker: str(row.ticker),
          name: str(row.name),
          tradeCount: num(row.trade_count),
          buyCount: num(row.buy_count),
          sellCount: num(row.sell_count),
          estVolumeUsd: usd(row.est_volume),
        })),
        recentTrades: recentRows.map((row) => ({
          id: str(row.id),
          docId: str(row.doc_id),
          ticker: str(row.ticker),
          name: str(row.name),
          assetName: str(row.asset_name),
          txType: str(row.tx_type),
          txDate: str(row.tx_date),
          filedDate: str(row.filed_date),
          sourceUrl: str(row.source_url),
          owner: str(row.owner),
          isOption: num(row.is_option) === 1,
          estValueUsd: Math.round(
            bracketMidpoint(
              row.amount_min == null ? null : num(row.amount_min),
              row.amount_max == null ? null : num(row.amount_max),
            ),
          ),
        })),
      });
    });
    return c.json(data);
  });

  return r;
}
