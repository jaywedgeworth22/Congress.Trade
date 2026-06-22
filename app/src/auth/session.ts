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

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/** Resolve the current end user from the request cookie (or null). */
export async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
  return resolveSession(c.env, getSessionToken(c));
}
