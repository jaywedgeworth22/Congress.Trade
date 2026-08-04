import { describe, expect, it } from 'vitest';
import {
  assetNameFromCompetitorPayload,
  resolveExecutiveFilerIdFromName,
} from '../executiveIdentity.ts';

describe('resolveExecutiveFilerIdFromName', () => {
  it('maps full executive names to stable EXEC ids', () => {
    expect(resolveExecutiveFilerIdFromName('Donald J. Trump')).toBe('EXEC-DJT');
    expect(resolveExecutiveFilerIdFromName('Scott Bessent')).toBe('EXEC-BESSENT');
    expect(resolveExecutiveFilerIdFromName('Linda E. McMahon')).toBe('EXEC-MCMAHON');
    expect(resolveExecutiveFilerIdFromName('Dave McCormick')).toBe('EXEC-MCCORMICK');
    expect(resolveExecutiveFilerIdFromName('Chris Wright')).toBe('EXEC-CWRIGHT');
  });

  it('does NOT map bare last names or unrelated same-last-name people', () => {
    expect(resolveExecutiveFilerIdFromName('Trump')).toBeNull();
    expect(resolveExecutiveFilerIdFromName('McCormick')).toBeNull();
    expect(resolveExecutiveFilerIdFromName('Rich McCormick')).toBeNull();
    expect(resolveExecutiveFilerIdFromName('Wright')).toBeNull();
    expect(resolveExecutiveFilerIdFromName('')).toBeNull();
  });
});

describe('assetNameFromCompetitorPayload', () => {
  it('promotes notes over Unknown', () => {
    expect(
      assetNameFromCompetitorPayload({
        ticker: null,
        notes: 'Vanguard Mega Cap Growth ETF\nRate/Coupon: n/a',
        issuer: 'undisclosed',
      }),
    ).toBe('Vanguard Mega Cap Growth ETF');
  });

  it('falls back to ticker then Unknown', () => {
    expect(assetNameFromCompetitorPayload({ notes: '' }, 'AAPL')).toBe('AAPL');
    expect(assetNameFromCompetitorPayload({})).toBe('Unknown');
  });
});
