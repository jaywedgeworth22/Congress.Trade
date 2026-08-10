import { describe, expect, it } from 'vitest';
import { EXECUTIVE_TITLES, DEFAULT_EXECUTIVE_TITLE, executiveTitleFor } from '../executiveTitles.ts';

describe('executiveTitleFor', () => {
  it('returns the curated title for a known executive filer', () => {
    expect(executiveTitleFor('EXEC-DJT')).toBe('President');
    expect(executiveTitleFor('EXEC-BESSENT')).toBe('Treasury Secretary');
    expect(executiveTitleFor('EXEC-CWRIGHT')).toBe('Energy Secretary');
    expect(executiveTitleFor('EXEC-MCMAHON')).toBe('Education Secretary');
  });

  it('maps every -ERM/dated duplicate variant of a curated person to the same title', () => {
    // The identity-dedupe merge may pick either variant id as canonical, so
    // both must resolve to the same display title.
    expect(executiveTitleFor('EXEC-ANTHONY-J-BLINKEN')).toBe('Secretary of State');
    expect(executiveTitleFor('EXEC-ANTHONY-J-BLINKEN-2025-ERM')).toBe('Secretary of State');
    expect(executiveTitleFor('EXEC-BARBARA-M-BARRETT')).toBe('Secretary of the Air Force');
    expect(executiveTitleFor('EXEC-BARBARA-M-BARRETT-2021-ERM')).toBe('Secretary of the Air Force');
    expect(executiveTitleFor('EXEC-BABARA-M-BARRETT')).toBe('Secretary of the Air Force');
  });

  it('falls back to the default label for an EXEC-* id with no curated entry', () => {
    expect(executiveTitleFor('EXEC-SOME-UNCURATED-NOMINEE')).toBe(DEFAULT_EXECUTIVE_TITLE);
  });

  it('returns null for a non-executive (House/Senate) filer id', () => {
    expect(executiveTitleFor('house-tx10-jane-smith')).toBeNull();
    expect(executiveTitleFor('senate-ted-cruz')).toBeNull();
    expect(executiveTitleFor('MANUAL-KHANNA')).toBeNull();
  });

  it('returns null for missing/empty input', () => {
    expect(executiveTitleFor(null)).toBeNull();
    expect(executiveTitleFor(undefined)).toBeNull();
    expect(executiveTitleFor('')).toBeNull();
  });

  it('every curated key starts with EXEC- (guards against a typoed map key silently never matching)', () => {
    for (const key of Object.keys(EXECUTIVE_TITLES)) {
      expect(key.startsWith('EXEC-')).toBe(true);
    }
  });
});
