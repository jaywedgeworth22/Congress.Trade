/**
 * src/analytics/__tests__/builders.test.ts
 *
 * Unit tests for the analytics query builders. Pure + deterministic (no DB):
 * assert the generated SQL shape, bound-param order, limit/having clamping, and
 * the bracket-midpoint / ticker / sort conventions.
 */

import { describe, it, expect } from 'vitest';
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
  momentumOffsets,
} from '../builders';
import { BRACKET_MIDPOINT_SQL, granularityFormat } from '../sql';

describe('buildSummaryQuery', () => {
  it('aggregates corpus totals and uses the bracket midpoint for $', () => {
    const q = buildSummaryQuery({ window: '30d' });
    expect(q.sql).toContain('COUNT(*) AS total_trades');
    expect(q.sql).toContain('COUNT(DISTINCT t.filer_id) AS unique_members');
    expect(q.sql).toContain(`SUM(${BRACKET_MIDPOINT_SQL}) AS est_volume`);
    expect(q.params).toEqual(['-30 days']);
  });
});

describe('buildTickerLeaderboardQuery', () => {
  it('excludes null tickers, groups by ticker, and joins the securities master', () => {
    const q = buildTickerLeaderboardQuery({ window: 'all' });
    expect(q.sql).toContain("(t.ticker IS NOT NULL AND t.ticker <> '')");
    expect(q.sql).toContain('GROUP BY t.ticker');
    expect(q.sql).toContain('LEFT JOIN securities_master sm');
    expect(q.sql).toContain('ORDER BY trade_count DESC');
    expect(q.sql).toContain('LIMIT 20');
  });

  it('whitelists the sort column (invalid → trades) and clamps the limit', () => {
    expect(asTickerSort('volume')).toBe('volume');
    expect(asTickerSort('netflow')).toBe('netflow');
    expect(asTickerSort('DROP TABLE')).toBe('trades');
    const q = buildTickerLeaderboardQuery({ window: 'all', sort: 'volume', limit: 9999 });
    expect(q.sql).toContain('ORDER BY est_volume DESC');
    expect(q.sql).toContain('LIMIT 200');
  });
});

describe('buildMemberLeaderboardQuery', () => {
  it('requires a filer id, groups by filer, resolves chamber + photo', () => {
    const q = buildMemberLeaderboardQuery({ window: '90d', sort: 'volume' });
    expect(q.sql).toContain('t.filer_id IS NOT NULL');
    expect(q.sql).toContain('GROUP BY t.filer_id');
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) AS chamber');
    expect(q.sql).toContain('ORDER BY est_volume DESC');
    expect(q.params).toEqual(['-90 days']);
    expect(asMemberSort('tickers')).toBe('tickers');
    expect(asMemberSort('nope')).toBe('trades');
  });
});

describe('buildClusterBuysQuery', () => {
  it('filters to P/S, counts distinct members + party split, applies HAVING', () => {
    const q = buildClusterBuysQuery({ window: '30d', minMembers: 4, limit: 10 });
    expect(q.sql).toContain('t.tx_type IN (?, ?)');
    expect(q.sql).toContain('GROUP BY t.ticker, t.tx_type');
    expect(q.sql).toContain('HAVING COUNT(DISTINCT t.filer_id) >= 4');
    expect(q.sql).toContain('AS d_members');
    expect(q.sql).toContain('AS r_members');
    expect(q.sql).toContain('LIMIT 10');
    // window offset first, then the two tx_type params
    expect(q.params).toEqual(['-30 days', 'P', 'S']);
  });

  it('defaults minMembers to 3', () => {
    const q = buildClusterBuysQuery({ window: 'all' });
    expect(q.sql).toContain('HAVING COUNT(DISTINCT t.filer_id) >= 3');
  });
});

describe('buildClusterMembersQuery', () => {
  it('binds the ticker IN-list first, then the common filters', () => {
    const q = buildClusterMembersQuery(['AAPL', 'NVDA'], { window: '30d' });
    expect(q.sql).toContain('t.ticker IN (?, ?)');
    expect(q.sql).toContain('GROUP BY t.ticker, t.tx_type, t.filer_id');
    // tickers first, then window offset, then the P/S tx_type params
    expect(q.params).toEqual(['AAPL', 'NVDA', '-30 days', 'P', 'S']);
  });
});

describe('buildTrendingQuery', () => {
  it('compares recent vs prior windows via inlined date literals', () => {
    const q = buildTrendingQuery({ window: '30d', limit: 15 });
    expect(q.sql).toContain("date('now', '-30 days')");
    expect(q.sql).toContain("date('now', '-60 days')");
    expect(q.sql).toContain('AS recent_count');
    expect(q.sql).toContain('AS prior_count');
    expect(q.sql).toContain('ORDER BY (recent_count - prior_count) DESC');
    expect(q.sql).toContain('LIMIT 15');
    // date range is inlined (whitelisted), so no window param is bound
    expect(q.params).toEqual([]);
  });

  it('momentumOffsets returns a prior period of equal length', () => {
    expect(momentumOffsets('7d')).toEqual({ recent: '-7 days', priorStart: '-14 days' });
    expect(momentumOffsets('90d')).toEqual({ recent: '-90 days', priorStart: '-180 days' });
    expect(momentumOffsets('180d')).toEqual({ recent: '-180 days', priorStart: '-360 days' });
    expect(momentumOffsets('45d')).toEqual({ recent: '-45 days', priorStart: '-90 days' });
    expect(momentumOffsets('all')).toEqual({ recent: '-30 days', priorStart: '-60 days' });
  });
});

