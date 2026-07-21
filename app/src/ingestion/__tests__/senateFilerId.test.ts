import { describe, it, expect } from 'vitest';
import { senateFilerId } from '../watcher.ts';

describe('senateFilerId', () => {
  it('mints a stable, slugged, non-null id from a disclosed name', () => {
    expect(senateFilerId('Jane Q. Smith')).toBe('senate-jane-q-smith');
    // Stable across whitespace/case variations of the same name.
    expect(senateFilerId('  JANE   Q.  SMITH ')).toBe('senate-jane-q-smith');
  });

  it('returns null (not a meaningless id) when no name is available', () => {
    expect(senateFilerId(null)).toBeNull();
    expect(senateFilerId('')).toBeNull();
    expect(senateFilerId('   ')).toBeNull();
  });

  it('does not collide with the house- id namespace', () => {
    expect(senateFilerId('John Doe')!.startsWith('senate-')).toBe(true);
  });
});
