import { describe, expect, it } from 'vitest';
import { cleanAssetString, cleanFilerName, isJunkAssetString } from '../nameNormalizer.ts';

describe('cleanFilerName', () => {
  it('removes embedded honorifics without joining adjacent words', () => {
    expect(cleanFilerName('Richard Dean Dr McCormick')).toBe('Richard Dean McCormick');
  });

  it('removes academic and medical titles with source punctuation', () => {
    expect(cleanFilerName('Neal Patrick MD, Facs Dunn')).toBe('Neal Patrick Dunn');
  });

  it('does not remove title-like substrings from ordinary names', () => {
    expect(cleanFilerName('Drake')).toBe('Drake');
    expect(cleanFilerName('Senatorial')).toBe('Senatorial');
  });

  it('maps curated legal names onto preferred public names', () => {
    expect(cleanFilerName('Rohit Khanna')).toBe('Ro Khanna');
    expect(cleanFilerName('Khanna, Rohit')).toBe('Ro Khanna');
  });
});

describe('isJunkAssetString & cleanAssetString', () => {
  it('identifies dot leaders and OCR junk strings as junk asset strings', () => {
    expect(isJunkAssetString('........................................')).toBe(true);
    expect(isJunkAssetString('......s')).toBe(true);
    expect(isJunkAssetString('..........A')).toBe(true);
    expect(isJunkAssetString('........')).toBe(true);
    expect(isJunkAssetString('..o')).toBe(true);
    expect(isJunkAssetString('...................0')).toBe(true);
    expect(isJunkAssetString('Unparsed Historical Filing')).toBe(true);
  });

  it('preserves valid asset names and tickers', () => {
    expect(isJunkAssetString('Apple Inc.')).toBe(false);
    expect(isJunkAssetString('AT&T')).toBe(false);
    expect(isJunkAssetString('3M')).toBe(false);
    expect(cleanAssetString('Apple Inc.')).toBe('Apple Inc.');
    expect(cleanAssetString('........................................')).toBe('');
    expect(cleanAssetString('......s')).toBe('');
    expect(cleanAssetString('ARCC ..', 'ARCC')).toBe('ARCC');
    expect(cleanAssetString('ARCC ................................', 'ARCC')).toBe('ARCC');
    expect(cleanAssetString('.....]')).toBe('');
    expect(cleanAssetString('XOM ....k', 'XOM')).toBe('XOM');
    expect(cleanAssetString('...................e')).toBe('');
  });
});
