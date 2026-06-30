/**
 * src/analytics/__tests__/conflicts.test.ts
 *
 * Unit tests for the committee conflict-of-interest matcher. Pure, no DB.
 */

import { describe, it, expect } from 'vitest';
import { committeeConflict, oversightSectors, COMMITTEE_SECTOR_RULES } from '../conflicts';

describe('committeeConflict', () => {
  it('flags a politician on a committee that oversees the traded sector', () => {
    const r = committeeConflict(['Committee on Armed Services'], 'Industrials');
    expect(r.conflict).toBe(true);
    expect(r.sector).toBe('Industrials');
    expect(r.viaCommittees).toEqual(['Committee on Armed Services']);
  });

  it('does NOT flag a sector outside the committee oversight', () => {
    const r = committeeConflict(['Committee on Armed Services'], 'Health Care');
    expect(r.conflict).toBe(false);
    expect(r.viaCommittees).toEqual([]);
  });

  it('matches free-text committee name variants by substring (chamber prefixes, etc.)', () => {
    expect(committeeConflict(['House Financial Services'], 'Financials').conflict).toBe(true);
    expect(committeeConflict(['Senate Committee on Banking, Housing, and Urban Affairs'], 'Real Estate').conflict).toBe(true);
    expect(committeeConflict(['Select Committee on Intelligence'], 'Information Technology').conflict).toBe(true);
  });

  it("distinguishes Senate Finance (Health Care/Financials) from Financial Services", () => {
    // "Finance" rule does not fire on "Financial Services" (no 'finance' substring).
    expect(committeeConflict(['Committee on Finance'], 'Health Care').conflict).toBe(true);
    expect(committeeConflict(['Committee on Financial Services'], 'Health Care').conflict).toBe(false);
  });

  it('is case-insensitive on the sector', () => {
    expect(committeeConflict(['Committee on Energy and Commerce'], 'health care').conflict).toBe(true);
  });

  it('returns no conflict for a null/empty sector or no committees', () => {
    expect(committeeConflict(['Committee on Armed Services'], null).conflict).toBe(false);
    expect(committeeConflict([], 'Industrials').conflict).toBe(false);
  });

  it('reports only the committees that actually triggered the flag', () => {
    const r = committeeConflict(
      ['Committee on Armed Services', 'Committee on Agriculture'],
      'Industrials',
    );
    expect(r.viaCommittees).toEqual(['Committee on Armed Services']); // Agriculture != Industrials
  });

  it('tolerates non-string entries in the committees array', () => {
    const r = committeeConflict(['Committee on Armed Services', null as never, 42 as never], 'Industrials');
    expect(r.conflict).toBe(true);
  });
});

describe('oversightSectors', () => {
  it('unions sectors across a politician’s committees', () => {
    const s = oversightSectors(['Committee on Armed Services', 'Committee on Financial Services']);
    expect(s.has('Industrials')).toBe(true);
    expect(s.has('Financials')).toBe(true);
    expect(s.has('Real Estate')).toBe(true);
  });
  it('is empty for committees with no market oversight (e.g. Budget)', () => {
    expect(oversightSectors(['Committee on the Budget']).size).toBe(0);
  });
});

describe('COMMITTEE_SECTOR_RULES', () => {
  it('every rule maps to at least one GICS sector and a lowercase match token', () => {
    for (const rule of COMMITTEE_SECTOR_RULES) {
      expect(rule.match).toBe(rule.match.toLowerCase());
      expect(rule.sectors.length).toBeGreaterThan(0);
    }
  });
});
