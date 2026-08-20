/**
 * src/ui/appLinks.ts
 * OWNER: dashboard agent
 *
 * WEB half of iOS Universal Links.  This file serves the Apple App Site
 * Association (AASA) manifest that lets iOS associate `congress.trade` with
 * the native app (`CC8UTF7ATG.trade.congress.ios`), and — once the app has a
 * public App Store id — injects the Smart App Banner meta tag on the
 * dashboard page.  Neither piece opens the app by itself.  Universal links
 * stay DARK (a congress.trade link keeps opening Safari, not the app) until
 * the iOS half also ships: the `com.apple.developer.associated-domains`
 * entitlement plus an `NSUserActivity` / `onContinueUserActivity` handler in
 * `clients/ios/CongressTrade/App.swift`.  That is a different seat's work —
 * see the handoff note in the PR that introduced this file.
 */

import type { Hono, MiddlewareHandler } from 'hono';
import type { Env } from '../shared/types.ts';

/**
 * `<Team ID>.<Bundle ID>` from the Apple Developer Portal — fixed by
 * `clients/ios/CLAUDE.md` ("Team: CC8UTF7ATG", "Bundle ID: trade.congress.ios"),
 * not a value this file can derive or should ever guess.
 */
const IOS_APP_ID = 'CC8UTF7ATG.trade.congress.ios';

/**
 * Modern `components` format, not the legacy `paths` array: every entity URL
 * on this site is a QUERY STRING on `/` (`?member=`, `?ticker=`, `?trade=`,
 * `?view=`) and `paths` can only match a pathname pattern — it has no way to
 * express a query-string requirement at all, so it silently cannot match any
 * link this site actually generates.
 *
 * `exclude: true` components run first and win outright: `/auth/*` is the
 * `ASWebAuthenticationSession` surface Google/Apple sign-in opens in an
 * ephemeral in-app browser, and `/api/*` is the JSON API. An associated
 * domain that swallowed either would either break sign-in (the OS would try
 * to hand the session-only web view a `congress.trade` URL to the app
 * instead of letting the auth flow complete) or make plain API calls from
 * Safari/curl behave unpredictably. A bare `/` with no matching query is
 * deliberately NOT matched by any component below: home-page links keep
 * opening Safari unless they carry one of the four entity params, so sharing
 * the root URL never yanks a reader into the app.
 */
function buildAasaDocument(): Record<string, unknown> {
  return {
    applinks: {
      details: [
        {
          appIDs: [IOS_APP_ID],
          components: [
            { '/': '/auth/*', exclude: true },
            { '/': '/api/*', exclude: true },
            { '/': '/', '?': { member: '?*' } },
            { '/': '/', '?': { ticker: '?*' } },
            { '/': '/', '?': { trade: '?*' } },
            { '/': '/', '?': { view: '?*' } },
          ],
        },
      ],
    },
  };
}

/** Served body — computed once at module load; the document is static. */
export const AASA_JSON = JSON.stringify(buildAasaDocument());

/**
 * Cache duration for the AASA response. iOS's own fetch/refresh cycle for
 * associated-domains manifests is undocumented and out of our control either
 * way, so this header mainly governs any reverse proxy in front of the
 * origin and direct debugging fetches. The `/assets/*` pattern elsewhere in
 * this router uses a year-long `immutable` cache because those URLs are
 * content-hashed — a stale cache is never wrong because the URL itself would
 * change first. This file has no such hash: a future edit (e.g. adding a new
 * query param to match) would sit behind a year-long cache before any layer
 * that respects the header would pick it up. One hour is long enough that
 * the rarely-hit route doesn't cost much, short enough that a manifest fix
 * reaches production the same day it ships.
 */
const AASA_CACHE_CONTROL = 'public, max-age=3600';

/**
 * Build the Smart App Banner meta tag, or `null` when no App Store id is
 * configured yet.
 *
 * Reads `env.IOS_APP_STORE_ID` — a plain optional var, the same
 * absent-by-default shape every other optional integration in
 * `shared/types.ts` already uses (e.g. `LOGODEV_PUBLISHABLE_KEY`). The app is
 * NOT in the public App Store yet — `itunes.apple.com/lookup?bundleId=trade.congress.ios`
 * returned zero results as of 2026-08-20 — so there is no real id to put
 * here, and this function must never invent one. Leaving the var unset is
 * exactly what keeps the banner correctly absent; setting it once the app is
 * Approved lights the banner up with no code change.
 */
export function appStoreBannerTag(env: Env): string | null {
  const id = (env.IOS_APP_STORE_ID || '').trim();
  if (!/^\d+$/.test(id)) return null;
  return `<meta name="apple-itunes-app" content="app-id=${id}" />`;
}

/**
 * Post-process an already-rendered HTML response to splice in the Smart App
 * Banner tag right after `<head>`. Runs on both `/` and `/admin` (the same
 * `DASHBOARD_HTML` document, per `renderDashboard` in `routes.ts`).
 *
 * MUST be registered with `r.use(...)` BEFORE `routes.ts` registers
 * `r.get('/', …)` / `r.get('/admin', …)` — `mountAppLinks` is called at the
 * very top of `buildUiRouter()` for exactly this reason. Hono composes
 * same-path handlers in registration order, and a route handler that returns
 * without calling `next()` (which `c.html()` / `c.body()` always do) ends the
 * chain there; a `use()` registered AFTER it would simply never run.
 */
const appStoreBannerMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  const tag = appStoreBannerTag(c.env);
  if (!tag || !c.res) return;
  const contentType = c.res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return;
  const html = await c.res.text();
  c.res = new Response(html.replace('<head>', `<head>\n${tag}`), c.res);
};

/**
 * Mount both pieces onto the dashboard router. Call this ONE line at the top
 * of `buildUiRouter()`, before any other route is registered (see the
 * ordering note on `appStoreBannerMiddleware` above).
 */
export function mountAppLinks(r: Hono<{ Bindings: Env }>): void {
  // `.well-known/apple-app-site-association` is the only path iOS 9+ fetches
  // for Universal Links; this app's deployment target is iOS 17
  // (`clients/ios/CongressTrade.xcodeproj/project.pbxproj`), well past the
  // iOS 8 era when an unprefixed root-level `/apple-app-site-association`
  // fallback mattered. Serving only the canonical `.well-known` path avoids
  // a second copy of this manifest that could ever drift from the first.
  r.get('/.well-known/apple-app-site-association', (c) =>
    c.body(AASA_JSON, 200, {
      'content-type': 'application/json',
      'cache-control': AASA_CACHE_CONTROL,
    }));

  r.use('/', appStoreBannerMiddleware);
  r.use('/admin', appStoreBannerMiddleware);
}
