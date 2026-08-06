/**
 * src/ui/assets.ts
 * OWNER: dashboard agent
 *
 * Binary brand/icon/font assets live as real files under `app/public/` and are
 * served by ui/routes.ts with long cache headers. This module loads those
 * files once (via node:fs — works under Deno and Vitest) so the TypeScript
 * bundle no longer embeds multi-megabyte base64 strings.
 *
 * Issue #1040: extract base64 from dashboardHtml/assets.ts to static routes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StaticAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Directory containing committed binary assets (relative to this module). */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public');

function loadAsset(relativePath: string, contentType: string): StaticAsset {
  const abs = join(PUBLIC_DIR, relativePath);
  const buf = readFileSync(abs);
  // Always copy into a standalone Uint8Array (Buffer is a Uint8Array subclass
  // in Node; Deno's node:fs also returns Buffer-compatible bytes).
  return { bytes: new Uint8Array(buf), contentType };
}

// Font + brand images (immutable-cache routes under /assets/*).
export const ZILLA_SLAB_WOFF2 = loadAsset('assets/zilla-slab-700.woff2', 'font/woff2');
export const EAGLE_SPLASH_PNG = loadAsset('assets/eagle-splash.png', 'image/png');
export const BRAND_LOGO_PNG = loadAsset('assets/brand-logo.png', 'image/png');
export const BRAND_LOGO_DARK_PNG = loadAsset('assets/brand-logo-dark.png', 'image/png');
export const BRAND_LOGO_LIGHT_PNG = loadAsset('assets/brand-logo-light.png', 'image/png');

// Well-known root icons / social card (long cache, stable paths).
export const OG_IMAGE_PNG = loadAsset('og-image.png', 'image/png');
export const ICON_192_PNG = loadAsset('icon-192.png', 'image/png');
export const ICON_512_PNG = loadAsset('icon-512.png', 'image/png');
export const APPLE_TOUCH_ICON_PNG = loadAsset('apple-touch-icon.png', 'image/png');
/** Favicon bytes (PNG content; served at /favicon.ico with image/png). */
export const FAVICON_PNG = loadAsset('favicon.png', 'image/png');

/** Absolute path to the public asset root (for tests / tooling). */
export const PUBLIC_ASSETS_DIR = PUBLIC_DIR;

export const SITE_WEBMANIFEST = JSON.stringify({
  name: 'Congress.Trade',
  short_name: 'Congress.Trade',
  description: 'Live STOCK Act disclosures from the House & Senate, plus premium webhooks.',
  start_url: '/',
  display: 'standalone',
  background_color: '#08111f',
  theme_color: '#08111f',
  icons: [
    { src: '/icon-192.png?v=7', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png?v=7', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
