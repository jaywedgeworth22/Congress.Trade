/**
 * Trusted-proxy TLS inference.
 *
 * Production serves plain HTTP *inside* the container — `Deno.serve` binds
 * :5000 with no TLS cert (src/deno/main.ts) behind Coolify's Caddy and
 * Cloudflare — so `new URL(c.req.url).protocol` is ALWAYS `'http:'` in prod.
 * Any `Secure` / HSTS decision derived from it therefore fails OPEN: the
 * request really is HTTPS end-to-end, but the app cannot see it.
 *
 * On Cloudflare Workers the socket URL genuinely was `https:`, so the original
 * inference was correct there and regressed silently during the Workers ->
 * Deno/Coolify migration.
 *
 * Two rules, in order:
 *   1. Trust `X-Forwarded-Proto`. Caddy and Cloudflare both set it, and the
 *      container port is published on loopback (`127.0.0.1:5000`), so no
 *      untrusted client can reach the app directly to spoof it.
 *   2. Otherwise fail CLOSED — assume TLS unless the public host is a
 *      developer loopback host. A missing header must never downgrade
 *      production cookies.
 */

import type { Context } from 'hono';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function hostnameOnly(host: string | undefined): string {
  if (!host) return '';
  const h = host.trim().toLowerCase();
  // Bracketed IPv6 literal: "[::1]:5000" -> "[::1]"
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colons = h.split(':').length - 1;
  if (colons > 1) return h; // Unbracketed IPv6 address (e.g. "::1")
  if (colons === 1) return h.slice(0, h.indexOf(':')); // Host:port
  return h;
}

function isLocalHost(host: string | undefined): boolean {
  const h = hostnameOnly(host);
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost');
}

/**
 * Pure core, so the decision is unit-testable without a Hono `Context`.
 *
 * @param forwardedProto value of `X-Forwarded-Proto`, if any
 * @param publicHost     value of `X-Forwarded-Host` / `Host`, if any
 * @param requestUrl     the socket-level request URL
 */
export function isSecureRequestParts(
  forwardedProto: string | undefined,
  publicHost: string | undefined,
  requestUrl: string,
): boolean {
  // X-Forwarded-Proto may be a comma list ("https,http"); the client-facing
  // hop is the first entry.
  const proto = (forwardedProto ?? '').split(',')[0]?.trim().toLowerCase();
  if (proto === 'https') return true;

  let urlHost = '';
  try {
    const u = new URL(requestUrl);
    // Direct TLS: Cloudflare Workers, or a local https dev server.
    if (u.protocol === 'https:') return true;
    urlHost = u.host;
  } catch {
    // Unparseable URL: fall through to the host check below.
  }

  // Nothing proves TLS. Only local development is allowed to be insecure —
  // production must never emit a cookie without `Secure`.
  return !isLocalHost(publicHost || urlHost);
}

/** Whether the client-facing hop for this request used TLS. */
export function isSecureRequest(c: Context): boolean {
  return isSecureRequestParts(
    c.req.header('X-Forwarded-Proto'),
    c.req.header('X-Forwarded-Host') || c.req.header('Host'),
    c.req.url,
  );
}
