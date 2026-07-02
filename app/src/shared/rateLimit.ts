/**
 * src/shared/rateLimit.ts
 *
 * Lightweight fixed-window rate limiter backed by CONFIG_KV. This is a
 * deliberately simple per-(bucket, identifier, window) counter — NOT a precise
 * token bucket — intended to blunt abuse of the few unauthenticated, cost- or
 * reputation-bearing endpoints (magic-link email send, public subscription
 * creation, heavy exports) that previously had no throttle at all.
 *
 * Design choices:
 * - Fails OPEN: any KV error allows the request, so a KV blip never 500s a
 *   public endpoint.
 * - KV is eventually consistent, so the count is approximate within a window —
 *   good enough to stop scripted bursts, not a billing-grade limiter. For
 *   strict per-request limits, migrate to Cloudflare's native Rate Limiting
 *   binding; this module keeps the call sites identical if you do.
 */
import type { Env } from './types';

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

type KvEnv = Env & { CONFIG_KV?: KVNamespace };

/**
 * Hash an identifier before it becomes part of a KV key name. `magic-email`
 * buckets on the raw submitted address; the magic-link endpoint is public and
 * accepts arbitrary addresses, so an unhashed key would leak victim email PII
 * into listable KV key metadata even when no login occurs. SHA-256 truncated
 * to 32 hex chars is plenty of collision resistance for a rate-limit bucket.
 */
async function hashIdentifier(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Returns ok=false when `identifier` has already made `limit` requests in the
 * current `windowSec` window for `bucket`. Counting increments only when ok.
 */
export async function rateLimit(
  env: KvEnv,
  bucket: string,
  identifier: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const kv = env.CONFIG_KV;
  if (!kv) return { ok: true, remaining: limit, retryAfterSec: 0 };

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const key = `rl:${bucket}:${await hashIdentifier(identifier)}:${windowStart}`;

  let count = 0;
  try {
    const cur = await kv.get(key);
    count = cur ? parseInt(cur, 10) || 0 : 0;
  } catch {
    return { ok: true, remaining: limit, retryAfterSec: 0 }; // fail open
  }

  if (count >= limit) {
    return { ok: false, remaining: 0, retryAfterSec: windowStart + windowSec - now };
  }

  try {
    // Expire a little past the window so stale counters self-clean.
    await kv.put(key, String(count + 1), { expirationTtl: windowSec + 5 });
  } catch {
    /* fail open on write error */
  }
  return { ok: true, remaining: limit - count - 1, retryAfterSec: 0 };
}

/** Best-effort client IP from Cloudflare / proxy headers. */
export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}
