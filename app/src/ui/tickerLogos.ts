/**
 * src/ui/tickerLogos.ts
 * OWNER: dashboard agent
 *
 * Ticker → company-logo support, ported from the agentic-trading project's
 * `lib/ticker-logos.ts` + `app/api/logos/ticker/route.ts`. Same approach,
 * adapted from Next.js to this Cloudflare Worker:
 *
 *   - Single upstream source: davidepalazzo/ticker-logos on GitHub (raw PNGs).
 *   - A cached server proxy resolves a symbol through a few spelling variants
 *     (BRK.B → BRK-B → BRK.B → BRK_B …) because the repo filenames aren't
 *     always consistent, and only passes through responses that are actually
 *     PNGs (GitHub 404s come back as text/HTML).
 *   - Long-lived, edge-cacheable response headers; the 404 is cacheable too.
 *
 * The dashboard renders `<img src="/api/logos/ticker?symbol=AAPL">` and toggles
 * only the *framing* client-side (glass "tile" vs bare "transparent" vs "off").
 * There is no monochrome / white-shape variant — the toggle is framing only.
 */

const TICKER_LOGO_BASE_URL =
  'https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons';
const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/;

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
      symbol.replace(/\./g, '-'),
      symbol.replace(/-/g, '.'),
      symbol.replace(/[.-]/g, '_'),
    ]),
  );
}

export function tickerLogoRawUrl(symbol: string): string {
  return `${TICKER_LOGO_BASE_URL}/${encodeURIComponent(symbol)}.png`;
}

/**
 * Cached proxy for a single ticker logo. Mirrors the agentic-trading App Router
 * handler: validate the symbol, try spelling variants, only pass through real
 * PNGs, and emit long-lived cache headers (with a 404 that is itself cacheable
 * so a missing logo isn't re-fetched on every render).
 */
export async function handleTickerLogoRequest(url: URL): Promise<Response> {
  const candidates = tickerLogoCandidates(url.searchParams.get('symbol'));
  if (candidates.length === 0) {
    return new Response(JSON.stringify({ error: 'symbol is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  for (const symbol of candidates) {
    let upstream: Response;
    try {
      // Lean on Cloudflare's edge cache for the upstream GitHub fetch.
      upstream = await fetch(tickerLogoRawUrl(symbol), {
        cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
      });
    } catch {
      continue;
    }
    if (!upstream.ok) continue;

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/png')) continue; // GitHub 404s return HTML/text

    return new Response(upstream.body, {
      headers: {
        'cache-control': `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
        'content-type': 'image/png',
        'x-logo-source': 'github:davidepalazzo/ticker-logos',
      },
    });
  }

  return new Response(null, {
    status: 404,
    headers: { 'cache-control': `public, max-age=${ONE_DAY_SECONDS}` },
  });
}
