import { describe, it, expect } from 'vitest';
import {
  STOCK_ACT_BRACKETS,
  matchBracket,
  isValidBracket,
  nearestBracket,
} from '../brackets.ts';

describe('STOCK_ACT_BRACKETS (shared re-export)', () => {
  it('includes the product $0–$1,000 tier first', () => {
    expect(STOCK_ACT_BRACKETS[0]).toEqual({ min: 0, max: 1000 });
    expect(STOCK_ACT_BRACKETS).toHaveLength(11);
    expect(isValidBracket(0, 1000)).toBe(true);
    expect(matchBracket(0, 1000)).toEqual({ min: 0, max: 1000 });
  });

  it('snaps exact sub-$1,001 dollars into $0–$1,000', () => {
    expect(nearestBracket(456, 456)).toEqual({ min: 0, max: 1000 });
    expect(nearestBracket(1, 999)).toEqual({ min: 0, max: 1000 });
    expect(nearestBracket(0, 1000)).toEqual({ min: 0, max: 1000 });
  });

  it('still matches the classic $1,001–$15,000 band', () => {
    expect(nearestBracket(5000, 10000)).toEqual({ min: 1001, max: 15000 });
    expect(isValidBracket(1001, 15000)).toBe(true);
  });
});
