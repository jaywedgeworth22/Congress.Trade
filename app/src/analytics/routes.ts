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
import { assetTypeCategoryLabel, isAssetTypeCategory } from '../shared/assetTypes';
import {
  asChambers,
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
  buildConflictCandidatesQuery,
  buildConvictionMemberLinksQuery,
  buildMemberSkillQuery,
  buildFilingLagHistogramQuery,
  buildLateFilersQuery,
  buildMemberLeaderboardQuery,
  buildMemberPerformanceQuery,
  buildMemberStatsQuery,
  buildTickerBacktestCohortQuery,
  buildMemberTopTickersQuery,
  buildMemberRecentTradesQuery,
  buildPartySplitQuery,
  buildPartySplitOverTimeQuery,
  buildSectorBreakdownQuery,
  buildSectorFlowQuery,
  buildMarketCapBreakdownQuery,
  buildMemberPerformanceLeaderboardQuery,
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
  aggregateMemberPerformance,
  aggregateTickerBacktest,
  computeConvictionScore,
  convictionDirection,
  type ConvictionSkill,
  bracketMidpoint,
  netSentiment,
  round,
  summarizeLag,
  topPerGroup,
  type LagRow,
  type PriceBar,
} from './compute';
import { committeeConflict } from './conflicts';
import { computePerformance } from '../prices/compute';
import { latestSpxClose } from '../prices/service';
import { getDisclosureLatencySummary } from '../ingestion/fmpDisclosureLatency';

