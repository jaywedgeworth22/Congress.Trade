const CACHE_PREFIX = 'congress-trade-shell-';
// v2: /api/ responses are network-only and never enter Cache Storage
// (CT-AUD-006 — cached authenticated responses leaked across accounts).
// Bumping the version evicts every v1 cache, including any polluted entries.
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const INSTALL_ASSETS = [
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

/** Only immutable public static assets may ever be written to Cache Storage. */
function isCacheableStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/_next/static/')) return true;
  return INSTALL_ASSETS.includes(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(INSTALL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API responses are per-account (bootstrap/preferences/subscriptions) and
  // must never be cached or served from cache: a later sign-in on the same
  // device must not see the previous account's data. Network-only.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => new Response('', { status: 503 })),
    );
    return;
  }

  // Cache-first for immutable public static assets (the only cacheable set).
  if (isCacheableStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        });
      }),
    );
    return;
  }

  // Everything else (HTML navigations, cross-origin) is network-only; nothing
  // outside the static allowlist is ever written to Cache Storage. Offline
  // navigations get an inline fallback page instead of stale cached HTML.
  event.respondWith(
    fetch(request).catch(async () => {
      if (request.mode === 'navigate') {
        return new Response(
          '<!doctype html><title>Congress.Trade offline</title><main><h1>Offline</h1><p>Reconnect to refresh congressional trade data.</p></main>',
          { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      return new Response('', { status: 503 });
    }),
  );
});
