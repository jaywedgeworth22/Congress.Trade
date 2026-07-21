import { describe, it, expect } from "vitest";
import {
  STOCK_ACT_BRACKETS,
  matchBracket,
  isValidBracket,
  nearestBracket,
} from "../brackets";

describe("STOCK Act brackets helpers", () => {
  it("defines the canonical 10 brackets in ascending order", () => {
    expect(STOCK_ACT_BRACKETS).toHaveLength(10);
    expect(STOCK_ACT_BRACKETS[0]).toEqual({ min: 1001, max: 15000 });
    expect(STOCK_ACT_BRACKETS[9]).toEqual({ min: 50000001, max: null });
    expect(Object.isFrozen(STOCK_ACT_BRACKETS)).toBe(true);
    expect(STOCK_ACT_BRACKETS.every(Object.isFrozen)).toBe(true);

    for (let i = 1; i < STOCK_ACT_BRACKETS.length; i++) {
      expect(STOCK_ACT_BRACKETS[i].min).toBeGreaterThan(STOCK_ACT_BRACKETS[i - 1].min);
    }
  });

  it("matches brackets exactly", () => {
    expect(matchBracket(1001, 15000)).toEqual({ min: 1001, max: 15000 });
    expect(matchBracket(50000001, null)).toEqual({ min: 50000001, max: null });
    expect(matchBracket(1000, 15000)).toBeNull();
    expect(matchBracket(1001, 15001)).toBeNull();
  });

  it("validates brackets", () => {
    expect(isValidBracket(1001, 15000)).toBe(true);
    expect(isValidBracket(50000001, null)).toBe(true);
    expect(isValidBracket(50000, 100000)).toBe(false);
  });

  it("finds the nearest containing bracket", () => {
    // Exact snap
    expect(nearestBracket(1001, 15000)).toEqual({ min: 1001, max: 15000 });
    // Arbitrary containing snap
    expect(nearestBracket(5000, 10000)).toEqual({ min: 1001, max: 15000 });
    expect(nearestBracket(16000, 45000)).toEqual({ min: 15001, max: 50000 });
    // Open-ended snap
    expect(nearestBracket(60000000, 100000000)).toEqual({ min: 50000001, max: null });
    expect(nearestBracket(60000000, null)).toEqual({ min: 50000001, max: null });
    expect(nearestBracket(50000000, null)).toEqual({ min: 50000001, max: null });
    expect(nearestBracket(1001, null)).toBeNull();
    // Out of bounds lo
    expect(nearestBracket(0, 1000)).toBeNull();
    // Non-finite min
    expect(nearestBracket(NaN, 1000)).toBeNull();
    expect(nearestBracket(Number.POSITIVE_INFINITY, null)).toBeNull();
    // Invalid or non-finite max
    expect(nearestBracket(16000, 14000)).toBeNull();
    expect(nearestBracket(60000000, NaN)).toBeNull();
    expect(nearestBracket(60000000, Number.POSITIVE_INFINITY)).toBeNull();
    // Negative values are not disclosure brackets
    expect(nearestBracket(-1, 1000)).toBeNull();
  });
});
