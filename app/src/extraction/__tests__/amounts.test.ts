import { describe, it, expect } from 'vitest';
import { parseAmountRange } from '../amounts.ts';
import { isValidBracket } from '../../shared/brackets.ts';

describe('parseAmountRange -> canonical bracket', () => {
  it('parses a standard hyphen range', () => {
    const r = parseAmountRange('$1,001 - $15,000');
    expect(r).toMatchObject({ min: 1001, max: 15000, exact: true });
    expect(isValidBracket(r.min!, r.max)).toBe(true);
  });

  it('parses an en-dash range', () => {
    const r = parseAmountRange('$15,001–$50,000');
    expect(r).toMatchObject({ min: 15001, max: 50000, exact: true });
  });

  it('parses a "to" range', () => {
    const r = parseAmountRange('$50,001 to $100,000');
    expect(r).toMatchObject({ min: 50001, max: 100000, exact: true });
  });

  it('parses the open-ended top tier', () => {
    const r = parseAmountRange('$50,000,001 +');
    expect(r.min).toBe(50000001);
    expect(r.max).toBeNull();
    expect(isValidBracket(r.min!, r.max)).toBe(true);
  });

  it('handles "Over $50,000,000" as the open top tier', () => {
    const r = parseAmountRange('Over $50,000,000');
    expect(r.min).toBe(50000001);
    expect(r.max).toBeNull();
  });

  it('returns nulls for empty/garbage', () => {
    expect(parseAmountRange('')).toMatchObject({ min: null, max: null, exact: false });
    expect(parseAmountRange('n/a')).toMatchObject({ min: null, max: null });
  });

  it('every canonical bracket round-trips to a valid bracket', () => {
    const samples: Array<[string, number, number | null]> = [
      ['$0 - $1,000', 0, 1000],
      ['$1,001 - $15,000', 1001, 15000],
      ['$100,001 - $250,000', 100001, 250000],
      ['$1,000,001 - $5,000,000', 1000001, 5000000],
    ];
    for (const [raw, min, max] of samples) {
      const r = parseAmountRange(raw);
      expect(r.min).toBe(min);
      expect(r.max).toBe(max);
      expect(isValidBracket(r.min!, r.max)).toBe(true);
    }
  });

  it('snaps exact sub-$1,001 dollar amounts onto the $0–$1,000 tier', () => {
    const r = parseAmountRange('$456.00');
    expect(r).toMatchObject({ min: 0, max: 1000, exact: true });
    expect(isValidBracket(r.min!, r.max)).toBe(true);
    const r2 = parseAmountRange('$1,000');
    expect(r2).toMatchObject({ min: 0, max: 1000, exact: true });
  });
});
