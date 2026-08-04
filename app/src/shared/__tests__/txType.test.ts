import { describe, expect, it } from 'vitest';
import { canonicalizeTxType } from '../txType.ts';

describe('canonicalizeTxType', () => {
  it('maps competitor aliases', () => {
    expect(canonicalizeTxType('purchase')).toBe('P');
    expect(canonicalizeTxType('buy')).toBe('P');
    expect(canonicalizeTxType('sale_full')).toBe('S');
    expect(canonicalizeTxType('sale_partial')).toBe('S');
    expect(canonicalizeTxType('exchange')).toBe('E');
    expect(canonicalizeTxType('P')).toBe('P');
  });

  it('returns null for empty/unknown', () => {
    expect(canonicalizeTxType('')).toBeNull();
    expect(canonicalizeTxType('n/a')).toBeNull();
  });
});
