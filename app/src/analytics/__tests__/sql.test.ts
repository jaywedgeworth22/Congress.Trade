/**
 * src/analytics/__tests__/sql.test.ts
 *
 * Unit tests for the shared analytics SQL fragments + filter builder. Pure +
 * deterministic (no DB): assert generated clauses, bound-param order, and the
 * input validators.
 */

import { describe, it, expect } from 'vitest';
import {
  BRACKET_MIDPOINT_SQL,
  PARTY_BUCKET_SQL,
  asChamber,
  asPartyBucket,
  asSourceFilter,
  asWindow,
  autoGranularity,
  buildCommonFilters,
  clampLimit,
  granularityFormat,
  isWindow,
  whereSql,
  windowToOffset,
} from '../sql.ts';

describe('validators', () => {
  it('asWindow accepts preset + custom <N>d windows and falls back otherwise', () => {
    expect(asWindow('7d')).toBe('7d');
    expect(asWindow('all')).toBe('all');
    expect(asWindow('180d')).toBe('180d'); // preset (past 6 months)
    expect(asWindow('1825d')).toBe('1825d'); // preset (past 5 years)
    expect(asWindow('45d')).toBe('45d'); // custom age via API
    expect(asWindow('nonsense')).toBe('90d'); // default fallback (recent, not all-time)
    expect(asWindow('0d')).toBe('90d'); // must be >= 1 day → default fallback
    expect(asWindow('nonsense', '30d')).toBe('30d'); // explicit fallback still honored
    expect(asWindow(undefined, '90d')).toBe('90d');
    expect(isWindow('365d')).toBe(true);
    expect(isWindow('5y')).toBe(false); // only <N>d or 'all'
  });

  it('windowToOffset handles presets and custom ages', () => {
    expect(windowToOffset('1d')).toBe('-1 days');
    expect(windowToOffset('180d')).toBe('-180 days');
    expect(windowToOffset('1825d')).toBe('-1825 days');
    expect(windowToOffset('45d')).toBe('-45 days');
  });

  it('autoGranularity scales the bucket to the window length', () => {
    expect(autoGranularity('1d')).toBe('day');
    expect(autoGranularity('30d')).toBe('day');
    expect(autoGranularity('90d')).toBe('week');
    expect(autoGranularity('180d')).toBe('month');
    expect(autoGranularity('1825d')).toBe('month');
    expect(autoGranularity('all')).toBe('month');
  });

  it('asPartyBucket maps first letter to D/R/O (I→O), else undefined', () => {
    expect(asPartyBucket('Democrat')).toBe('D');
    expect(asPartyBucket('R')).toBe('R');
    expect(asPartyBucket('Independent')).toBe('O');
    expect(asPartyBucket('Other')).toBe('O');
    expect(asPartyBucket('')).toBeUndefined();
    expect(asPartyBucket(undefined)).toBeUndefined();
  });

  it('asChamber / asSourceFilter validate against known sets', () => {
    expect(asChamber('house')).toBe('house');
    expect(asChamber('xyz')).toBeUndefined();
    expect(asSourceFilter('primary')).toBe('primary');
    expect(asSourceFilter('bogus')).toBe('all');
  });

  it('windowToOffset returns null only for "all"', () => {
    expect(windowToOffset('7d')).toBe('-7 days');
    expect(windowToOffset('365d')).toBe('-365 days');
    expect(windowToOffset('all')).toBeNull();
  });

  it('clampLimit clamps to [1,max] with a fallback', () => {
    expect(clampLimit(undefined, 20, 200)).toBe(20);
    expect(clampLimit(0, 20, 200)).toBe(20);
    expect(clampLimit(-5, 20, 200)).toBe(20);
    expect(clampLimit(5000, 20, 200)).toBe(200);
    expect(clampLimit(37.9, 20, 200)).toBe(37);
  });

  it('granularity helpers map windows to strftime formats', () => {
    expect(autoGranularity('7d')).toBe('day');
    expect(autoGranularity('90d')).toBe('week');
    expect(autoGranularity('365d')).toBe('month');
    expect(granularityFormat('day')).toBe('%Y-%m-%d');
    expect(granularityFormat('week')).toBe('%Y-%W');
    expect(granularityFormat('month')).toBe('%Y-%m');
  });
});

