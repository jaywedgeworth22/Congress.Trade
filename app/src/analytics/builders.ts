/**
 * src/analytics/builders.ts
 * OWNER: analytics
 *
 * Pure SQL builders for the analytics endpoints. Each returns { sql, params }
 * and is unit-tested without a DB (mirrors src/delivery/rows.ts). All dollar
 * metrics use BRACKET_MIDPOINT_SQL and are ESTIMATES; ticker views exclude
 * null/empty tickers; party is bucketed D/R/O.
 *
 * Bind-param ordering rule: SQLite positional `?` bind in order of appearance in
 * the SQL text. Builders that bind a SELECT-side value (a strftime() format)
 * push it FIRST, then the WHERE params from buildCommonFilters. LIMIT / HAVING
 * thresholds are validated integers interpolated as literals (as rows.ts does
 * for LIMIT) to keep param ordering simple.
 */

import type { SqlParam } from '../shared/db';
import {
  ANALYTICS_FROM_JOINS,
  ANALYTICS_FROM_JOINS_SECURITIES,
  ANALYTICS_FROM_JOINS_REF,
  BRACKET_MIDPOINT_SQL,
  CHAMBER_EXPR,
  PARTY_BUCKET_SQL,
  SIGNED_MIDPOINT_SQL,
  TICKER_RESOLVED_SQL,
  buildCommonFilters,
  clampLimit,
  granularityFormat,
  whereSql,
  windowDays,
  type CommonFilters,
  type Granularity,
  type Window,
} from './sql';

export interface BuiltQuery {
  sql: string;
  params: SqlParam[];
}

const MID = BRACKET_MIDPOINT_SQL;
const SIGNED = SIGNED_MIDPOINT_SQL;
const BUY = "SUM(CASE WHEN t.tx_type = 'P' THEN 1 ELSE 0 END)";
const SELL = "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END)";

// ---------------------------------------------------------------------------
// 1. Summary — KPI strip
// ---------------------------------------------------------------------------

/** Corpus-wide totals for the window: trades, members, tickers, est volume,
 *  buy/sell/exchange counts, resolved-ticker count, option count. */
export function buildSummaryQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const sql =
    'SELECT ' +
    'COUNT(*) AS total_trades, ' +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers, ` +
    `${BUY} AS buy_count, ` +
    `${SELL} AS sell_count, ` +
    "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow, ` +
    `SUM(CASE WHEN ${TICKER_RESOLVED_SQL} THEN 1 ELSE 0 END) AS resolved_ticker_count, ` +
    'SUM(CASE WHEN t.is_option = 1 THEN 1 ELSE 0 END) AS option_count ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where);
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 2. Ticker leaderboard — "what is Congress trading?"
// ---------------------------------------------------------------------------

export type TickerSort = 'trades' | 'volume' | 'members' | 'netflow' | 'buys' | 'sells';
const TICKER_SORT_SQL: Record<TickerSort, string> = {
  trades: 'trade_count',
  volume: 'est_volume',
  members: 'member_count',
  netflow: 'est_net_flow',
  buys: 'buy_count',
  sells: 'sell_count',
};
export function asTickerSort(v: unknown): TickerSort {
  return typeof v === 'string' && v in TICKER_SORT_SQL ? (v as TickerSort) : 'trades';
}

