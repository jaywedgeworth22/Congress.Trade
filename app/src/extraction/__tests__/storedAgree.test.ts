import { describe, it, expect } from 'vitest';
import { pickAgreeingStoredReads } from '../agreement.ts';
import type { ParsedTx } from '../../shared/types.ts';

function row(overrides: Partial<ParsedTx> = {}): ParsedTx {
  return {
    ticker: 'AAPL',
    assetName: 'Apple Inc.',
    txDate: '2026-06-19',
    txType: 'P',
    amountRange: '$1,001 - $15,000',
    isOption: false,
    capGainsOver200: false,
    confidence: 0.9,
    ...overrides,
  };
}

describe('pickAgreeingStoredReads', () => {
  it('returns two cross-vendor agreeing non-empty reads', () => {
    const agreed = pickAgreeingStoredReads([
      { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', rows: [row()] },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', rows: [row({ assetName: 'APPLE INC.' })] },
    ], true);
    expect(agreed).toHaveLength(2);
  });

  it('ignores empty×empty (not soft agreement)', () => {
    expect(pickAgreeingStoredReads([
      { provider: 'openai', model: 'gpt-4o', rows: [] },
      { provider: 'anthropic', model: 'claude-sonnet-5', rows: [] },
    ])).toBeNull();
  });

  it('rejects same underlying provider corroborating itself', () => {
    expect(pickAgreeingStoredReads([
      { provider: 'openrouter', model: 'openai/gpt-4o', rows: [row()] },
      { provider: 'openai', model: 'gpt-4o', rows: [row()] },
    ])).toBeNull();
  });

  it('returns null when material fields disagree', () => {
    expect(pickAgreeingStoredReads([
      { provider: 'openai', model: 'gpt-4o', rows: [row({ ticker: 'AAPL' })] },
      { provider: 'anthropic', model: 'claude-sonnet-5', rows: [row({ ticker: 'MSFT' })] },
    ])).toBeNull();
  });
});
