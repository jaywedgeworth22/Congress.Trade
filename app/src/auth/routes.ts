/**
 * src/auth/routes.ts
 * End-user authentication router (mounted at /auth).
 *
 *   GET  /auth/me               -> { user: {id,email,name,picture} | null }
 *   POST /auth/logout           -> destroy session + clear cookie
 *   GET  /auth/google/start     -> redirect to Google consent screen
 *   GET  /auth/google/callback  -> verify state, exchange code, create session
 *   POST /auth/magic/request    -> { email } : email a single-use sign-in link
 *   GET  /auth/magic/verify     -> consume token, create session, redirect home
 *
 * Sessions are opaque KV tokens (see session.ts). This router owns identity
 * only; subscription/paywall gating is layered on separately.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, User } from '../shared/types';
import {
  getCurrentUser,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
} from './session';
import { buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleProfile } from './google';
import { upsertUserFromGoogle, upsertUserByEmail } from './users';
import { issueMagicToken, consumeMagicToken, magicLinkEmail } from './magic';
import { sendEmail } from './email';
import { constantTimeEqual, randomToken } from './tokens';
import { entitlementOf } from '../billing/entitlement';
import { resolveSecret } from '../secrets/infisical';
import { isAdminSessionEmail } from '../admin/identity';
import { rateLimit, clientIp } from '../shared/rateLimit';

const OAUTH_STATE_COOKIE = 'ct_oauth_state';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public-facing origin for redirects + links (APP_BASE_URL, else request origin). */
async function baseUrl(c: Context<{ Bindings: Env }>): Promise<string> {
  const configured = (await resolveSecret(c.env, 'APP_BASE_URL')).value?.trim() ?? c.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return new URL(c.req.url).origin;
}

/** Trim the User down to what the browser is allowed to see. */
function publicUser(u: User): { id: string; email: string; name: string | null; picture: string | null } {
  return { id: u.id, email: u.email, name: u.name, picture: u.picture };
}

export function buildAuthRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /auth/me -------------------------------------------------------
  // One bootstrap call for the client: identity + derived access level.
  r.get('/me', async (c) => {
    const user = await getCurrentUser(c);
    const adminAllowed = user ? await isAdminSessionEmail(c.env, user.email) : false;
    return c.json({
      user: user ? publicUser(user) : null,
      entitlement: entitlementOf(user),
      admin: { allowed: adminAllowed },
    });
  });

  // --- POST /auth/logout --------------------------------------------------
  r.post('/logout', async (c) => {
    await destroySession(c.env, getSessionToken(c));
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // --- GET /auth/google/start ---------------------------------------------
  r.get('/google/start', async (c) => {
    if (!(await resolveSecret(c.env, 'GOOGLE_OAUTH_CLIENT_ID')).value) return c.json({ error: 'google login not configured' }, 503);
    const state = randomToken(16);
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    const base = await baseUrl(c);
    const url = await buildGoogleAuthUrl(c.env, `${base}/auth/google/callback`, state);
    return c.redirect(url);
  });

  // --- GET /auth/google/callback ------------------------------------------
  r.get('/google/callback', async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });
    if (!code || !state || !cookieState || !(await constantTimeEqual(state, cookieState))) {
      return c.redirect(`${await baseUrl(c)}/?login=error`);
    }
    try {
      const base = await baseUrl(c);
      const redirectUri = `${base}/auth/google/callback`;
      const accessToken = await exchangeGoogleCode(c.env, code, redirectUri);
      const profile = await fetchGoogleProfile(accessToken);
      const user = await upsertUserFromGoogle(c.env, profile);
      setSessionCookie(c, await createSession(c.env, user.id));
      return c.redirect(`${base}/?login=ok`);
    } catch (err) {
      console.error('google callback failed:', (err as Error).message);
      return c.redirect(`${await baseUrl(c)}/?login=error`);
    }
  });

  // --- POST /auth/magic/request -------------------------------------------
  // Always returns ok:true (no account enumeration); `sent` flags delivery.
  r.post('/magic/request', async (c) => {
    let body: { email?: unknown };
    try {
      body = (await c.req.json()) as { email?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return c.json({ error: 'valid email required' }, 400);
    // Throttle to stop magic-link email-bombing: per-email (5/hr) and a per-IP
    // burst cap (10/10min). Fails open if KV is unavailable.
    const ip = clientIp(c.req.raw);
    const ipRl = await rateLimit(c.env, 'magic-ip', ip, 10, 600);
    const emailRl = await rateLimit(c.env, 'magic-email', email, 5, 3600);
    if (!ipRl.ok || !emailRl.ok) {
      const retryAfter = Math.max(ipRl.retryAfterSec, emailRl.retryAfterSec);
      return c.json({ error: 'too many requests, please try again later' }, 429, {
        'Retry-After': String(retryAfter),
      });
    }
    try {
      const token = await issueMagicToken(c.env, email);
      const verifyUrl = `${await baseUrl(c)}/auth/magic/verify?token=${encodeURIComponent(token)}`;
      const mail = magicLinkEmail(verifyUrl);
      await sendEmail(c.env, { to: email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (err) {
      console.error('magic request failed:', (err as Error).message);
      return c.json({ ok: true, sent: false });
    }
    return c.json({ ok: true, sent: true });
  });

  // --- GET /auth/magic/verify ---------------------------------------------
  r.get('/magic/verify', async (c) => {
    const token = new URL(c.req.url).searchParams.get('token') ?? '';
    const email = token ? await consumeMagicToken(c.env, token) : null;
    if (!email) return c.redirect(`${await baseUrl(c)}/?login=expired`);
    const user = await upsertUserByEmail(c.env, email);
    setSessionCookie(c, await createSession(c.env, user.id));
    return c.redirect(`${await baseUrl(c)}/?login=ok`);
  });

  return r;
}
