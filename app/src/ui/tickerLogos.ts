/**
 * src/ui/tickerLogos.ts
 * OWNER: dashboard agent
 *
 * Ticker → company-logo support. A cached server proxy resolves a symbol to a
 * PNG so the browser only ever sees `/api/logos/ticker?symbol=AAPL` (the logo
 * provider's key + allowed-referrer stay server-side, and the edge caches the
 * result). Sources, in order:
 *
 *   1. logo.dev — best general coverage when the key is live (prefer over
 *      interim local options). Key: LOGODEV_PUBLISHABLE_KEY or LOGO_DEV_TOKEN.
 *   2. Repo pack (`app/public/assets/ticker-logos/SYMBOL.png`) — gap-fill for
 *      private / thin-coverage names (SPCX, HONAV, …). Owner options, replaceable.
 *   3. davidepalazzo/ticker-logos on GitHub — last resort.
 *
 * Empty/non-PNG "success" responses from logo.dev or GitHub are rejected so we
 * fall through instead of caching blank images that never fire img.onerror.
 *
 * The dashboard renders `<img src="/api/logos/ticker?symbol=AAPL">` and toggles
 * only the *framing* client-side (glass "tile" vs bare "transparent" vs "off").
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { PUBLIC_ASSETS_DIR } from './assets.ts';

const TICKER_LOGO_BASE_URL =
  'https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons';
const LOCAL_TICKER_LOGO_DIR = join(PUBLIC_ASSETS_DIR, 'assets/ticker-logos');
const SYMBOL_PATTERN = /^[A-Z0-9._^-]{1,20}$/;
// logo.dev publishable keys are locked to allowed domains; the proxy sends this
// as the Referer so a server-side fetch is accepted (the prod origin is allowed).
const LOGO_REFERER = 'https://congress.trade';

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;
/** Below this size a "PNG" is almost certainly empty/corrupt (real logos are larger). */
const MIN_PNG_BYTES = 64;

/** Optional alias when disclosure name ≠ public ticker / logo pack filename. */
const LOCAL_SYMBOL_ALIASES: Record<string, string> = {
  HONAV: 'HONAV', // Honeywell Aerospace (owner-supplied pack)
  SPCX: 'SPCX', // SpaceX private mark
  TSCO: 'TSCO',
  'BRK.B': 'BRK.B',
  BRKB: 'BRKB',
  'BRK-B': 'BRK-B',
};

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

/** True when bytes look like a real PNG (magic + non-trivial size). */
export function isValidPngBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MIN_PNG_BYTES) return false;
  // \x89PNG\r\n\x1a\n
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function pngResponse(bytes: Uint8Array, source: string): Response {
  // Fresh ArrayBuffer-backed copy so Response accepts it under Deno/Node.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, {
    headers: {
      'cache-control': `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
      'content-type': 'image/png',
      'content-length': String(copy.byteLength),
      'x-logo-source': source,
    },
  });
}

/**
 * Read an upstream image response and keep only non-empty valid PNGs.
 * Rejects empty 200s / HTML error pages that would otherwise blank the UI
 * without firing img.onerror.
 */
export async function readValidPng(res: Response): Promise<Uint8Array | null> {
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  // Allow missing CT (some CDNs omit it) but reject obvious non-images.
  if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream')) return null;
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  return isValidPngBytes(buf) ? buf : null;
}

/** Try repo pack: `app/public/assets/ticker-logos/{SYMBOL}.png` (and candidates). */
export function tryLocalTickerLogo(symbol: string): Response | null {
  const names = new Set<string>([
    LOCAL_SYMBOL_ALIASES[symbol] ?? symbol,
    ...tickerLogoCandidates(symbol),
  ]);
  for (const name of names) {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) continue;
    const abs = join(LOCAL_TICKER_LOGO_DIR, `${name}.png`);
    if (!existsSync(abs)) continue;
    try {
      const buf = readFileSync(abs);
      const bytes = new Uint8Array(buf);
      if (!isValidPngBytes(bytes)) continue;
      return pngResponse(bytes, `local:ticker-logos/${name}.png`);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Cached proxy for a single ticker logo: logo.dev → local pack → GitHub.
 * Long-lived cache headers only on real PNG successes.
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

  // 1) logo.dev first when key is present — but never accept empty/non-PNG bodies.
  if (logoDevToken) {
    try {
      const res = await trackedFetch(logoDevUrl(symbol, logoDevToken, theme), {
        headers: { referer: LOGO_REFERER, accept: 'image/png,image/*;q=0.8,*/*;q=0.5' },
        cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
      }, { service: 'asset-logo', operation: 'fetch-logo-primary' });
      const png = await readValidPng(res);
      if (png) return pngResponse(png, 'logo.dev');
    } catch {
      /* fall through */
    }
  }

  // 2) Repo pack — gap-fill (private names / logo.dev miss or empty).
  const local = tryLocalTickerLogo(symbol);
  if (local) return local;

  // 3) davidepalazzo/ticker-logos on GitHub (last resort).
  for (const candidate of tickerLogoCandidates(symbol)) {
    let upstream: Response;
    try {
      upstream = await trackedFetch(tickerLogoRawUrl(candidate), {
        headers: { accept: 'image/png' },
        cf: { cacheTtl: ONE_WEEK_SECONDS, cacheEverything: true },
      }, { service: 'asset-logo', operation: 'fetch-logo-fallback' });
    } catch {
      continue;
    }
    const png = await readValidPng(upstream);
    if (png) return pngResponse(png, 'github:davidepalazzo/ticker-logos');
  }

  // Short cache on miss so a transient provider outage recovers quickly.
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': `public, max-age=300` },
  });
}