describe('buildVolumeOverTimeQuery', () => {
  it('binds the strftime format FIRST, then the window offset', () => {
    const q = buildVolumeOverTimeQuery({ window: '90d', granularity: 'week' });
    expect(q.sql).toContain('strftime(?, t.tx_date) AS period');
    expect(q.sql).toContain('GROUP BY period ORDER BY period ASC');
    expect(q.params).toEqual([granularityFormat('week'), '-90 days']);
  });
});

describe('buildPartySplitQuery', () => {
  it('groups by the party bucket', () => {
    const q = buildPartySplitQuery({ window: '365d' });
    expect(q.sql).toContain('AS party');
    expect(q.sql).toContain('GROUP BY party');
    expect(q.params).toEqual(['-365 days']);
  });
  it('over-time variant binds the format first', () => {
    const q = buildPartySplitOverTimeQuery({ window: '365d', granularity: 'month' });
    expect(q.sql).toContain('strftime(?, t.tx_date)');
    expect(q.params).toEqual([granularityFormat('month'), '-365 days']);
  });
});

describe('buildSectorBreakdownQuery', () => {
  it('buckets the asset_type and coalesces empties to Unknown', () => {
    const q = buildSectorBreakdownQuery({ window: 'all' });
    expect(q.sql).toContain("COALESCE(NULLIF(t.asset_type, ''), 'Unknown') AS asset_type");
    expect(q.sql).toContain('GROUP BY asset_type');
  });
});

describe('filing-lag builders', () => {
  it('histogram excludes negative lags and groups by whole-day lag', () => {
    const q = buildFilingLagHistogramQuery({ window: '90d' });
    expect(q.sql).toContain('CAST(julianday(f.filed_date) - julianday(t.tx_date) AS INTEGER) AS lag_days');
    expect(q.sql).toContain('julianday(f.filed_date) >= julianday(t.tx_date)');
    expect(q.sql).toContain('GROUP BY lag_days');
  });
  it('late filers require >= 3 trades and sort by average lag', () => {
    const q = buildLateFilersQuery({ window: 'all' });
    expect(q.sql).toContain('HAVING trade_count >= 3');
    expect(q.sql).toContain('ORDER BY avg_lag_days DESC');
    expect(q.sql).toContain('AS late_count');
  });
});

describe('member deep-dive builders', () => {
  it('stats filter by filer id (bound first) and average disclosure lag', () => {
    const q = buildMemberStatsQuery('P000197', { window: 'all' });
    expect(q.sql).toContain('t.filer_id = ?');
    expect(q.sql).toContain('AS avg_lag_days');
    expect(q.params).toEqual(['P000197']);
  });
  it('top tickers exclude null tickers and group by ticker', () => {
    const q = buildMemberTopTickersQuery('P000197', { window: '365d' });
    expect(q.sql).toContain("(t.ticker IS NOT NULL AND t.ticker <> '')");
    expect(q.sql).toContain('GROUP BY t.ticker');
    expect(q.params).toEqual(['P000197', '-365 days']);
  });
  it('recent trades order by date desc, carry the source link, clamp limit', () => {
    const q = buildMemberRecentTradesQuery('P000197', { window: 'all', limit: 999 });
    expect(q.sql).toContain('f.source_url AS source_url');
    expect(q.sql).toContain('ORDER BY t.tx_date DESC, t.cursor_seq DESC');
    expect(q.sql).toContain('LIMIT 100');
    expect(q.params).toEqual(['P000197']);
  });
});

describe('ticker deep-dive builders', () => {
  it('summary upper-cases the ticker and binds it first', () => {
    const q = buildTickerSummaryQuery('aapl', { window: '30d' });
    expect(q.sql).toContain('t.ticker = ?');
    expect(q.params).toEqual(['AAPL', '-30 days']);
  });
  it('time series binds the format first, then the ticker, then the window', () => {
    const q = buildTickerTimeSeriesQuery('nvda', { window: '90d', granularity: 'week' });
    expect(q.params).toEqual([granularityFormat('week'), 'NVDA', '-90 days']);
  });
  it('top traders filter by tx type and order by est volume', () => {
    const q = buildTickerTopTradersQuery('AAPL', 'P', { window: 'all' });
    expect(q.sql).toContain('t.tx_type IN (?)');
    expect(q.sql).toContain('ORDER BY est_volume DESC');
    expect(q.params).toEqual(['AAPL', 'P']);
  });
  it('recent trades order by date desc and clamp the limit', () => {
    const q = buildTickerRecentTradesQuery('AAPL', { window: 'all', limit: 999 });
    expect(q.sql).toContain('t.id AS id');
    expect(q.sql).toContain('t.doc_id AS doc_id');
    expect(q.sql).toContain('t.filer_id AS filer_id');
    expect(q.sql).toContain('f.filed_date AS filed_date');
    expect(q.sql).toContain('f.source_url AS source_url');
    expect(q.sql).toContain('ORDER BY t.tx_date DESC, t.cursor_seq DESC');
    expect(q.sql).toContain('LIMIT 100');
  });
});
