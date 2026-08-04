import { describe, expect, it } from 'vitest';
import {
  applyMemberNameAlias,
  memberMergeForFilerId,
  resolveCanonicalFilerId,
} from '../memberIdentity.ts';
import { cleanFilerName } from '../../extraction/nameNormalizer.ts';
import { houseFilerId, senateFilerId } from '../../ingestion/watcher.ts';

describe('memberIdentity aliases', () => {
  it('maps Rohit Khanna → Ro Khanna', () => {
    expect(applyMemberNameAlias('Rohit Khanna')).toBe('Ro Khanna');
    expect(applyMemberNameAlias('rohit khanna')).toBe('Ro Khanna');
    expect(applyMemberNameAlias('KHANNA, ROHIT')).toBe('Ro Khanna');
  });

  it('leaves unrelated names alone', () => {
    expect(applyMemberNameAlias('Nancy Pelosi')).toBe('Nancy Pelosi');
    expect(applyMemberNameAlias('Ro Khanna')).toBe('Ro Khanna');
  });

  it('cleanFilerName applies the alias after Last, First flip', () => {
    expect(cleanFilerName('Khanna, Rohit')).toBe('Ro Khanna');
    expect(cleanFilerName('Rohit Khanna')).toBe('Ro Khanna');
    expect(cleanFilerName('ROHIT KHANNA')).toBe('Ro Khanna');
  });

  it('houseFilerId mints the preferred-name slug', () => {
    expect(houseFilerId('Rohit', 'Khanna', 'CA17')).toBe('house-ca17-ro-khanna');
    expect(houseFilerId('Ro', 'Khanna', 'CA17')).toBe('house-ca17-ro-khanna');
  });

  it('senateFilerId also collapses aliases', () => {
    // Senate path is unused for Khanna today but must honor the same rename.
    expect(senateFilerId('Rohit Khanna')).toBe('senate-ro-khanna');
  });

  it('resolves known filer id aliases onto the durable canonical id', () => {
    expect(resolveCanonicalFilerId('house-ca17-rohit-khanna')).toBe('house-ca17-ro-khanna');
    expect(resolveCanonicalFilerId('MANUAL-KHANNA')).toBe('house-ca17-ro-khanna');
    expect(resolveCanonicalFilerId('house-ca17-ro-khanna')).toBe('house-ca17-ro-khanna');
    expect(resolveCanonicalFilerId('house-ca11-nancy-pelosi')).toBe('house-ca11-nancy-pelosi');
  });

  it('memberMergeForFilerId returns the Ro Khanna group for either fork', () => {
    const g = memberMergeForFilerId('house-ca17-rohit-khanna');
    expect(g?.canonicalId).toBe('house-ca17-ro-khanna');
    expect(g?.canonicalName).toBe('Ro Khanna');
    expect(g?.resolvedBioguideId).toBe('K000389');
  });
});
