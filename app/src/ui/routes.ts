/**
 * src/ui/routes.ts
 * OWNER: dashboard agent
 *
 * Hono router that serves the static dashboard document at `/` and `/admin`.
 * Both routes render the same single-page app (DASHBOARD_HTML); the admin
 * panels are reachable via the in-page tabs, so `/admin` is simply a convenient
 * deep-link entry point. The page talks to the JSON API mounted under /api and
 * /api/admin by the delivery + admin agents.
 *
 * Mounted by index.ts at the root, e.g. `root.route('/', buildUiRouter())`.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types.ts';
import { DASHBOARD_HTML } from './dashboardHtml.ts';
import { TOS_HTML, PRIVACY_HTML } from './legalHtml.ts';
import { getLogoDisplay } from '../shared/settings.ts';
import {
  APPLE_TOUCH_ICON_PNG,
  BRAND_LOGO_DARK_PNG,
  BRAND_LOGO_LIGHT_PNG,
  BRAND_LOGO_PNG,
  EAGLE_SPLASH_PNG,
  FAVICON_PNG,
  ICON_192_PNG,
  ICON_512_PNG,
  OG_IMAGE_COMPANY_PNG,
  OG_IMAGE_PNG,
  OG_IMAGE_POLITICIAN_PNG,
  OG_IMAGE_TRENDS_PNG,
  SITE_WEBMANIFEST,
  ZILLA_SLAB_WOFF2,
  type StaticAsset,
} from './assets.ts';
import { applyOgMeta, resolveOgMeta } from './ogMeta.ts';

/**
 * Analytics injection was removed (CT-AUD-P1-15).
 *
 * Every page shipped `<script src="https://www.googletagmanager.com/gtag/js?id=…">`
 * with a HARDCODED default measurement id, while the CSP has long been
 * `script-src 'self' 'unsafe-inline'` with `connect-src 'self'`. The browser
 * blocked both the tag and its collection calls, so it never produced a single
 * data point — it only cost a request attempt and a CSP violation on every page
 * load, for every visitor, including anyone self-hosting this code.
 *
 * Re-enabling it is a deliberate PRIVACY decision, not a config change: it needs
 * an owner-chosen measurement id (never a hardcoded default), explicit CSP
 * entries for googletagmanager.com and google-analytics.com, a consent surface,
 * and a privacy-policy update. Until those exist, shipping nothing is the
 * honest behaviour.
 */
/** What a politician share card needs about a filer: who they are and their seat. */
type MemberShareIdentity = {
  displayName: string | null;
  /** Pre-formatted seat descriptor for `resolveOgMeta`'s `memberDistrict`. */
  district: string | null;
};

/**
 * Format a filer's seat as the compact descriptor politician share cards render
 * in parentheses after the name — `D-CA-17`, `R-AL-Sen`, `D-DE-AL`.
 *
 * Shape notes, all confirmed against live `filers` rows:
 *   - `party` is a full word ('Democrat' / 'Republican' / 'Independent') or NULL
 *     for ~14% of filers, so the initial is optional rather than assumed.
 *   - `district` is NULL for senators and executive-branch filers, and the
 *     STRING '0' for at-large House seats (AK, DE, VT, WY, …) — '0' must render
 *     'AL', never a literal district zero.
 *   - Executive-branch filers hold no seat at all and carry no state, so they
 *     get no parenthetical rather than a lone party letter.
 *
 * Exported for unit tests; there is no D1 dependency in here on purpose.
 */
export function formatMemberSeat(
  chamber: string | null | undefined,
  party: string | null | undefined,
  state: string | null | undefined,
  district: string | null | undefined,
): string | null {
  const ch = (chamber || '').trim().toLowerCase();
  const st = (state || '').trim().toUpperCase();
  // No seat to describe: executive filers, or any row missing a state.
  if (!st || ch === 'executive') return null;

  const partyInitial = (party || '').trim().charAt(0).toUpperCase();
  const dist = (district || '').trim();

  let seat = '';
  if (ch === 'senate') {
    seat = 'Sen';
  } else if (dist) {
    // '0' (and '00') are the at-large encodings, not a district numbered zero.
    seat = /^0+$/.test(dist) ? 'AL' : dist.replace(/^0+(?=\d)/, '');
  }

  return [partyInitial, st, seat].filter(Boolean).join('-');
}

/** Best-effort filer identity for politician share cards (never throws). */
async function lookupMemberShareIdentity(env: Env, memberId: string): Promise<MemberShareIdentity> {
  const empty: MemberShareIdentity = { displayName: null, district: null };
  const id = memberId.trim();
  if (!id || !env.DB) return empty;
  try {
    const row = await env.DB
      .prepare(
        'SELECT full_name, chamber, party, state, district FROM filers ' +
          'WHERE LOWER(bioguide_id) = LOWER(?) LIMIT 1',
      )
      .bind(id)
      .first<{
        full_name: string | null;
        chamber: string | null;
        party: string | null;
        state: string | null;
        district: string | null;
      }>();
    if (!row) return empty;
    return {
      displayName: row.full_name?.trim() || null,
      district: formatMemberSeat(row.chamber, row.party, row.state, row.district),
    };
  } catch {
    return empty;
  }
}

