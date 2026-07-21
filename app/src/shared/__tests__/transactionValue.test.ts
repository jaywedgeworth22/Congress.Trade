import { describe, expect, it } from 'vitest';
import { estimateTransactionValue } from '../transactionValue.ts';

describe('estimateTransactionValue', () => {
  it('matches the materialized est_value migration for every null case', () => {
    expect(estimateTransactionValue(null, null)).toBe(0);
    expect(estimateTransactionValue(null, 15_000)).toBe(15_000);
    expect(estimateTransactionValue(1_001, null)).toBe(1_001);
    expect(estimateTransactionValue(1_001, 15_000)).toBe(8_000.5);
  });
});