export function buildTickerLeaderboardQuery(
  p: CommonFilters & { sort?: TickerSort; limit?: number },
): BuiltQuery {
  const { where, params } = buildCommonFilters({ ...p, tickerNotNull: true });
  const sort = asTickerSort(p.sort);
  const limit = clampLimit(p.limit, 20, 200);
  const sql =
    'SELECT t.ticker AS ticker, sm.name AS name, ' +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    'COUNT(DISTINCT t.filer_id) AS member_count, ' +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'GROUP BY t.ticker ' +
    `ORDER BY ${TICKER_SORT_SQL[sort]} DESC, trade_count DESC ` +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 3. Member leaderboard — "who trades the most?"
// ---------------------------------------------------------------------------

export type MemberSort = 'trades' | 'volume' | 'tickers';
const MEMBER_SORT_SQL: Record<MemberSort, string> = {
  trades: 'trade_count',
  volume: 'est_volume',
  tickers: 'unique_tickers',
};
export function asMemberSort(v: unknown): MemberSort {
  return typeof v === 'string' && v in MEMBER_SORT_SQL ? (v as MemberSort) : 'trades';
}

export function buildMemberLeaderboardQuery(
  p: CommonFilters & { sort?: MemberSort; limit?: number },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = ['t.filer_id IS NOT NULL', ...where];
  const sort = asMemberSort(p.sort);
  const limit = clampLimit(p.limit, 20, 200);
  const sql =
    'SELECT t.filer_id AS filer_id, fl.full_name AS full_name, fl.party AS party, ' +
    `${CHAMBER_EXPR} AS chamber, fl.state AS state, fl.photo_url AS photo_url, ` +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers, ` +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY t.filer_id ' +
    `ORDER BY ${MEMBER_SORT_SQL[sort]} DESC, trade_count DESC ` +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 4. Cluster / consensus buys — the strongest noise filter
// ---------------------------------------------------------------------------

/** Tickers where >= minMembers distinct members traded the SAME direction in
 *  the window. The headline "N members bought X" signal. */
export function buildClusterBuysQuery(
  p: CommonFilters & { minMembers?: number; limit?: number },
): BuiltQuery {
  const { where, params } = buildCommonFilters({ ...p, tickerNotNull: true, txTypes: ['P', 'S'] });
  const minMembers = clampLimit(p.minMembers, 3, 50);
  const limit = clampLimit(p.limit, 12, 100);
  const sql =
    'SELECT t.ticker AS ticker, t.tx_type AS tx_type, sm.name AS name, ' +
    'COUNT(DISTINCT t.filer_id) AS member_count, ' +
    'COUNT(*) AS trade_count, ' +
    'MIN(t.tx_date) AS first_seen, MAX(t.tx_date) AS last_seen, ' +
    `SUM(${MID}) AS est_volume, ` +
    `COUNT(DISTINCT CASE WHEN ${PARTY_BUCKET_SQL} = 'D' THEN t.filer_id END) AS d_members, ` +
    `COUNT(DISTINCT CASE WHEN ${PARTY_BUCKET_SQL} = 'R' THEN t.filer_id END) AS r_members, ` +
    `COUNT(DISTINCT CASE WHEN ${PARTY_BUCKET_SQL} = 'O' THEN t.filer_id END) AS o_members ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'GROUP BY t.ticker, t.tx_type ' +
    `HAVING COUNT(DISTINCT t.filer_id) >= ${minMembers} ` +
    'ORDER BY member_count DESC, trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

/** Follow-up: per-member trade counts for a set of cluster tickers, so the route
 *  can attach a few representative member faces to each cluster card. */
export function buildClusterMembersQuery(
  tickers: string[],
  p: CommonFilters,
): BuiltQuery {
  const { where, params } = buildCommonFilters({ ...p, txTypes: ['P', 'S'] });
  const placeholders = tickers.map(() => '?').join(', ');
  const allWhere = [`t.ticker IN (${placeholders})`, ...where];
  const allParams: SqlParam[] = [...tickers, ...params];
  const sql =
    'SELECT t.ticker AS ticker, t.tx_type AS tx_type, t.filer_id AS filer_id, ' +
    'fl.full_name AS full_name, fl.party AS party, fl.photo_url AS photo_url, ' +
    'COUNT(*) AS trade_count ' +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY t.ticker, t.tx_type, t.filer_id ' +
    'ORDER BY trade_count DESC';
  return { sql, params: allParams };
}

// ---------------------------------------------------------------------------
// 5. Trending / momentum — recent period vs prior equal period
// ---------------------------------------------------------------------------

/** Map a window to (recentOffset, priorStartOffset) day modifiers: the recent
 *  period is the window, the prior period is the equal-length span before it.
 *  'all' has no natural prior period, so it falls back to a 30-day comparison. */
export function momentumOffsets(w: Window): { recent: string; priorStart: string } {
  const d = windowDays(w) ?? 30;
  return { recent: `-${d} days`, priorStart: `-${2 * d} days` };
}

/**
 * Tickers heating up: trade count in the recent period vs the prior equal-length
 * period, ranked by the increase. The recent/prior date literals come from the
 * validated window (a closed set), so they are interpolated, not bound — which
 * keeps the many SELECT-side date references from scrambling param order.
 */
export function buildTrendingQuery(
  p: Omit<CommonFilters, 'window'> & { window?: Window; limit?: number },
): BuiltQuery {
  const w = p.window ?? '30d';
  const { recent, priorStart } = momentumOffsets(w);
  const recentLit = `date('now', '${recent}')`;
  const priorLit = `date('now', '${priorStart}')`;
  const limit = clampLimit(p.limit, 20, 100);

  // Build filters WITHOUT the window clause (we manage the date range manually).
  const { where, params } = buildCommonFilters({ ...p, window: 'all', tickerNotNull: true });
  const allWhere = [`t.tx_date >= ${priorLit}`, ...where];

  const recentCount = `SUM(CASE WHEN t.tx_date >= ${recentLit} THEN 1 ELSE 0 END)`;
  const priorCount = `SUM(CASE WHEN t.tx_date < ${recentLit} THEN 1 ELSE 0 END)`;
  const recentMembers = `COUNT(DISTINCT CASE WHEN t.tx_date >= ${recentLit} THEN t.filer_id END)`;
  const recentVol = `SUM(CASE WHEN t.tx_date >= ${recentLit} THEN ${MID} ELSE 0 END)`;
  const recentNet = `SUM(CASE WHEN t.tx_date >= ${recentLit} THEN ${SIGNED} ELSE 0 END)`;

  const sql =
    'SELECT t.ticker AS ticker, sm.name AS name, ' +
    `${recentCount} AS recent_count, ` +
    `${priorCount} AS prior_count, ` +
    `${recentMembers} AS recent_members, ` +
    `${recentVol} AS recent_volume, ` +
    `${recentNet} AS recent_net_flow ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(allWhere) +
    'GROUP BY t.ticker ' +
    'HAVING recent_count > 0 ' +
    'ORDER BY (recent_count - prior_count) DESC, recent_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 6. Volume over time — buys vs sells per period
// ---------------------------------------------------------------------------

export function buildVolumeOverTimeQuery(
  p: CommonFilters & { granularity: Granularity },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = ['t.tx_date IS NOT NULL', ...where];
  const sql =
    'SELECT strftime(?, t.tx_date) AS period, ' +
    `${BUY} AS buys, ${SELL} AS sells, ` +
    `SUM(CASE WHEN t.tx_type = 'P' THEN ${MID} ELSE 0 END) AS est_buy_vol, ` +
    `SUM(CASE WHEN t.tx_type = 'S' THEN ${MID} ELSE 0 END) AS est_sell_vol ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY period ORDER BY period ASC';
  // strftime() format is a SELECT-side bind → must precede the WHERE params.
  return { sql, params: [granularityFormat(p.granularity), ...params] };
}

// ---------------------------------------------------------------------------
// 7. Party split — D vs R vs Other
// ---------------------------------------------------------------------------

/** Overall buys/sells/volume/net per party bucket. */
export function buildPartySplitQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const sql =
    `SELECT ${PARTY_BUCKET_SQL} AS party, ` +
    `${BUY} AS buys, ${SELL} AS sells, ` +
    `SUM(${MID}) AS est_volume, SUM(${SIGNED}) AS est_net_flow, ` +
    'COUNT(DISTINCT t.filer_id) AS members ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    'GROUP BY party';
  return { sql, params };
}

/** Party buys/sells per time period (for the stacked time chart). */
export function buildPartySplitOverTimeQuery(
  p: CommonFilters & { granularity: Granularity },
): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = ['t.tx_date IS NOT NULL', ...where];
  const sql =
    `SELECT strftime(?, t.tx_date) AS period, ${PARTY_BUCKET_SQL} AS party, ` +
    `${BUY} AS buys, ${SELL} AS sells ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY period, party ORDER BY period ASC';
  return { sql, params: [granularityFormat(p.granularity), ...params] };
}

// ---------------------------------------------------------------------------
// 8. Sector breakdown — by asset_type (the only classification we have)
// ---------------------------------------------------------------------------

export function buildSectorBreakdownQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 20, 100);
  const sql =
    "SELECT COALESCE(NULLIF(t.asset_type, ''), 'Unknown') AS asset_type, " +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `SUM(${MID}) AS est_volume, ` +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers ` +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    'GROUP BY asset_type ORDER BY trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 8b. Real GICS sector flow + market-cap tilt (from securities_ref enrichment)
// ---------------------------------------------------------------------------

/**
 * Net buy/sell flow by REAL GICS sector (securities_ref.sector) — distinct from
 * buildSectorBreakdownQuery, which groups by the free-text `asset_type` (an
 * instrument class, not a sector). Resolved tickers only; un-enriched/unknown
 * sectors collapse to 'Unknown'. Reports signed net flow so a sector's
 * accumulation vs distribution is visible, plus member/ticker breadth.
 */
export function buildSectorFlowQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 20, 100);
  const allWhere = [TICKER_RESOLVED_SQL, ...where];
  const sql =
    "SELECT COALESCE(NULLIF(sr.sector, ''), 'Unknown') AS sector, " +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow, ` +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    'COUNT(DISTINCT t.ticker) AS unique_tickers ' +
    ANALYTICS_FROM_JOINS_REF +
    whereSql(allWhere) +
    'GROUP BY sector ORDER BY trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

/**
 * Net flow + activity by market-cap bucket (securities_ref.market_cap_bucket:
 * mega…nano). Surfaces a size tilt (e.g. concentration in small/micro caps).
 * Resolved tickers only; un-enriched rows collapse to 'unknown'.
 */
export function buildMarketCapBreakdownQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = [TICKER_RESOLVED_SQL, ...where];
  const sql =
    "SELECT COALESCE(NULLIF(sr.market_cap_bucket, ''), 'unknown') AS bucket, " +
    'COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `SUM(${MID}) AS est_volume, ` +
    `SUM(${SIGNED}) AS est_net_flow, ` +
    'COUNT(DISTINCT t.filer_id) AS unique_members, ' +
    'COUNT(DISTINCT t.ticker) AS unique_tickers ' +
    ANALYTICS_FROM_JOINS_REF +
    whereSql(allWhere) +
    'GROUP BY bucket';
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 9. Filing lag — disclosure timeliness
// ---------------------------------------------------------------------------

/** Histogram of (filed_date - tx_date) in whole days. Negatives (filed before
 *  the trade — data noise) are excluded. Summarized in the Worker. */
export function buildFilingLagHistogramQuery(p: CommonFilters): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const allWhere = [
    't.tx_date IS NOT NULL',
    'f.filed_date IS NOT NULL',
    'julianday(f.filed_date) >= julianday(t.tx_date)',
    ...where,
  ];
  const sql =
    'SELECT CAST(julianday(f.filed_date) - julianday(t.tx_date) AS INTEGER) AS lag_days, ' +
    'COUNT(*) AS cnt ' +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY lag_days';
  return { sql, params };
}

/** Per-member average/max/late-count disclosure lag (the "late filers" board). */
export function buildLateFilersQuery(p: CommonFilters & { limit?: number }): BuiltQuery {
  const { where, params } = buildCommonFilters(p);
  const limit = clampLimit(p.limit, 15, 100);
  const lag = '(julianday(f.filed_date) - julianday(t.tx_date))';
  const allWhere = [
    't.filer_id IS NOT NULL',
    't.tx_date IS NOT NULL',
    'f.filed_date IS NOT NULL',
    `julianday(f.filed_date) >= julianday(t.tx_date)`,
    ...where,
  ];
  const sql =
    'SELECT t.filer_id AS filer_id, fl.full_name AS full_name, fl.party AS party, ' +
    `${CHAMBER_EXPR} AS chamber, fl.photo_url AS photo_url, ` +
    `AVG(${lag}) AS avg_lag_days, MAX(${lag}) AS max_lag_days, ` +
    `SUM(CASE WHEN ${lag} > 45 THEN 1 ELSE 0 END) AS late_count, ` +
    'COUNT(*) AS trade_count ' +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY t.filer_id ' +
    'HAVING trade_count >= 3 ' +
    'ORDER BY avg_lag_days DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 10. Single-ticker deep dive
// ---------------------------------------------------------------------------

function tickerFilters(ticker: string, p: CommonFilters): { where: string[]; params: SqlParam[] } {
  const { where, params } = buildCommonFilters(p);
  return { where: ['t.ticker = ?', ...where], params: [ticker.toUpperCase(), ...params] };
}

export function buildTickerSummaryQuery(ticker: string, p: CommonFilters): BuiltQuery {
  const { where, params } = tickerFilters(ticker, p);
  const sql =
    'SELECT COUNT(*) AS total_trades, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    'COUNT(DISTINCT t.filer_id) AS member_count, ' +
    `SUM(${MID}) AS est_volume, SUM(${SIGNED}) AS est_net_flow, ` +
    'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where);
  return { sql, params };
}

export function buildTickerTimeSeriesQuery(
  ticker: string,
  p: CommonFilters & { granularity: Granularity },
): BuiltQuery {
  const { where, params } = tickerFilters(ticker, p);
  const allWhere = [...where, 't.tx_date IS NOT NULL'];
  const sql =
    'SELECT strftime(?, t.tx_date) AS period, ' +
    `${BUY} AS buys, ${SELL} AS sells ` +
    ANALYTICS_FROM_JOINS +
    whereSql(allWhere) +
    'GROUP BY period ORDER BY period ASC';
  return { sql, params: [granularityFormat(p.granularity), ...params] };
}

/** Top buyers (txType 'P') or sellers ('S') of one ticker. */
export function buildTickerTopTradersQuery(
  ticker: string,
  txType: 'P' | 'S',
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = tickerFilters(ticker, { ...p, txTypes: [txType] });
  const limit = clampLimit(p.limit, 5, 50);
  const sql =
    'SELECT t.filer_id AS filer_id, fl.full_name AS full_name, fl.party AS party, ' +
    'fl.photo_url AS photo_url, COUNT(*) AS trade_count, ' +
    `SUM(${MID}) AS est_volume ` +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    'GROUP BY t.filer_id ORDER BY est_volume DESC, trade_count DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

export function buildTickerRecentTradesQuery(
  ticker: string,
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = tickerFilters(ticker, p);
  const limit = clampLimit(p.limit, 15, 100);
  const sql =
    'SELECT t.id AS id, t.doc_id AS doc_id, t.tx_date AS tx_date, t.tx_type AS tx_type, t.owner AS owner, ' +
    't.amount_min AS amount_min, t.amount_max AS amount_max, t.is_option AS is_option, ' +
    't.created_at AS created_at, t.filer_id AS filer_id, fl.full_name AS full_name, ' +
    'fl.party AS party, fl.photo_url AS photo_url, f.filed_date AS filed_date, ' +
    'f.first_seen_at AS first_seen_at, f.source_url AS source_url ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where) +
    'ORDER BY t.tx_date DESC, t.cursor_seq DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// 11. Single-member (politician) deep dive
// ---------------------------------------------------------------------------

function memberFilters(filerId: string, p: CommonFilters): { where: string[]; params: SqlParam[] } {
  const { where, params } = buildCommonFilters(p);
  return { where: ['t.filer_id = ?', ...where], params: [filerId, ...params] };
}

/** Aggregate stats for one member: trade counts, distinct tickers, est volume +
 *  net flow, and average disclosure lag. */
export function buildMemberStatsQuery(filerId: string, p: CommonFilters): BuiltQuery {
  const { where, params } = memberFilters(filerId, p);
  const lag =
    'AVG(CASE WHEN t.tx_date IS NOT NULL AND f.filed_date IS NOT NULL ' +
    'AND julianday(f.filed_date) >= julianday(t.tx_date) ' +
    'THEN julianday(f.filed_date) - julianday(t.tx_date) END)';
  const sql =
    'SELECT COUNT(*) AS total_trades, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, ` +
    `COUNT(DISTINCT CASE WHEN ${TICKER_RESOLVED_SQL} THEN t.ticker END) AS unique_tickers, ` +
    `SUM(${MID}) AS est_volume, SUM(${SIGNED}) AS est_net_flow, ` +
    `${lag} AS avg_lag_days, ` +
    'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
    ANALYTICS_FROM_JOINS +
    whereSql(where);
  return { sql, params };
}

