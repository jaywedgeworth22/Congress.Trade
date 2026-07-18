/**
 * src/shared/kvCache.ts
 * Read-through response cache over CONFIG_KV, shared by the analytics and public
 * data routers. Keeps expensive full-corpus D1 aggregations from re-scanning on
 * every request. Plain TTL (not stale-while-revalidate); a miss or any KV error
 * just recomputes, so it can never break a request.
 */
import type { Env } from './types';

/** Stable cache key from an endpoint name + the resolved params object. */
export function cacheKey(name: string, obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj)
    .sort()
    .map((k) => `${k}=${obj[k] ?? ''}`)
    .join('&');
  return `analytics:${name}:${sorted}`;
}

/** Read-through cache over CONFIG_KV. A miss or any KV error just recomputes. */
export async function cached<T>(
  env: Env,
  key: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await env.CONFIG_KV.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    /* fall through to compute */
  }
  const value = await fn();
  try {
    await env.CONFIG_KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSec) });
  } catch {
    /* best-effort cache; ignore */
  }
  return value;
}
