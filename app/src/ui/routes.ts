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
  OG_IMAGE_PNG,
  SITE_WEBMANIFEST,
  ZILLA_SLAB_WOFF2,
  type StaticAsset,
} from './assets.ts';

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
async function renderDashboard(env: Env): Promise<string> {
  const logoDisplay = await getLogoDisplay(env);
  return DASHBOARD_HTML
    .split('%LOGO_DISPLAY%').join(logoDisplay)
    .split('%GA_SCRIPT%').join('');
}

function renderLegalHtml(html: string, _env: Env): string {
  return html.split('%GA_SCRIPT%').join('');
}

export function buildUiRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // Dashboard SPA. Hono's c.html() sets `content-type: text/html; charset=UTF-8`.
  r.get('/', async (c) => c.html(await renderDashboard(c.env)));
  r.get('/admin', async (c) => c.html(await renderDashboard(c.env)));

  // Binary assets extracted from the HTML document (fonts, brand images,
  // icons, social card). Content is version-pinned to the deploy, so cache
  // aggressively; the HTML revalidates and picks up new bytes on each deploy.
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
