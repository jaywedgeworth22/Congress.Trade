/**
 * Google OAuth callback: email_verified enforcement (panel HIGH).
 *
 * The callback matches the Google profile to existing accounts by email.
 * Without requiring email_verified, an attacker with a Google account
 * claiming (but not verifying) a victim's address could sign in as the
 * victim. The callback must reject unverified profiles with a clear error
 * and never create a session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../google', () => ({
  buildGoogleAuthUrl: vi.fn(async () => 'https://accounts.google.com/o/oauth2/v2/auth?mock'),
  exchangeGoogleCode: vi.fn(async () => 'access-token'),
  fetchGoogleProfile: vi.fn(),
}));

import { buildAuthRouter } from '../routes';
import { fetchGoogleProfile } from '../google';
import type { Env } from '../../shared/types';

interface UserRowShape {
  id: string;
  email: string;
  [key: string]: unknown;
}

function fakeEnv(): { env: Env; kvPuts: string[] } {
  const kv = new Map<string, string>();
  const kvPuts: string[] = [];
  const users = new Map<string, UserRowShape>(); // id -> row
  const env = {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    APP_BASE_URL: 'https://congress.trade',
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kvPuts.push(k);
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    DB: {
      prepare: (sql: string) => ({
        _p: [] as unknown[],
        bind(...p: unknown[]) {
          this._p = p;
          return this;
        },
        async first() {
          if (/FROM users WHERE id/i.test(sql)) return users.get(this._p[0] as string) ?? null;
          if (/FROM users WHERE email/i.test(sql)) {
            return [...users.values()].find((u) => u.email === this._p[0]) ?? null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO users/i.test(sql)) {
            const [id, email, name, picture, google_sub, email_verified, created_at, last_login_at] = this._p;
            users.set(id as string, {
              id, email, name, picture, google_sub, email_verified, created_at, last_login_at,
            } as UserRowShape);
          }
          return {};
        },
        async all() {
          return { results: [] };
        },
      }),
    },
  } as unknown as Env;
  return { env, kvPuts };
}

function callbackRequest() {
  return new Request('https://congress.trade/google/callback?code=auth-code&state=st', {
    headers: { Cookie: 'ct_oauth_state=st; ct_auth_origin=https://congress.trade' },
  });
}

describe('GET /google/callback email_verified enforcement', () => {
  beforeEach(() => {
    vi.mocked(fetchGoogleProfile).mockReset();
  });

  it('rejects an unverified profile with a clear error and no session', async () => {
    vi.mocked(fetchGoogleProfile).mockResolvedValue({
      sub: 'attacker-sub',
      email: 'victim@x.com',
      emailVerified: false,
      name: 'Attacker',
      picture: null,
    });
    const { env, kvPuts } = fakeEnv();
    const app = buildAuthRouter();
    const res = await app.request(callbackRequest(), {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://congress.trade/?login=unverified');
    // No session was created and no session cookie was set.
    expect(kvPuts.filter((k) => k.startsWith('sess:'))).toEqual([]);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('ct_session=');
  });

  it('signs in a verified profile and sets a session cookie', async () => {
    vi.mocked(fetchGoogleProfile).mockResolvedValue({
      sub: 'good-sub',
      email: 'user@x.com',
      emailVerified: true,
      name: 'User',
      picture: null,
    });
    const { env, kvPuts } = fakeEnv();
    const app = buildAuthRouter();
    const res = await app.request(callbackRequest(), {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://congress.trade/?login=ok');
    expect(kvPuts.some((k) => k.startsWith('sess:'))).toBe(true);
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('ct_session=');
    expect(setCookie.toLowerCase()).not.toContain('domain=');
  });
});
