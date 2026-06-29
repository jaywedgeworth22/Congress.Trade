/**
 * src/shared/middleware.ts
 * Reusable Hono middlewares: security headers, CORS, rate limiting.
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// securityHeaders — adds security-focused response headers to every response
// ---------------------------------------------------------------------------

export const securityHeaders: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'",
  );
  c.header(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-XSS-Protection', '1; mode=block');
};

// ---------------------------------------------------------------------------
// corsMiddleware — CORS handling with preflight support
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = [
  'https://congress.trade',
  'https://admin.congress.trade',
  'https://trading.jays.services',
];

function originAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow localhost with any port for development
  return /^http:\/\/localhost(:\d+)?$/.test(origin);
}

export const corsMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const origin = c.req.header('Origin');

  if (origin && originAllowed(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
  }
  c.header('Access-Control-Allow-Credentials', 'true');

  // Handle preflight requests
  if (c.req.method === 'OPTIONS') {
    c.header(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    c.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Subscription-Secret, X-Idempotency-Key',
    );
    c.header('Access-Control-Max-Age', '86400');
    return new Response(null, { status: 204 });
  }

  await next();
};

// ---------------------------------------------------------------------------
// rateLimiter — in-memory KV-backed rate limiter with X-RateLimit-* headers
// ---------------------------------------------------------------------------

function pathPattern(pathname: string): string {
  if (pathname.startsWith('/api/admin')) return '/api/admin';
  if (pathname.startsWith('/api/client')) return '/api/client';
  if (pathname.startsWith('/api/analytics')) return '/api/analytics';
  if (pathname.startsWith('/api/export')) return '/api/export';
  if (pathname.startsWith('/api/')) return '/api';
  if (pathname.startsWith('/auth')) return '/auth';
  if (pathname.startsWith('/billing')) return '/billing';
  return 'general';
}

export const rateLimiter: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const pattern = pathPattern(pathname);

  // Determine the per-minute limit
  let limit: number;
  if (pattern === '/api/admin') {
    limit = 1000;
  } else {
    const authHeader = c.req.header('Authorization');
    const cookie = c.req.header('Cookie') ?? '';
    const hasSession = cookie.includes('ct_session');
    limit = authHeader || hasSession ? 300 : 100;
  }

  const minuteTs = Math.floor(Date.now() / 60_000);
  const key = `rl:${pattern}:${minuteTs}`;

  try {
    const raw = await c.env.CONFIG_KV.get(key);
    const current = raw ? parseInt(raw, 10) : 0;

    if (current >= limit) {
      const retryAfter = Math.ceil(60 - ((Date.now() / 1000) % 60));
      c.header('X-RateLimit-Limit', String(limit));
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', String(minuteTs + 1));
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'rate_limit_exceeded', retryAfter }, 429);
    }

    await c.env.CONFIG_KV.put(key, String(current + 1), { expirationTtl: 120 });
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(limit - current - 1));
    c.header('X-RateLimit-Reset', String(minuteTs + 1));
  } catch {
    // KV errors should not block the request — allow through without rate limit
  }

  await next();
};