/**
 * Per-trade performance anchors for one member's trades, backing the realized
 * "skill" aggregate (see aggregateMemberPerformance). Joins the cached
 * tx_performance anchor (price + S&P at the trade date) and the security's
 * current price. Returns every windowed trade; the aggregator excludes options
 * and unpriced rows so callers can report tradeCount vs scoredCount.
 */
export function buildMemberPerformanceQuery(filerId: string, p: CommonFilters): BuiltQuery {
  const { where, params } = memberFilters(filerId, p);
  const sql =
    'SELECT t.is_option AS is_option, txp.price_at_trade AS price_at_trade, ' +
    'txp.spx_at_trade AS spx_at_trade, sr.current_price AS current_price ' +
    ANALYTICS_FROM_JOINS +
    'LEFT JOIN tx_performance txp ON txp.tx_id = t.id ' +
    'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ' +
    whereSql(where);
  return { sql, params };
}

/** Most-traded tickers for one member. */
export function buildMemberTopTickersQuery(
  filerId: string,
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = memberFilters(filerId, { ...p, tickerNotNull: true });
  const limit = clampLimit(p.limit, 5, 50);
  const sql =
    'SELECT t.ticker AS ticker, sm.name AS name, COUNT(*) AS trade_count, ' +
    `${BUY} AS buy_count, ${SELL} AS sell_count, SUM(${MID}) AS est_volume ` +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'GROUP BY t.ticker ORDER BY trade_count DESC, est_volume DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}

/** Most-recent trades for one member (for the politician drawer's mini-list). */
export function buildMemberRecentTradesQuery(
  filerId: string,
  p: CommonFilters & { limit?: number },
): BuiltQuery {
  const { where, params } = memberFilters(filerId, p);
  const limit = clampLimit(p.limit, 10, 100);
  const sql =
    'SELECT t.id AS id, t.doc_id AS doc_id, t.ticker AS ticker, t.asset_name AS asset_name, ' +
    't.tx_type AS tx_type, t.tx_date AS tx_date, t.owner AS owner, t.is_option AS is_option, ' +
    't.amount_min AS amount_min, t.amount_max AS amount_max, t.created_at AS created_at, sm.name AS name, ' +
    'f.filed_date AS filed_date, f.first_seen_at AS first_seen_at, f.source_url AS source_url ' +
    ANALYTICS_FROM_JOINS_SECURITIES +
    whereSql(where) +
    'ORDER BY t.tx_date DESC, t.cursor_seq DESC ' +
    `LIMIT ${limit}`;
  return { sql, params };
}
