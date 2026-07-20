/**
 * src/ui/__tests__/legalHtml.test.ts
 *
 * Guards the Terms of Service pricing copy against drifting from the owner-
 * decided canonical Premium price ($9/mo · $90/yr). This page previously said
 * $15.00/month and $140.00/year, out of sync with the dashboard's pricing
 * modal and alert gate-note (both already $9/$90) — see dashboardHtml.test.ts
 * for the matching assertions on those surfaces.
 */

import { describe, it, expect } from 'vitest';
import { TOS_HTML, PRIVACY_HTML } from '../legalHtml';

describe('legalHtml pricing copy', () => {
  it('states the canonical $9/mo · $90/yr Premium price in the Terms of Service', () => {
    expect(TOS_HTML).toContain('$9.00 / month');
    expect(TOS_HTML).toContain('$90.00 / year');
  });

  it('never mentions the stale $15/$140 price point', () => {
    expect(TOS_HTML).not.toContain('$15.00');
    expect(TOS_HTML).not.toContain('$140.00');
    expect(PRIVACY_HTML).not.toContain('$15.00');
    expect(PRIVACY_HTML).not.toContain('$140.00');
  });
});
