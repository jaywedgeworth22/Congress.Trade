import { describe, expect, it } from 'vitest';
import { buildTransactionsQuery, buildTransactionsCountQuery } from '../rows.ts';
import { matchesFiltersWithChamber } from '../subscriptions.ts';
import { buildCommonFilters, asChambers } from '../../analytics/sql.ts';
import type { Transaction } from '../../shared/types.ts';

/**
 * "Separate by default" contract for executive (OGE 278-T) rows: they are
 * EXCLUDED from the feed, analytics, and subscription delivery unless a
 * caller explicitly opts in — a single 3,000-row presidential filing must
 * never swamp the congressional views or surprise existing subscribers.
 */

describe('feed default excludes executive', () => {
  it('adds the executive-exclusion clause when no chamber filter is set', () => {
    const q = buildTransactionsQuery({ limit: 10 });
    expect(q.sql).toContain("COALESCE(fl.chamber, f.chamber) <> 'executive'");
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) IS NULL OR');
  });

  it('uses IN(...) for an explicit multi-chamber selection (no default clause)', () => {
    const q = buildTransactionsQuery({ chambers: ['executive', 'house'], limit: 10 });
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) IN (?, ?)');
    expect(q.params).toContain('executive');
    expect(q.params).toContain('house');
    expect(q.sql).not.toContain("<> 'executive'");
  });

  it('keeps the count query consistent with the feed', () => {
    const q = buildTransactionsCountQuery({});
    expect(q.sql).toContain("<> 'executive'");
  });

  it('single-chamber equality still works (back-compat)', () => {
    const q = buildTransactionsQuery({ chamber: 'senate', limit: 10 });
    expect(q.sql).toContain('COALESCE(fl.chamber, f.chamber) = ?');
    expect(q.params).toContain('senate');
  });
});

describe('analytics default excludes executive', () => {
  it('default filters carry the exclusion clause', () => {
    const { where } = buildCommonFilters({ window: '90d' });
    expect(where.join(' AND ')).toContain("<> 'executive'");
  });

  it('explicit chambers list replaces the default clause', () => {
    const { where, params } = buildCommonFilters({ window: '90d', chambers: ['executive'] });
    const sql = where.join(' AND ');
    expect(sql).toContain('IN (?)');
    expect(sql).not.toContain("<> 'executive'");
    expect(params).toContain('executive');
  });

  it('asChambers parses, validates, dedupes, and sorts CSV input', () => {
    expect(asChambers('senate,executive,house,senate')).toEqual(['executive', 'house', 'senate']);
    expect(asChambers('executive')).toEqual(['executive']);
    expect(asChambers('bogus,also-bogus')).toBeUndefined();
    expect(asChambers('')).toBeUndefined();
    expect(asChambers(undefined)).toBeUndefined();
  });
});

describe('subscription delivery default excludes executive', () => {
  const tx = { id: 't1', ticker: 'NVDA', txType: 'P', amountMin: 1001, amountMax: 15000 } as unknown as Transaction;

  it('a subscription with NO chambers filter never receives executive rows', () => {
    expect(matchesFiltersWithChamber(tx, {}, 'house')).toBe(true);
    expect(matchesFiltersWithChamber(tx, {}, null)).toBe(true);
    expect(matchesFiltersWithChamber(tx, {}, 'executive')).toBe(false);
  });

  it('an explicit chambers filter including executive receives them', () => {
    expect(matchesFiltersWithChamber(tx, { chambers: ['executive'] as never }, 'executive')).toBe(true);
    expect(matchesFiltersWithChamber(tx, { chambers: ['house'] as never }, 'executive')).toBe(false);
  });
});