const TICKER_PARAM_RE = /^[A-Z0-9._^-]{1,20}$/;

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
function assetTypeCategory(v: unknown) {
  const s = str(v);
  return isAssetTypeCategory(s) ? s : 'unknown';
}
function rawList(v: unknown): string[] {
  const s = str(v);
  return s ? s.split(',').map((part) => part.trim()).filter(Boolean) : [];
}
/** Split a list into fixed-size batches (to stay under D1's 100-bound-param cap). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
/** Median of a numeric list (0 when empty — callers test the sign). */
function medianOf(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
/** Max IN-list size per D1 prepared statement, leaving headroom for other binds. */
const D1_IN_CHUNK = 80;

async function closeOnOrBefore(
  env: Env,
  table: 'price_eod' | 'spx_eod',
  date: string | null,
  ticker?: string | null,
): Promise<number | null> {
  if (!date) return null;
  const row =
    table === 'price_eod'
      ? await get<{ close: number }>(
          env.DB,
          'SELECT close FROM price_eod WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1',
          [String(ticker ?? '').toUpperCase(), date.slice(0, 10)],
        )
      : await get<{ close: number }>(
          env.DB,
          'SELECT close FROM spx_eod WHERE date <= ? ORDER BY date DESC LIMIT 1',
          [date.slice(0, 10)],
        );
  return row?.close == null ? null : num(row.close);
}

interface CommonQuery extends CommonFilters {
  window: Window;
}

/** Resolve the shared filter params from the query string. */
function commonFromQuery(q: Record<string, string>): CommonQuery {
  const minConf = q.minConf !== undefined && q.minConf !== '' ? Number(q.minConf) : undefined;
  // `chamber` accepts a CSV multi-selection (e.g. "house,executive"). Absent =>
  // the default congressional view (executive excluded — see asChambers).
  const chambers = asChambers(q.chamber);
  return {
    window: asWindow(q.window),
    chamber: chambers && chambers.length === 1 ? chambers[0] : undefined,
    chambers,
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
    chamber: f.chambers ? f.chambers.join(',') : f.chamber ?? null,
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

  // --- GET /conviction ---------------------------------------------------
  // Per-ticker composite 0-100 "congressional conviction" score (expert-panel
  // synthesis, see computeConvictionScore): distinct-politician consensus base,
  // cross-party + skew + momentum + small net-flow, anti-gaming gates, hard
  // caps, direction-aware. Defaults to a recent window so the ranking reflects
  // what Congress is actually converging on now. Currently runs the documented
  // data-gap fallback (politician-skill rollup activates as price coverage densifies;
  // the integrity gate uses the neutral 0.9 until per-ticker filing-lag is wired).
  r.get('/conviction', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(q.limit) || 40)));
    const key = cacheKey('conviction', { ...f, limit });
    const data = await cached(c.env, key, 300, async () => {
      // Conviction is NOT monotonic in trade count (broad bipartisan low-trade
      // names can outscore the trade-count leaders), so rank over a generous
      // candidate pool rather than just the top `limit`.
      const POOL_MAX = 100;
      const pool = Math.min(POOL_MAX, Math.max(60, limit * 3));
      // Conviction is a COMMON-STOCK directional signal, so every input excludes
      // option rows: a bought put / sold call is not bullish/bearish stock
      // conviction (and the app has no option-performance anchor anyway). All the
      // candidate/aggregate queries below share this stock-only, P/S filter base.
      const fStock = { ...f, excludeOptions: true };
      // Seed the candidate pool from DIRECTIONAL (P/S) activity only. If we ranked
      // the unfiltered leaderboard by total trade_count, an exchange-heavy window
      // could fill the pool with non-directional 'E' tickers that later score null
      // (sameSideTrades = 0) and drop out — starving real BUY/SELL names and
      // returning fewer than `limit`. Filtering to P/S makes trade_count (and the
      // ranking) directional, and a ticker with no P/S simply isn't a candidate.
      const lbQ = buildTickerLeaderboardQuery({ ...fStock, txTypes: ['P', 'S'], sort: 'trades', limit: pool });
      const lbRows = await all<Record<string, unknown>>(c.env.DB, lbQ.sql, lbQ.params);
      // Fetch the party + momentum + skill-link aggregates restricted to THIS
      // candidate set, so every ranked candidate's resolved side is present (a
      // global top-N side query could omit a candidate and silently null its
      // components). D1 caps a statement at 100 bound params, so the ticker (and
      // later filer) IN-lists are CHUNKED and the rows concatenated.
      const candidateTickers = Array.from(
        new Set(lbRows.map((row) => str(row.ticker)).filter((t): t is string => !!t)),
      );
      const clRows: Record<string, unknown>[] = [];
      const trRows: Record<string, unknown>[] = [];
      const linkRows: Record<string, unknown>[] = [];
      await Promise.all(
        chunk(candidateTickers, D1_IN_CHUNK).flatMap((batch) => {
          const clQ = buildClusterBuysQuery({ ...fStock, tickers: batch, minMembers: 2, limit: 200 });
          // Momentum is PER SIDE (bySide) and directional (P/S) only — rising
          // purchases must not feed a SELL signal, and 'E'/option rows never count.
          const trQ = buildTrendingQuery({ ...fStock, tickers: batch, txTypes: ['P', 'S'], bySide: true, limit: 200 });
          // Who traded each candidate, by side (for the realized-skill rollup).
          const lkQ = buildConvictionMemberLinksQuery(batch, fStock);
          return [
            all<Record<string, unknown>>(c.env.DB, clQ.sql, clQ.params).then((r) => void clRows.push(...r)),
            all<Record<string, unknown>>(c.env.DB, trQ.sql, trQ.params).then((r) => void trRows.push(...r)),
            all<Record<string, unknown>>(c.env.DB, lkQ.sql, lkQ.params).then((r) => void linkRows.push(...r)),
          ];
        }),
      );
      // Cluster rows are per (ticker, tx_type); keep BOTH the buy ('P') and sell
      // ('S') side so the route can attach the party split for the side the
      // conviction actually resolves to — not just whichever side had more politicians.
      const clByTickerSide = new Map<string, { P?: Record<string, unknown>; S?: Record<string, unknown> }>();
      for (const row of clRows) {
        const t = str(row.ticker);
        if (!t) continue;
        const side = str(row.tx_type) === 'S' ? 'S' : 'P';
        const cur = clByTickerSide.get(t) ?? {};
        cur[side] = row;
        clByTickerSide.set(t, cur);
      }
      // Trending keyed by ticker+side so momentum is read for the resolved direction.
      const trByTickerSide = new Map<string, Record<string, unknown>>();
      for (const row of trRows) {
        const t = str(row.ticker);
        if (!t) continue;
        const side = str(row.tx_type) === 'S' ? 'S' : 'P';
        trByTickerSide.set(`${t}|${side}`, row);
      }
      // Skill links keyed by ticker+side: the politicians who traded each candidate on
      // each side, so the rollup uses ONLY the side the signal resolves to.
      const membersByTickerSide = new Map<string, string[]>();
      const allFilers = new Set<string>();
      for (const row of linkRows) {
        const t = str(row.ticker);
        const fid = str(row.filer_id);
        if (!t || !fid) continue;
        const side = str(row.tx_type) === 'S' ? 'S' : 'P';
        const k = `${t}|${side}`;
        (membersByTickerSide.get(k) ?? membersByTickerSide.set(k, []).get(k)!).push(fid);
        allFilers.add(fid);
      }
      // Per-politician realized skill over their full track record (chunked under the
      // bind cap; honors source/minConf, omits the window intentionally).
      const memberSkill = new Map<string, { scored: number; wins: number; avgExcess: number }>();
      await Promise.all(
        chunk([...allFilers], D1_IN_CHUNK).map((batch) => {
          const sq = buildMemberSkillQuery(batch, f);
          return all<Record<string, unknown>>(c.env.DB, sq.sql, sq.params).then((rows) => {
            for (const row of rows) {
              const fid = str(row.filer_id);
              if (fid) memberSkill.set(fid, { scored: num(row.scored), wins: num(row.wins), avgExcess: num(row.avg_excess) });
            }
          });
        }),
      );
      // Roll up a ticker's RESOLVED-SIDE politicians into a ConvictionSkill: weighted
      // win-rate, total scored coverage, and a true MEDIAN of politician excess (a
      // skewed history with one big loser shouldn't flip the gate). null when no
      // resolved direction or no contributing politician has enough realized history
      // → the scorer falls back, so nothing regresses where data is sparse.
      const skillFor = (
        ticker: string | null,
        direction: 'BUY' | 'SELL' | null,
      ): ConvictionSkill | null => {
        // Skill applies ONLY to BUY conviction: the realized track record measures
        // politicians' BUYS (filing-anchored excess), which is evidence for a buy
        // signal but says nothing about sell timing. SELL conviction stays in the
        // fallback (no-realized-evidence cap) until sell-side skill is modeled —
        // a strong buy-picker must not lift a bearish SELL score.
        if (!ticker || direction !== 'BUY') return null;
        const members = membersByTickerSide.get(`${ticker}|P`);
        if (!members || !members.length) return null;
        let sumScored = 0;
        let sumWins = 0; // Σ wins == Σ (scored·winRate) → scored-weighted mean win-rate
        const excesses: number[] = [];
        for (const fid of members) {
          const s = memberSkill.get(fid);
          if (!s || s.scored <= 0) continue;
          sumScored += s.scored;
          sumWins += s.wins;
          excesses.push(s.avgExcess);
        }
        if (sumScored <= 0) return null;
        return {
          wMeanWinRate: sumWins / sumScored,
          totalScoredCount: sumScored,
          medianExcessPositive: medianOf(excesses) > 0,
        };
      };

      const tickers = lbRows
        .map((row) => {
          const ticker = str(row.ticker);
          const buyCount = num(row.buy_count);
          const sellCount = num(row.sell_count);
          const estNetFlow = num(row.est_net_flow);
          const sentiment = netSentiment(buyCount, sellCount);
          // Direction-aware party cluster: pick the side the signal resolves to.
          const direction = convictionDirection(sentiment, estNetFlow);
          const sides = ticker ? clByTickerSide.get(ticker) : undefined;
          const cl = sides ? (direction === 'SELL' ? sides.S : sides.P) : undefined;
          // Momentum for the resolved side (default to the BUY side when there's
          // no direction — it's capped at 20 anyway).
          const momentumSide = direction === 'SELL' ? 'S' : 'P';
          const tr = ticker ? trByTickerSide.get(`${ticker}|${momentumSide}`) : undefined;
          // Breadth and trade count reflect ONLY the resolved side: a concentrated
          // SELL must not borrow breadth from opposing BUY politicians (and vice
          // versa), so it can't dodge the single-politician cap. Purely non-directional
          // rows (exchanges, type-changes) never count. For a no-direction ticker
          // (capped at 20 anyway) fall back to the directional union.
          const buyMembers = num(row.buy_member_count);
          const sellMembers = num(row.sell_member_count);
          const directionalMembers = num(row.directional_member_count);
          const sameSideMembers =
            direction === 'BUY' ? buyMembers : direction === 'SELL' ? sellMembers : directionalMembers;
          const sameSideTrades =
            direction === 'BUY' ? buyCount : direction === 'SELL' ? sellCount : buyCount + sellCount;
          const res = computeConvictionScore({
            memberCount: sameSideMembers,
            buyCount,
            sellCount,
            netSentiment: sentiment,
            estNetFlowUsd: estNetFlow,
            tradeCount: sameSideTrades,
            dMembers: cl ? num(cl.d_members) : 0,
            rMembers: cl ? num(cl.r_members) : 0,
            deltaCount: tr ? num(tr.recent_count) - num(tr.prior_count) : null,
            recentMembers: tr ? num(tr.recent_members) : null,
            lateShare: null,
            skill: skillFor(ticker, direction),
          });
          return {
            ticker,
            name: str(row.name),
            convictionScore: res.score,
            direction: res.direction,
            fallback: res.fallback,
            // memberCount / tradeCount reflect the SCORED side (what the score is
            // built from); directionalMembers/Trades give the both-side totals.
            memberCount: sameSideMembers,
            tradeCount: sameSideTrades,
            directionalMembers,
            directionalTrades: buyCount + sellCount,
            netSentiment: sentiment,
            estNetFlowUsd: usd(row.est_net_flow),
            parties: { D: cl ? num(cl.d_members) : 0, R: cl ? num(cl.r_members) : 0 },
            components: res.components,
          };
        })
        .filter((x) => x.convictionScore != null)
        .sort((a, b) => (b.convictionScore as number) - (a.convictionScore as number))
        .slice(0, limit);
      return meta(f, { scoringVersion: 'v1', count: tickers.length, tickers });
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
          partyBucket: asPartyBucket(row.party) ?? null,
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
    const limit = q.limit ? Math.min(100, Number(q.limit)) : undefined; // public cap (builder allows 200 for internal callers)
    const key = cacheKey('cluster-buys', { ...f, minMembers, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildClusterBuysQuery({ ...f, minMembers, limit });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      // Follow-up: representative politicians for each cluster ticker (one query).
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
          partyBucket: asPartyBucket(m.party) ?? null,
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
    const limit = q.limit ? Math.min(100, Number(q.limit)) : undefined; // public cap (builder allows 200 for internal callers)
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
        const p = asPartyBucket(row.party);
        if (!p) continue;
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
        const p = asPartyBucket(row.party);
        if (!p) continue;
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
        assetType: assetTypeCategoryLabel(assetTypeCategory(row.asset_type_category)),
        assetTypeCategory: assetTypeCategory(row.asset_type_category),
        rawAssetTypes: rawList(row.raw_asset_types),
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

  // --- GET /sector-flow ---------------------------------------------------
  // REAL GICS sector net flow (securities_ref.sector), unlike /sector-breakdown
  // which groups by the free-text asset_type. Resolved tickers only.
  r.get('/sector-flow', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const limit = q.limit ? Number(q.limit) : undefined;
    const key = cacheKey('sector-flow', { ...f, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildSectorFlowQuery({ ...f, limit });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const sectors = rows.map((row) => ({
        sector: str(row.sector) ?? 'Unknown',
        tradeCount: num(row.trade_count),
        buyCount: num(row.buy_count),
        sellCount: num(row.sell_count),
        estVolumeUsd: usd(row.est_volume),
        estNetFlowUsd: usd(row.est_net_flow),
        uniqueMembers: num(row.unique_members),
        uniqueTickers: num(row.unique_tickers),
      }));
      return meta(f, { count: sectors.length, sectors, estimatedAmounts: true });
    });
    return c.json(data);
  });

  // --- GET /market-cap-breakdown ------------------------------------------
  // Net flow + activity by market-cap bucket (mega…nano) — the size tilt.
  r.get('/market-cap-breakdown', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const key = cacheKey('market-cap-breakdown', f as never);
    const data = await cached(c.env, key, 300, async () => {
      const built = buildMarketCapBreakdownQuery(f);
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const buckets = rows.map((row) => ({
        bucket: str(row.bucket) ?? 'unknown',
        tradeCount: num(row.trade_count),
        buyCount: num(row.buy_count),
        sellCount: num(row.sell_count),
        estVolumeUsd: usd(row.est_volume),
        estNetFlowUsd: usd(row.est_net_flow),
        uniqueMembers: num(row.unique_members),
        uniqueTickers: num(row.unique_tickers),
      }));
      return meta(f, { count: buckets.length, buckets, estimatedAmounts: true });
    });
    return c.json(data);
  });

  // --- GET /member-performance --------------------------------------------
  // Per-politician annualized excess return vs the S&P 500 on their BUYS, anchored at the
  // FILING (disclosure) date — the realizable "could you have followed this?"
  // number, not the trade-date hindsight figure. Buys only, options excluded,
  // small-N guarded. Defaults to the whole track record (window=all).
  r.get('/member-performance', async (c) => {
    const q = c.req.query();
    const f = { ...commonFromQuery(q), window: asWindow(q.window, 'all') };
    const limit = q.limit ? Number(q.limit) : undefined;
    const minTrades = q.minTrades ? Number(q.minTrades) : undefined;
    const key = cacheKey('member-performance', { ...f, limit, minTrades });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildMemberPerformanceLeaderboardQuery({ ...f, limit, minTrades });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const members = rows.map((row) => {
        const n = num(row.trade_count);
        const wins = num(row.wins);
        return {
          filerId: str(row.filer_id),
          fullName: str(row.full_name),
          party: str(row.party),
          partyBucket: asPartyBucket(row.party) ?? null,
          photoUrl: str(row.photo_url),
          tradeCount: n,
          // Annualized excess return vs SPX since the filing date, equal-weighted across buys.
          avgAnnualizedExcessReturn: num(row.avg_annualized_excess),
          // Raw cumulative excess is kept for compatibility/debugging.
          avgExcessReturn: num(row.avg_excess),
          winRate: n > 0 ? wins / n : 0,
          estVolumeUsd: usd(row.est_volume),
        };
      });
      return meta(f, {
        count: members.length,
        members,
        anchor: 'filing_date',
        side: 'buys',
        note: 'Annualized excess return vs S&P 500 from the disclosure date (realizable by a follower); 0% means matched the S&P, +3% means about 3 percentage points better per year. Buys only, options excluded.',
        estimatedAmounts: true,
      });
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
        partyBucket: asPartyBucket(row.party) ?? null,
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

  // --- GET /ticker/:ticker/backtest --------------------------------------
  // "How did this name perform after Congress BOUGHT it, vs the S&P, by horizon
  // (21/63/126/252 trading days)?" Forward return from each buy's tx_date, vs
  // SPX over the same span. Optional ?filerId= scopes to one politician. Returns are
  // fractions; horizons with n < BACKTEST_MIN_N report null (not noise). Coverage
  // is honest: tradeCount (cohort) vs n (events with forward history) per horizon.
  // MUST be registered before /ticker/:ticker (Hono matches in declaration order).
  r.get('/ticker/:ticker/backtest', async (c) => {
    const q = c.req.query();
    const f = { ...commonFromQuery(q), window: asWindow(q.window, 'all') };
    const tickerParam = (c.req.param('ticker') || '').toUpperCase();
    if (!TICKER_PARAM_RE.test(tickerParam)) {
      return c.json({ error: 'invalid ticker' }, 400);
    }
    const filerId = q.filerId && /^[A-Za-z0-9_-]{1,64}$/.test(q.filerId) ? q.filerId : undefined;
    const DEFAULT_HORIZONS = [21, 63, 126, 252];
    const horizons = (q.horizons ? q.horizons.split(',') : [])
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 504);
    const useHorizons = Array.from(new Set(horizons.length ? horizons : DEFAULT_HORIZONS))
      .sort((a, b) => a - b)
      .slice(0, 8);
    const key = cacheKey(`backtest:${tickerParam}`, { ...f, filerId, h: useHorizons.join('-') });
    const data = await cached(c.env, key, 300, async () => {
      const cohortQ = buildTickerBacktestCohortQuery(tickerParam, f, filerId);
      const [cohortRows, priceAsc, spxAsc] = await Promise.all([
        all<{ tx_date: string }>(c.env.DB, cohortQ.sql, cohortQ.params),
        all<PriceBar>(c.env.DB, 'SELECT date, close FROM price_eod WHERE ticker = ? ORDER BY date ASC', [tickerParam]),
        all<PriceBar>(c.env.DB, 'SELECT date, close FROM spx_eod ORDER BY date ASC'),
      ]);
      const cohortDates = cohortRows.map((row) => str(row.tx_date)).filter((d): d is string => !!d);
      const bt = aggregateTickerBacktest(cohortDates, priceAsc, spxAsc, useHorizons);
      return meta(f, {
        ticker: tickerParam,
        filerId: filerId ?? null,
        txType: 'P',
        totalBuyEvents: bt.tradeCount,
        pricedDays: priceAsc.length,
        horizons: bt.horizons,
      });
    });
    return c.json(data);
  });

  // --- GET /ticker/:ticker (deep dive) -----------------------------------
  r.get('/ticker/:ticker', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const tickerParam = (c.req.param('ticker') || '').toUpperCase();
    if (!TICKER_PARAM_RE.test(tickerParam)) {
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
        partyBucket: asPartyBucket(row.party) ?? null,
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
          id: str(row.id),
          docId: str(row.doc_id),
          ticker: str(row.ticker),
          assetName: str(row.asset_name),
          assetType: str(row.asset_type),
          assetTypeName: str(row.asset_type_name),
          txDate: str(row.tx_date),
          txType: str(row.tx_type),
          owner: str(row.owner),
          isOption: num(row.is_option) === 1,
          amountMin: row.amount_min == null ? null : num(row.amount_min),
          amountMax: row.amount_max == null ? null : num(row.amount_max),
          estValueUsd: Math.round(
            bracketMidpoint(
              row.amount_min == null ? null : num(row.amount_min),
              row.amount_max == null ? null : num(row.amount_max),
            ),
          ),
          filerId: str(row.filer_id),
          fullName: str(row.full_name),
          partyBucket: asPartyBucket(row.party) ?? null,
          photoUrl: str(row.photo_url),
          filedDate: str(row.filed_date),
          firstSeenAt: str(row.first_seen_at),
          sourceUrl: str(row.source_url),
          createdAt: str(row.created_at),
          source: str(row.source),
          rawText: str(row.raw_text),
        })),
      });
    });
    return c.json(data);
  });

  // --- GET /performance/:txId --------------------------------------------
  // Per-trade performance: % since the trade date, the S&P 500 over the same
  // window, and the excess return. Reads cached price anchors; returns
  // { available:false } for options, missing price data, or no FMP key.
  r.get('/performance/:txId', async (c) => {
    const txId = c.req.param('txId') || '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(txId)) return c.json({ error: 'invalid id' }, 400);
    const row = await get<Record<string, unknown>>(
      c.env.DB,
      `SELECT t.tx_type, t.is_option, t.ticker, t.tx_date, f.filed_date,
              txp.price_at_trade, txp.spx_at_trade,
              sr.current_price, sr.current_price_date
         FROM transactions t
         LEFT JOIN tx_performance txp ON txp.tx_id = t.id
         LEFT JOIN filings f ON f.doc_id = t.doc_id
         LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
        WHERE t.id = ?`,
      [txId],
    );
    if (!row) return c.json({ available: false });
    const isOption = num(row.is_option) === 1;
    const priceAtTrade = row.price_at_trade == null ? null : num(row.price_at_trade);
    const currentPrice = row.current_price == null ? null : num(row.current_price);
    const spxAtTrade = row.spx_at_trade == null ? null : num(row.spx_at_trade);
    if (isOption || priceAtTrade == null || currentPrice == null) {
      return c.json({ available: false, isOption });
    }
    const currentSpx = await latestSpxClose(c.env);
    const perf = computePerformance(priceAtTrade, currentPrice, spxAtTrade, currentSpx);
    const filedDate = str(row.filed_date);
    const priceAtFiling = await closeOnOrBefore(c.env, 'price_eod', filedDate, str(row.ticker));
    const spxAtFiling = await closeOnOrBefore(c.env, 'spx_eod', filedDate);
    const filingPerf =
      priceAtFiling == null || currentSpx == null
        ? null
        : computePerformance(priceAtFiling, currentPrice, spxAtFiling, currentSpx);
    return c.json({
      available: true,
      txType: str(row.tx_type),
      ticker: str(row.ticker),
      txDate: str(row.tx_date),
      filedDate,
      priceAtTrade,
      currentPrice,
      currentPriceDate: str(row.current_price_date),
      ...perf,
      tradeDatePerformance: { priceAt: priceAtTrade, spxAt: spxAtTrade, ...perf },
      filingDatePerformance:
        filingPerf == null ? null : { priceAt: priceAtFiling, spxAt: spxAtFiling, ...filingPerf },
      estimatedAmounts: true,
    });
  });

  // --- GET /member/:filerId (politician deep dive) -----------------------
  r.get('/member/:filerId', async (c) => {
    const q = c.req.query();
    // Politician view defaults to the full history (window=all) unless overridden.
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
              partyBucket: asPartyBucket(profileRow.party) ?? null,
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
          uniqueAssets: num(s.unique_assets),
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
          firstSeenAt: str(row.first_seen_at),
          createdAt: str(row.created_at),
          sourceUrl: str(row.source_url),
          owner: str(row.owner),
          isOption: num(row.is_option) === 1,
          assetType: str(row.asset_type),
          assetTypeName: str(row.asset_type_name),
          amountMin: row.amount_min == null ? null : num(row.amount_min),
          amountMax: row.amount_max == null ? null : num(row.amount_max),
          source: str(row.source),
          rawText: str(row.raw_text),
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

  // --- GET /member/:filerId/performance (realized "skill" aggregate) ------
  // Aggregates the politician's trades' realized return + alpha vs S&P from the
  // cached price anchors (tx_performance + securities_ref.current_price). All
  // returns are fractions (0.18 = +18%); winRate is the share (0..1) beating
  // the market. Lights up as filer_id resolves and prices populate; until then
  // scoredCount stays low. Defaults to full history (window=all).
  r.get('/member/:filerId/performance', async (c) => {
    const q = c.req.query();
    const f = { ...commonFromQuery(q), window: asWindow(q.window, 'all') };
    const filerId = c.req.param('filerId') || '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(filerId)) {
      return c.json({ error: 'invalid member id' }, 400);
    }
    const key = cacheKey(`member-perf:${filerId}`, f as never);
    const data = await cached(c.env, key, 300, async () => {
      const built = buildMemberPerformanceQuery(filerId, f);
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const currentSpx = await latestSpxClose(c.env);
      const perfRows = rows.map((row) => ({
        isOption: num(row.is_option) === 1,
        priceAtTrade: row.price_at_trade == null ? null : num(row.price_at_trade),
        spxAtTrade: row.spx_at_trade == null ? null : num(row.spx_at_trade),
        currentPrice: row.current_price == null ? null : num(row.current_price),
      }));
      return meta(f, { filerId, performance: aggregateMemberPerformance(perfRows, currentSpx) });
    });
    return c.json(data);
  });

  // --- GET /conflicts ----------------------------------------------------
  // Committee conflict-of-interest signal: trades where the politician sits on a
  // committee that oversees the traded stock's GICS sector (curated map in
  // analytics/conflicts.ts). Per-trade flags, newest first. Honors the shared
  // window/chamber/party/source/minConf filters.
  r.get('/conflicts', async (c) => {
    const q = c.req.query();
    const f = commonFromQuery(q);
    const limit = Math.max(1, Math.min(500, Math.floor(Number(q.limit) || 100)));
    const key = cacheKey('conflicts', { ...f, limit });
    const data = await cached(c.env, key, 300, async () => {
      const built = buildConflictCandidatesQuery({ ...f, limit: 2000 });
      const rows = await all<Record<string, unknown>>(c.env.DB, built.sql, built.params);
      const conflicts: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const committees = parseJson<string[]>(row.committees, []);
        const m = committeeConflict(Array.isArray(committees) ? committees : [], str(row.sector));
        if (!m.conflict) continue;
        conflicts.push({
          id: str(row.id),
          ticker: str(row.ticker),
          sector: m.sector,
          txType: str(row.tx_type),
          txDate: str(row.tx_date),
          filerId: str(row.filer_id),
          memberName: str(row.full_name),
          chamber: str(row.chamber),
          partyBucket: asPartyBucket(row.party) ?? null,
          viaCommittees: m.viaCommittees,
          estAmountUsd: usd(bracketMidpoint(num(row.amount_min) || null, num(row.amount_max) || null)),
        });
        if (conflicts.length >= limit) break;
      }
      return meta(f, { count: conflicts.length, conflicts });
    });
    return c.json(data);
  });

  // --- GET /latency-summary ------------------------------------------------
  // Public speed-vs-providers scoreboard. Serves ONLY the aggregate
  // publicSummary from the disclosure-latency race monitor (no doc ids, filer
  // names, or provider payloads — pinned by the admin summary test), with
  // fields renamed to a stable public contract. Positive lead seconds mean
  // Congress.Trade surfaced the disclosure first. KV-cached: the underlying
  // summary scans up to 5000 candidate rows per compute.
  r.get('/latency-summary', async (c) => {
    const data = await cached(c.env, 'analytics:latency-summary', 300, async () => {
      const { publicSummary } = await getDisclosureLatencySummary(c.env);
      return {
        generatedAt: publicSummary.generatedAt,
        totals: {
          racedDisclosures: publicSummary.totals.candidates,
          matched: publicSummary.totals.matched,
          pending: publicSummary.totals.pending,
          comparableProviders: publicSummary.totals.comparableProviders,
        },
        providers: publicSummary.providers.map((p) => ({
          id: p.provider,
          label: p.label,
          candidates: p.candidates,
          matched: p.matched,
          coveragePct: p.coveragePct,
          usFirstCount: p.ctAheadMonitorCount,
          providerFirstCount: p.providerAheadMonitorCount,
          tieCount: p.tieMonitorCount,
          medianLeadSec: p.medianMonitorDeltaSec,
          avgLeadSec: p.avgMonitorDeltaSec,
          p90LeadSec: p.p90MonitorDeltaSec,
        })),
      };
    });
    // Edge/browser cache shield: the numbers only move every ~5 minutes.
    return c.json(data, 200, { 'Cache-Control': 'public, max-age=300' });
  });

  return r;
}