async function renderDashboard(env: Env, requestUrl: string): Promise<string> {
  const logoDisplay = await getLogoDisplay(env);
  let memberDisplayName: string | null = null;
  let memberDistrict: string | null = null;
  try {
    const u = new URL(requestUrl);
    const member = (u.searchParams.get('member') || '').trim();
    if (member) {
      const identity = await lookupMemberShareIdentity(env, member);
      memberDisplayName = identity.displayName;
      memberDistrict = identity.district;
    }
  } catch {
    /* ignore bad URL */
  }
  const og = resolveOgMeta(requestUrl, 'https://congress.trade', { memberDisplayName, memberDistrict });
  let html = DASHBOARD_HTML
    .split('%LOGO_DISPLAY%').join(logoDisplay)
    .split('%GA_SCRIPT%').join('');
  html = applyOgMeta(html, og);
  return html;
}

function renderLegalHtml(html: string, _env: Env): string {
  return html.split('%GA_SCRIPT%').join('');
}

export function buildUiRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // Dashboard SPA. Hono's c.html() sets `content-type: text/html; charset=UTF-8`.
  // OG/Twitter meta is filled from the request URL so crawlers unfurl the
  // correct card for ?view=trends / ?ticker= / ?member= deep links.
  r.get('/', async (c) => c.html(await renderDashboard(c.env, c.req.url)));
  r.get('/admin', async (c) => c.html(await renderDashboard(c.env, c.req.url)));

  // Binary assets live under app/public/ (loaded by assets.ts) and are served
  // here with long cache headers. HTML references these URL paths — never
  // inline base64 — so documents stay small and assets are CSP-safe (`'self'`).
  const serveAsset = (a: StaticAsset, cacheControl: string) => (c: any) =>
    c.body(a.bytes, 200, {
      'content-type': a.contentType,
      'cache-control': cacheControl,
    });
  const IMMUTABLE = 'public, max-age=31536000, immutable';
  const LONG = 'public, max-age=86400';
  r.get('/assets/zilla-slab-700.woff2', serveAsset(ZILLA_SLAB_WOFF2, IMMUTABLE));
  r.get('/assets/eagle-splash.png', serveAsset(EAGLE_SPLASH_PNG, IMMUTABLE));
  r.get('/assets/brand-logo.png', serveAsset(BRAND_LOGO_PNG, IMMUTABLE));
  r.get('/assets/brand-logo-dark.png', serveAsset(BRAND_LOGO_DARK_PNG, IMMUTABLE));
  r.get('/assets/brand-logo-light.png', serveAsset(BRAND_LOGO_LIGHT_PNG, IMMUTABLE));
  r.get('/og-image.png', serveAsset(OG_IMAGE_PNG, LONG));
  r.get('/og-image-trends.png', serveAsset(OG_IMAGE_TRENDS_PNG, LONG));
  r.get('/og-image-company.png', serveAsset(OG_IMAGE_COMPANY_PNG, LONG));
  r.get('/og-image-politician.png', serveAsset(OG_IMAGE_POLITICIAN_PNG, LONG));
  r.get('/favicon.ico', serveAsset(FAVICON_PNG, LONG));
  r.get('/icon-192.png', serveAsset(ICON_192_PNG, LONG));
  r.get('/icon-512.png', serveAsset(ICON_512_PNG, LONG));
  r.get('/apple-touch-icon.png', serveAsset(APPLE_TOUCH_ICON_PNG, LONG));
  r.get('/site.webmanifest', (c) =>
    c.body(SITE_WEBMANIFEST, 200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': LONG,
    }));

  // Static legal pages (required for Stripe Checkout: ToS + Privacy URLs).
  r.get('/terms-of-service', (c) => c.html(renderLegalHtml(TOS_HTML, c.env)));
  r.get('/privacy-policy', (c) => c.html(renderLegalHtml(PRIVACY_HTML, c.env)));
  // Short aliases users and external listings commonly try first.
  r.get('/privacy', (c) => c.redirect('/privacy-policy', 301));
  r.get('/terms', (c) => c.redirect('/terms-of-service', 301));
  // Shareable pricing entry — dashboard opens the Premium modal via ?pricing=1.
  r.get('/pricing', (c) => c.redirect('/?pricing=1&view=subs', 302));

  // robots.txt — allow search engines, block AI/LLM crawlers and scrapers.
  // Follows the same policy as capitoltrades.com/robots.txt.
  r.get('/robots.txt', (c) => c.text(`User-Agent: *
Allow: /
Disallow: /api/

User-Agent: GPTBot
User-Agent: ChatGPT-User
User-Agent: OAI-SearchBot
User-Agent: ClaudeBot
User-Agent: anthropic-ai
User-Agent: Claude-Web
User-Agent: CCBot
User-Agent: Google-Extended
User-Agent: Applebot-Extended
User-Agent: PerplexityBot
User-Agent: Perplexity-User
User-Agent: Bytespider
User-Agent: Amazonbot
User-Agent: meta-externalagent
User-Agent: Meta-ExternalAgent
User-Agent: FacebookBot
User-Agent: Diffbot
User-Agent: ImagesiftBot
User-Agent: Omgilibot
User-Agent: Omgili
User-Agent: YouBot
User-Agent: cohere-ai
User-Agent: cohere-training-data-crawler
User-Agent: Timpibot
User-Agent: VelenPublicWebCrawler
User-Agent: Scrapy
Disallow: /
`, 200, { 'content-type': 'text/plain; charset=utf-8' }));

  return r;
}
