/**
 * src/ui/__tests__/legalHtml.test.ts
 *
 * Guards the Terms of Service pricing copy against drifting from the owner-
 * decided canonical Premium price ($5/mo · $50/yr, 2-week trial).
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

  it('mails support@congress.trade, not the old jays.services inbox', () => {
    expect(TOS_HTML).toContain('mailto:support@congress.trade');
    expect(PRIVACY_HTML).toContain('mailto:support@congress.trade');
    expect(TOS_HTML).not.toContain('congress.trade@jays.services');
    expect(PRIVACY_HTML).not.toContain('congress.trade@jays.services');
  });
});

describe('shared legal chrome and theme path', () => {
  function styleBlock(html: string): string {
    const match = html.match(/<style>[\s\S]*?<\/style>/);
    if (!match) throw new Error('missing <style> block');
    return match[0];
  }

  function themeBoot(html: string): string {
    const match = html.match(/localStorage\.getItem\('ui-theme'\)[\s\S]*?data-theme-pref/);
    if (!match) throw new Error('missing ui-theme boot');
    return match[0];
  }

  it('gives ToS and Privacy Policy the same heading, font, and list chrome', () => {
    expect(styleBlock(TOS_HTML)).toBe(styleBlock(PRIVACY_HTML));
    for (const html of [TOS_HTML, PRIVACY_HTML]) {
      expect(html).toContain('h1{font-size:26px;font-weight:700');
      expect(html).toContain('.eff{color:var(--dim);font-size:13px');
      expect(html).toContain('h2{font-size:17px;font-weight:700');
      expect(html).toContain('--sans:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif');
      expect(html).toContain('ul{padding-left:20px;list-style:disc}');
      expect(html).toContain('Congress<span class="dot">.</span>Trade');
    }
    expect(TOS_HTML).toContain('<h1>Terms of Service</h1>');
    expect(TOS_HTML).toContain('<p class="eff">Effective June 22, 2026</p>');
    expect(PRIVACY_HTML).toContain('<h1>Privacy Policy</h1>');
    expect(PRIVACY_HTML).toContain('<p class="eff">Effective June 22, 2026</p>');
  });

  it('honors the site Light / Dark / System switch on both pages', () => {
    expect(themeBoot(TOS_HTML)).toBe(themeBoot(PRIVACY_HTML));
    for (const html of [TOS_HTML, PRIVACY_HTML]) {
      expect(html).toContain('localStorage.getItem(\'ui-theme\')');
      expect(html).toContain('html[data-theme="light"]');
      expect(html).toContain('html[data-theme="dark"]');
      expect(html).toContain('--bg:#0b1120');
      expect(html).toContain('--bg:#eff3f8');
      expect(html).toContain('data-theme-opt="light"');
      expect(html).toContain('data-theme-opt="dark"');
      expect(html).toContain('data-theme-opt="system"');
      expect(html).toContain('aria-label="Theme"');
    }
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

  it('serves ToS and Privacy Policy from the same themed shell', async () => {
    const { buildUiRouter } = await import('../routes.ts');
    const app = buildUiRouter();
    const tos = await app.request('http://localhost/terms-of-service', {}, {} as never);
    const privacy = await app.request('http://localhost/privacy-policy', {}, {} as never);
    expect(tos.status).toBe(200);
    expect(privacy.status).toBe(200);
    const tosHtml = await tos.text();
    const privacyHtml = await privacy.text();
    expect(tosHtml).toContain('data-theme-opt="system"');
    expect(privacyHtml).toContain('data-theme-opt="system"');
    expect(tosHtml).toContain('<h1>Terms of Service</h1>');
    expect(privacyHtml).toContain('<h1>Privacy Policy</h1>');
    const tosStyle = tosHtml.match(/<style>[\s\S]*?<\/style>/)?.[0];
    const privacyStyle = privacyHtml.match(/<style>[\s\S]*?<\/style>/)?.[0];
    expect(tosStyle).toBe(privacyStyle);
  });
});
