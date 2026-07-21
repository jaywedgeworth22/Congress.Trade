import { describe, it, expect } from 'vitest';
import { assertFmpTierOk, hasFmpTierFailure, FMP_TIER_FAIL_STATUSES } from '../fmpStatus.ts';

describe('assertFmpTierOk', () => {
  it('throws a tagged error for key/plan statuses', () => {
    for (const s of FMP_TIER_FAIL_STATUSES) {
      expect(() => assertFmpTierOk(s)).toThrow('FMP_HTTP_' + s);
    }
  });

  it('is a no-op for "no data" / server statuses (404, 500, 200)', () => {
    expect(() => assertFmpTierOk(404)).not.toThrow();
    expect(() => assertFmpTierOk(500)).not.toThrow();
    expect(() => assertFmpTierOk(200)).not.toThrow();
  });
});

describe('hasFmpTierFailure', () => {
  it('detects a tagged tier error among a mix of benign errors', () => {
    expect(hasFmpTierFailure(['AAPL edgar: timeout', 'spx: FMP_HTTP_429'])).toBe(true);
    expect(hasFmpTierFailure(['MSFT fmp: FMP_HTTP_401'])).toBe(true);
  });

  it('returns false when there are no tier errors', () => {
    expect(hasFmpTierFailure([])).toBe(false);
    expect(hasFmpTierFailure(['AAPL edgar: 500', 'TSLA: no data'])).toBe(false);
    // A non-tier FMP status (e.g. 404) must NOT trip the alert.
    expect(hasFmpTierFailure(['X fmp: FMP_HTTP_404'])).toBe(false);
  });
});
