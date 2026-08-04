import { describe, expect, it } from 'vitest';
import {
  canonicalizeTxType,
  canonicalizeTxTypeOrBuy,
  txTypeDisplayLetter,
  txTypeLabel,
} from '../txType.ts';

describe('canonicalizeTxType', () => {
  it('maps competitor and form aliases to P|S|E', () => {
    expect(canonicalizeTxType('purchase')).toBe('P');
    expect(canonicalizeTxType('buy')).toBe('P');
    expect(canonicalizeTxType('bought')).toBe('P');
    expect(canonicalizeTxType('B')).toBe('P');
    expect(canonicalizeTxType('b')).toBe('P');
    expect(canonicalizeTxType('sale_full')).toBe('S');
    expect(canonicalizeTxType('sale_partial')).toBe('S');
    expect(canonicalizeTxType('sell')).toBe('S');
    expect(canonicalizeTxType('exchange')).toBe('E');
    expect(canonicalizeTxType('P')).toBe('P');
    expect(canonicalizeTxType('S')).toBe('S');
    expect(canonicalizeTxType('E')).toBe('E');
  });

  it('returns null for empty/unknown', () => {
    expect(canonicalizeTxType('')).toBeNull();
    expect(canonicalizeTxType('n/a')).toBeNull();
  });
});

describe('txTypeLabel / display letter', () => {
  it('uses Buy/Sell/Exchange product labels', () => {
    expect(txTypeLabel('P')).toBe('Buy');
    expect(txTypeLabel('B')).toBe('Buy');
    expect(txTypeLabel('purchase')).toBe('Buy');
    expect(txTypeLabel('S')).toBe('Sell');
    expect(txTypeLabel('sale')).toBe('Sell');
    expect(txTypeLabel('E')).toBe('Exchange');
    expect(txTypeLabel(null)).toBeNull();
  });

  it('maps buy storage P to display letter B', () => {
    expect(txTypeDisplayLetter('P')).toBe('B');
    expect(txTypeDisplayLetter('B')).toBe('B');
    expect(txTypeDisplayLetter('S')).toBe('S');
    expect(txTypeDisplayLetter('E')).toBe('E');
    expect(txTypeDisplayLetter('')).toBeNull();
  });

  it('defaults unknown to Buy via OrBuy', () => {
    expect(canonicalizeTxTypeOrBuy(null)).toBe('P');
    expect(canonicalizeTxTypeOrBuy('garbage')).toBe('P');
  });
});
