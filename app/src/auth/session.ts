/**
 * src/auth/session.ts
 * Opaque, KV-backed end-user sessions + the httpOnly session cookie.
 *
 * A session is a high-entropy random token stored in CONFIG_KV under
 * `sess:<token>` with a 30-day TTL; the token rides in the `ct_session` cookie
 * (HttpOnly, SameSite=Lax, Secure on https). Each request resolves token ->
 * userId (KV) -> fresh User row (D1), so profile/subscription changes are seen
 * immediately and logout is a single KV delete. We reuse CONFIG_KV (prefixed)
 * to avoid a new binding; a dedicated AUTH_KV can be split out later.
 */

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, User } from '../shared/types';
import { getUserById } from './users';
import { randomToken } from './tokens';
import { resolveSecret } from '../secrets/infisical';

export const SESSION_COOKIE = 'ct_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const SESSION_PREFIX = 'sess:';

interface SessionData {
  userId: string;
}

/** Create a session for `userId` and return its opaque token. */
export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  const data: SessionData = { userId };
  await env.CONFIG_KV.put(SESSION_PREFIX + token, JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SEC,
  });
  return token;
}

/** Resolve a session token to its fresh User (or null if missing/expired). */
export async function resolveSession(env: Env, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const raw = await env.CONFIG_KV.get(SESSION_PREFIX + token);
  if (!raw) return null;
  let data: SessionData;
  try {
    data = JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
  if (!data.userId) return null;
  return getUserById(env, data.userId);
}

export async function destroySession(env: Env, token: string | undefined): Promise<void> {
  if (!token) return;
  await env.CONFIG_KV.delete(SESSION_PREFIX + token);
}

function isHttps(c: Context): boolean {
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return true;
  }
}

export async function getCookieDomain(c: Context<{ Bindings: Env }>): Promise<string | undefined> {
  const configured = (await resolveSecret(c.env, 'APP_BASE_URL')).value?.trim();
  if (!configured) return undefined;
  try {
    const hostname = new URL(configured).hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.localhost') ||
      hostname.includes(':')
    ) {
      return undefined;
    }
    return hostname;
  } catch {
    return undefined;
  }
}

export function getSafeRedirectUrl(origin: string | undefined, defaultBase: string, domain: string | undefined): string {
  if (!origin) return defaultBase;
  try {
    const originUrl = new URL(origin);
    const defaultUrl = new URL(defaultBase);

    // If it exactly matches the default origin, it's safe
    if (originUrl.origin === defaultUrl.origin) return origin;

    // If it's localhost or 127.0.0.1 (local dev), it's safe
    if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') return origin;

    // If we have a shared root domain configured, allow any subdomain of it
    if (domain) {
      if (originUrl.hostname.endsWith('.' + domain) || originUrl.hostname === domain) {
        return origin;
      }
    }
    return defaultBase;
  } catch {
    return defaultBase;
  }
}

export async function setSessionCookie(c: Context<{ Bindings: Env }>, token: string): Promise<void> {
  const domain = await getCookieDomain(c);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
    domain,
  });
}

export async function clearSessionCookie(c: Context<{ Bindings: Env }>): Promise<void> {
  const domain = await getCookieDomain(c);
  deleteCookie(c, SESSION_COOKIE, { path: '/', domain });
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

function bearerSessionToken(c: Context): string | undefined {
  const value = c.req.header('Authorization');
  const prefix = 'Bearer ';
  if (!value || !value.startsWith(prefix)) return undefined;
  const token = value.slice(prefix.length).trim();
  return token || undefined;
}

/** Resolve a session from the httpOnly cookie first, then a bearer token.
 * Native clients use the bearer path; browser/PWA clients keep the cookie path. */
export function getSessionTokenFromRequest(c: Context): string | undefined {
  return getSessionTokensFromRequest(c)[0];
}

/** Return every distinct session credential presented by the request. Logout
 * uses this to revoke a browser cookie and native bearer token together. */
export function getSessionTokensFromRequest(c: Context): string[] {
  const tokens = [getSessionToken(c), bearerSessionToken(c)].filter(
    (token): token is string => Boolean(token),
  );
  return [...new Set(tokens)];
}

/** Resolve the current end user from the request cookie (or null). */
export async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
  return resolveSession(c.env, getSessionToken(c));
}

/** Resolve the current end user from cookie or Authorization bearer token. */
export async function getCurrentUserFromRequest(c: Context<{ Bindings: Env }>): Promise<User | null> {
  return resolveSession(c.env, getSessionTokenFromRequest(c));
}
