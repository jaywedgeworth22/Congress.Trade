import { describe, it, expect } from 'vitest';
import {
  TICKER_ALIASES,
  isPlaceholderTicker,
  isWellFormedTicker,
  punctuationVariants,
  resolveTickerDeterministic,
  stripPreferredSeries,
} from '../tickerNormalize';

// A tiny stand-in for the securities_master index used by the real resolver.
const MASTER = new Set(['T', 'RF', 'AVGO', 'META', 'XYZ', 'BRK-B', 'GEHC', 'AAPL']);
const isKnown = (sym: string): string | null => (MASTER.has(sym) ? sym : null);

describe('tickerNormalize pure helpers', () => {
  it('detects placeholder / no-ticker markers', () => {
    for (const p of ['', '-', '--', 'N/A', 'na', 'none', '  —  ']) {
      expect(isPlaceholderTicker(p)).toBe(true);
    }
    for (const real of ['AAPL', 'T', 'BRK.B']) expect(isPlaceholderTicker(real)).toBe(false);
  });

  it('strips a $-series preferred/depositary suffix to the issuer symbol', () => {
    expect(stripPreferredSeries('T$A')).toBe('T');
    expect(stripPreferredSeries('RF$E')).toBe('RF');
    expect(stripPreferredSeries('AAPL')).toBe('AAPL'); // no suffix → unchanged
  });

  it('enumerates punctuation variants for class shares', () => {
    expect(punctuationVariants('BRK.B')).toEqual(expect.arrayContaining(['BRK.B', 'BRKB', 'BRK-B']));
    expect(punctuationVariants('AAPL')).toEqual(['AAPL']);
  });

  it('recognizes well-formed symbols and rejects contamination', () => {
    for (const ok of ['AAPL', 'K', 'NSRGY', 'KRSOX', 'BRK.B', 'BRK-B']) {
      expect(isWellFormedTicker(ok)).toBe(true);
    }
    for (const bad of ['BANK OF AMERICA APPLE', 'COMMON STOCK', 'TOOLONGSYMBOL', '200?', 'A B']) {
      expect(isWellFormedTicker(bad)).toBe(false);
    }
  });
});

describe('resolveTickerDeterministic', () => {
  it('resolves $-series preferred shares to the master issuer (T$A → T)', () => {
    expect(resolveTickerDeterministic('T$A', isKnown)).toBe('T');
    expect(resolveTickerDeterministic('RF$E', isKnown)).toBe('RF');
  });

  it('resolves a dotted/dashed class share to the master punctuation form (BRK.B → BRK-B)', () => {
    expect(resolveTickerDeterministic('BRK.B', isKnown)).toBe('BRK-B');
    expect(resolveTickerDeterministic('BRK-B', isKnown)).toBe('BRK-B');
    // A dotless "BRKB" can't deterministically recover the class separator, so
    // it's accepted as-is (tier 4) rather than guessed into "BRK-B".
    expect(resolveTickerDeterministic('BRKB', isKnown)).toBe('BRKB');
  });

  it('maps curated stale/renamed tickers to the current symbol', () => {
    expect(resolveTickerDeterministic('BRCM', isKnown)).toBe('AVGO');
    expect(resolveTickerDeterministic('FB', isKnown)).toBe('META');
    expect(resolveTickerDeterministic('SQ', isKnown)).toBe('XYZ');
    expect(resolveTickerDeterministic('GEHCV', isKnown)).toBe('GEHC');
  });

  it('accepts a well-formed symbol the master does not list (CTRA, NSRGY)', () => {
    expect(resolveTickerDeterministic('CTRA', isKnown)).toBe('CTRA');
    expect(resolveTickerDeterministic('NSRGY', isKnown)).toBe('NSRGY');
    expect(resolveTickerDeterministic('K', isKnown)).toBe('K');
  });

  it('rejects placeholders and header-contaminated strings', () => {
    expect(resolveTickerDeterministic('--', isKnown)).toBeNull();
    expect(resolveTickerDeterministic('N/A', isKnown)).toBeNull();
    expect(resolveTickerDeterministic('Bank of America Apple', isKnown)).toBeNull();
    expect(resolveTickerDeterministic('COMMON STOCK', isKnown)).toBeNull();
  });

  it('cleans surrounding quotes/brackets before resolving', () => {
    expect(resolveTickerDeterministic('"AAPL"', isKnown)).toBe('AAPL');
    expect(resolveTickerDeterministic('[CTRA]', isKnown)).toBe('CTRA');
  });

  it('every curated alias target is a plausible symbol', () => {
    for (const target of Object.values(TICKER_ALIASES)) {
      expect(isWellFormedTicker(target)).toBe(true);
    }
  });
});
