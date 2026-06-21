import { describe, it, expect } from 'vitest';
import {
  arbitrationRowKey,
  fieldAgreement,
  mergeResults,
  type ExtractorResult,
} from '../types';
import type { ParsedTx } from '../../shared/types';

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-01-02',
    owner: 'self',
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: 'ST',
    txType: 'P',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: '',
    confidence: 0.6,
    ...over,
  };
}

function result(rows: ParsedTx[], over: Partial<ExtractorResult> = {}): ExtractorResult {
  return {
    transactions: rows,
    confidence: rows.length ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length : 0,
    raw: 'raw',
    extractor: 'primary',
    ...over,
  };
}

describe('arbitrationRowKey', () => {
  it('keys on ticker + date + type, uppercased', () => {
    expect(arbitrationRowKey(tx({ ticker: 'aapl' }))).toBe('AAPL|2026-01-02|P');
  });
  it('falls back to asset name when no ticker', () => {
    expect(arbitrationRowKey(tx({ ticker: null, assetName: 'US T-Bill' }))).toBe(
      'US T-BILL|2026-01-02|P',
    );
  });
});

describe('fieldAgreement', () => {
  it('counts matching comparable fields', () => {
    expect(fieldAgreement(tx(), tx())).toEqual({ agree: 5, total: 5 });
    expect(fieldAgreement(tx(), tx({ amountMin: 50000 }))).toEqual({ agree: 4, total: 5 });
    expect(fieldAgreement(tx(), tx({ owner: 'spouse', isOption: true }))).toEqual({
      agree: 3,
      total: 5,
    });
  });
});

describe('mergeResults', () => {
  it('boosts confidence when both extractors fully agree', () => {
    const merged = mergeResults(result([tx({ confidence: 0.6 })]), result([tx({ confidence: 0.6 })]));
    expect(merged.transactions).toHaveLength(1);
    // (0.6 + 0.6)/2 + 0.1 = 0.7
    expect(merged.transactions[0].confidence).toBeCloseTo(0.7, 5);
    expect(merged.extractor).toBe('arbitrating(primary,primary)');
  });

  it('scales row confidence down on partial field disagreement', () => {
    const primary = result([tx({ confidence: 1 })]);
    const secondary = result([tx({ confidence: 1, amountMin: 50000, amountMax: 100000 })]);
    const merged = mergeResults(primary, secondary);
    // 4/5 fields agree -> 1 * 0.8
    expect(merged.transactions[0].confidence).toBeCloseTo(0.8, 5);
  });

  it('halves confidence for primary-only rows (no corroboration)', () => {
    const primary = result([tx({ ticker: 'AAPL', confidence: 0.8 })]);
    const secondary = result([tx({ ticker: 'MSFT', confidence: 0.8 })]);
    const merged = mergeResults(primary, secondary);
    // primary row has no secondary match -> 0.8 * 0.5
    expect(merged.transactions[0].confidence).toBeCloseTo(0.4, 5);
  });

  it('keeps the primary row set authoritative and lowers doc confidence when contested', () => {
    const primary = result([tx({ ticker: 'AAPL' })]);
    const secondary = result([tx({ ticker: 'AAPL' }), tx({ ticker: 'TSLA' })]);
    const merged = mergeResults(primary, secondary);
    // Output is still just the one primary row...
    expect(merged.transactions).toHaveLength(1);
    // ...but the secondary-only row drags doc confidence below the row confidence.
    expect(merged.confidence).toBeLessThan(merged.transactions[0].confidence);
    expect(merged.raw).toContain('secondaryOnly=1');
  });
});
