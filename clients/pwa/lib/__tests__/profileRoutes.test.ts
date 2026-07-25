import { describe, expect, it } from 'vitest';
import { normalizeProfileQueryValue, profileHref } from '../profileRoutes';

describe('profile routes', () => {
  it('uses static-export-compatible query routes and encodes identifiers', () => {
    expect(profileHref('asset', ' BRK/B ')).toBe('/asset?ticker=BRK%2FB');
    expect(profileHref('politician', 'Jane Doe')).toBe('/politician?slug=Jane%20Doe');
  });

  it('rejects absent or blank query values', () => {
    expect(normalizeProfileQueryValue(null)).toBeNull();
    expect(normalizeProfileQueryValue('   ')).toBeNull();
    expect(normalizeProfileQueryValue('  AAPL ')).toBe('AAPL');
  });
});
