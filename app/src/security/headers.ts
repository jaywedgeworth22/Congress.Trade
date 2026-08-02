/**
 * Browser security headers for Worker-generated responses.
 *
 * The dashboard is currently one static document with inline CSS, script, and
 * event handlers. The CSP therefore keeps narrowly scoped inline exceptions
 * while denying frames, objects, cross-origin connections, and other default
 * loads. Removing those two exceptions is the follow-up once the dashboard is
 * split into nonceable/static assets.
 */

import type { MiddlewareHandler } from 'hono';
import { isSecureRequest, isSecureRequestParts } from './requestProtocol.ts';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self'",
  "form-action 'self'",
].join('; ');

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/**
 * @param opts.secure whether the client-facing hop used TLS. Callers with a
 *   request Context should pass `isSecureRequest(c)` — behind the production
 *   proxy the socket URL is always `http:`, so inferring it from `requestUrl`
 *   alone silently drops HSTS. See ./requestProtocol.ts.
 */
export function browserSecurityHeaders(requestUrl: string, opts: { secure?: boolean } = {}): Headers {
  const headers = new Headers(BASE_HEADERS);
  const secure = opts.secure ?? isSecureRequestParts(undefined, undefined, requestUrl);
  if (secure) {
    // Deliberately omit includeSubDomains/preload until every sibling hostname
    // is audited; the app still pins HTTPS for its own host for one year.
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return headers;
}

export const browserSecurityHeadersMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [name, value] of browserSecurityHeaders(c.req.url, { secure: isSecureRequest(c) })) {
    c.header(name, value);
  }
};
