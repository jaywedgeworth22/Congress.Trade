/**
 * src/ui/__tests__/legalHtml.test.ts
 *
 * Guards the Terms of Service pricing copy against drifting from the owner-
 * decided canonical Premium price ($5/mo · $50/yr, 1-month trial).
 */

import { describe, it, expect } from 'vitest';
import { TOS_HTML, PRIVACY_HTML } from '../legalHtml.ts';

describe('legalHtml pricing copy', () => {
  it('states the canonical $5/mo · $50/yr Premium price in the Terms of Service', () => {
    expect(TOS_HTML).toContain('$5.00 / month');
    expect(TOS_HTML).toContain('$50.00 / year');
    // 14 days, matching STRIPE_TRIAL_DAYS' default (billing/routes.ts) and the
    // "2-week free trial" the dashboard and the iOS Premium sheet both quote.
    // The Terms said "30 days / 1 month" long after the trial became 2 weeks.
    expect(TOS_HTML).toContain('14 days');
    expect(TOS_HTML).not.toContain('30 days');
  });

  it('never mentions stale price points', () => {
    expect(TOS_HTML).not.toContain('$15.00');
    expect(TOS_HTML).not.toContain('$140.00');
    expect(TOS_HTML).not.toContain('$9.00');
    expect(TOS_HTML).not.toContain('$90.00');
    expect(PRIVACY_HTML).not.toContain('$15.00');
    expect(PRIVACY_HTML).not.toContain('$140.00');
  });
});

describe('short legal and pricing routes', () => {
  it('redirects /privacy, /terms, and /pricing to canonical destinations', async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const app = buildUiRouter();
    const privacy = await app.request('http://localhost/privacy', {}, {} as never);
    expect(privacy.status).toBe(301);
    expect(privacy.headers.get('location')).toBe('/privacy-policy');

    const terms = await app.request('http://localhost/terms', {}, {} as never);
    expect(terms.status).toBe(301);
    expect(terms.headers.get('location')).toBe('/terms-of-service');

    const pricing = await app.request('http://localhost/pricing', {}, {} as never);
    expect(pricing.status).toBe(302);
    expect(pricing.headers.get('location')).toContain('pricing=1');
  });
});
