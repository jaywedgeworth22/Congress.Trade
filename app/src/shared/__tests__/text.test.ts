import { describe, it, expect } from 'vitest';
import { sanitizeAssetName } from '../text.ts';

describe('sanitizeAssetName', () => {
  it('strips HTML tags and collapses whitespace', () => {
    expect(
      sanitizeAssetName('OWENS &amp; MINOR <div class="text-muted"><em>Rate/Coupon:</em> 3.875%<br> <em>Matures:</em> 09/15/2021</div>'),
    ).toBe('OWENS & MINOR Rate/Coupon: 3.875% Matures: 09/15/2021');
  });
  it('handles the exchanged/received <br> case', () => {
    expect(sanitizeAssetName('Fortive Corporation (Exchanged) <br> Vontier Corporation (Received)'))
      .toBe('Fortive Corporation (Exchanged) Vontier Corporation (Received)');
  });
  it('decodes &nbsp; and keeps plain text intact', () => {
    expect(sanitizeAssetName('EMSG LLC&nbsp;(Rockville, MD)')).toBe('EMSG LLC (Rockville, MD)');
    expect(sanitizeAssetName('Apple Inc.')).toBe('Apple Inc.');
  });
  it('returns empty string for null/undefined', () => {
    expect(sanitizeAssetName(null)).toBe('');
    expect(sanitizeAssetName(undefined)).toBe('');
  });
});
