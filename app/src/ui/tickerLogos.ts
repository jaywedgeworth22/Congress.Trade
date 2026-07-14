/**
 * src/ui/tickerLogos.ts
 * OWNER: dashboard agent
 *
 * Ticker → company-logo support. A cached server proxy resolves a symbol to a
 * PNG so the browser only ever sees `/api/logos/ticker?symbol=AAPL` (the logo
 * provider's key + allowed-referrer stay server-side, and the edge caches the
 * result). Sources, in order:
 *
 *   1. logo.dev (primary) — best coverage incl. ETFs + delisted names, with a
 *      dark-theme variant. Its publishable key is referrer-restricted, so the
 *      proxy sends a `Referer` matching an allowed domain; `fallback=404` makes
 *      it 404 on a true miss (so we fall through rather than serve a monogram —
 *      the dashboard draws its own monogram from the ticker initials).
 *   2. davidepalazzo/ticker-logos on GitHub (fallback) — keeps logos working if
 *      the logo.dev key is absent / over quota.
 *
 * The dashboard renders `<img src="/api/logos/ticker?symbol=AAPL">` and toggles
 * only the *framing* client-side (glass "tile" vs bare "transparent" vs "off").
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry';

const TICKER_LOGO_BASE_URL =
  'https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons';
const SYMBOL_PATTERN = /^[A-Z0-9._^-]{1,20}$/;
// logo.dev publishable keys are locked to allowed domains; the proxy sends this
// as the Referer so a server-side fetch is accepted (the prod origin is allowed).
const LOGO_REFERER = 'https://congress.trade';

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;

/** Uppercase, strip a leading `$`, and reject anything that isn't a plausible symbol. */
export function normalizeTickerLogoSymbol(value: string | null | undefined): string | null {
  const symbol = value?.trim().replace(/^\$/, '').toUpperCase();
  if (!symbol || !SYMBOL_PATTERN.test(symbol)) return null;
  return symbol;
}

/** Repo filenames aren't always consistent for symbols like BRK.B — try variants. */
export function tickerLogoCandidates(value: string | null | undefined): string[] {
  const symbol = normalizeTickerLogoSymbol(value);
  if (!symbol) return [];
  return Array.from(
    new Set([
      symbol,
      symbol.replace(/\^/g, '-'),
      symbol.replace(/\^/g, '.'),
      symbol.replace(/\./g, '-'),
      symbol.replace(/-/g, '.'),
      symbol.replace(/[.^-]/g, '_'),
    ]),
  );
}

export function tickerLogoRawUrl(symbol: string): string {
  return `${TICKER_LOGO_BASE_URL}/${encodeURIComponent(symbol)}.png`;
}

/** logo.dev ticker endpoint URL (PNG, dark by default, 404 on a true miss). */
export function logoDevUrl(symbol: string, token: string, theme: 'dark' | 'light' = 'dark'): string {
  return (
    `https://img.logo.dev/ticker/${encodeURIComponent(symbol)}` +
    `?token=${encodeURIComponent(token)}&format=png&theme=${theme}&size=128&retina=true&fallback=404`
  );
}

function passThroughPng(upstream: Response, source: string): Response {
  return new Response(upstream.body, {
    headers: {
      'cache-control': `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
      'content-type': 'image/png',
      'x-logo-source': source,
    },
  });
}

/**
 * Cached proxy for a single ticker logo: validate the symbol, try logo.dev
 * (when a key is configured) then the GitHub repo, pass through only real PNGs,
 * and emit long-lived cache headers (the 404 is cacheable too, so a missing
 * logo isn't re-fetched on every render).
 */
export async function handleTickerLogoRequest(url: URL, logoDevToken?: string): Promise<Response> {
  const symbol = normalizeTickerLogoSymbol(url.searchParams.get('symbol'));
  if (!symbol) {
    return new Response(JSON.stringify({ error: 'symbol is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';

  // 1) logo.dev (primary) — referrer-restricted key, so spoof the allowed origin.
  if (logoDevToken) {
    try {
      const res = await trackedFetch(logoDevUrl(symbol, logoDevToken, theme), {
        headers: { referer: LOGO_REFERER },
        cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
      }, { service: 'asset-logo', operation: 'fetch-logo-primary' });
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) {
        return passThroughPng(res, 'logo.dev');
      }
    } catch {
      /* fall through to the GitHub source */
    }
  }

  // 2) davidepalazzo/ticker-logos on GitHub (fallback), trying spelling variants.
  for (const candidate of tickerLogoCandidates(symbol)) {
    let upstream: Response;
    try {
      upstream = await trackedFetch(tickerLogoRawUrl(candidate), {
        cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
      }, { service: 'asset-logo', operation: 'fetch-logo-fallback' });
    } catch {
      continue;
    }
    if (!upstream.ok) continue;
    if (!(upstream.headers.get('content-type') ?? '').startsWith('image/png')) continue; // GitHub 404s return HTML
    return passThroughPng(upstream, 'github:davidepalazzo/ticker-logos');
  }

  return new Response(null, {
    status: 404,
    headers: { 'cache-control': `public, max-age=${ONE_DAY_SECONDS}` },
  });
}
