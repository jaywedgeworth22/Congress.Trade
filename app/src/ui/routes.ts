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

/**
 * Render the dashboard, injecting the admin-controlled site-wide settings the
 * client needs at boot (currently the global logo style) so every visitor gets
 * the admin's choice with no extra request / no flash.
 */
async function renderDashboard(env: Env): Promise<string> {
  const logoDisplay = await getLogoDisplay(env);
  return DASHBOARD_HTML.split('%LOGO_DISPLAY%').join(logoDisplay);
}

export function buildUiRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // Dashboard SPA. Hono's c.html() sets `content-type: text/html; charset=UTF-8`.
  r.get('/', async (c) => c.html(await renderDashboard(c.env)));
  r.get('/admin', async (c) => c.html(await renderDashboard(c.env)));

  // Static legal pages (required for Stripe Checkout: ToS + Privacy URLs).
  r.get('/terms-of-service', (c) => c.html(TOS_HTML));
  r.get('/privacy-policy', (c) => c.html(PRIVACY_HTML));

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