describe('SQL fragments', () => {
  it('bracket midpoint guards the open-ended top tier (amount_max IS NULL)', () => {
    expect(BRACKET_MIDPOINT_SQL).toContain('t.amount_max IS NOT NULL');
    expect(BRACKET_MIDPOINT_SQL).toContain('(t.amount_min + t.amount_max) / 2.0');
  });

  it('party bucket classifies known parties and leaves unknown as NULL', () => {
    expect(PARTY_BUCKET_SQL).toContain("= 'D'");
    expect(PARTY_BUCKET_SQL).toContain("= 'R'");
    expect(PARTY_BUCKET_SQL).toContain("IN ('I', 'O') THEN 'O'");
    expect(PARTY_BUCKET_SQL).toContain('ELSE NULL');
  });
});

describe('buildCommonFilters', () => {
  it('always excludes retracted rows, then the 30-day window with the offset as the first param', () => {
    const { where, params } = buildCommonFilters({});
    expect(where[0]).toBe('t.deprecated_at IS NULL');
    expect(where[1]).toBe("t.tx_date >= date('now', ?)");
    expect(params[0]).toBe('-30 days');
  });

  it('window="all" drops the date clause entirely (but keeps the retracted guard)', () => {
    const { where, params } = buildCommonFilters({ window: 'all' });
    expect(where.join(' ')).not.toContain('tx_date >=');
    expect(where).toContain('t.deprecated_at IS NULL');
    expect(params).toEqual([]);
  });

  it('emits chamber/party/source/minConf clauses in order', () => {
    const { where, params } = buildCommonFilters({
      window: '90d',
      chamber: 'senate',
      party: 'D',
      source: 'primary',
      minConf: 0.7,
    });
    expect(where).toEqual([
      't.deprecated_at IS NULL',
      "t.tx_date >= date('now', ?)",
      'COALESCE(fl.chamber, f.chamber) = ?',
      `${PARTY_BUCKET_SQL} = ?`,
      't.source = ?',
      't.confidence >= ?',
    ]);
    expect(params).toEqual(['-90 days', 'senate', 'D', 'primary', 0.7]);
  });

  it('source="all" applies no source clause', () => {
    const { where } = buildCommonFilters({ source: 'all' });
    expect(where.join(' ')).not.toContain('t.source');
  });

  it('tickerNotNull and txTypes expand to the expected clauses + params', () => {
    const { where, params } = buildCommonFilters({
      window: 'all',
      tickerNotNull: true,
      txTypes: ['P', 'S'],
    });
    expect(where).toContain("(t.ticker IS NOT NULL AND t.ticker <> '')");
    expect(where.some((w) => w.includes('t.tx_type IN (?, ?)'))).toBe(true);
    expect(params).toEqual(['P', 'S']);
  });

  it('tickers expands to an IN-list with one bind per ticker', () => {
    const { where, params } = buildCommonFilters({ window: 'all', tickers: ['AAPL', 'MSFT', 'NVDA'] });
    expect(where.some((w) => w === 't.ticker IN (?, ?, ?)')).toBe(true);
    expect(params).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('excludeOptions adds an is_option = 0 clause (no bind), off by default', () => {
    const { where, params } = buildCommonFilters({ window: 'all', excludeOptions: true });
    expect(where).toContain('t.is_option = 0');
    expect(params).toEqual([]);
    expect(buildCommonFilters({ window: 'all' }).where).not.toContain('t.is_option = 0');
  });

  it('whereSql renders a clause with a trailing space, or empty', () => {
    expect(whereSql([])).toBe('');
    expect(whereSql(['a = ?', 'b = ?'])).toBe('WHERE a = ? AND b = ? ');
  });
});
