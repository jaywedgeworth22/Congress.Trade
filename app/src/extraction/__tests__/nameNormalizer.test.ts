import { describe, expect, it } from 'vitest';
import { cleanFilerName } from '../nameNormalizer.ts';

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
});
