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
import type { Env } from '../shared/types';
import { DASHBOARD_HTML } from './dashboardHtml';
import { TOS_HTML, PRIVACY_HTML } from './legalHtml';
import { getLogoDisplay } from '../shared/settings';

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

  return r;
}
