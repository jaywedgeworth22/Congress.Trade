import { describe, it, expect, vi } from 'vitest';

vi.mock('../google', () => ({
  buildGoogleAuthUrl: vi.fn(async (_env: unknown, redirectUri: string) => redirectUri),
  exchangeGoogleCode: vi.fn(async () => 'access-token'),
  fetchGoogleProfile: vi.fn(async () => ({
    sub: 'google-sub',
    email: 'user@example.com',
    emailVerified: true,
    name: 'User',
    picture: null,
  })),
}));

import { buildAuthRouter } from '../routes';
import { buildGoogleAuthUrl, exchangeGoogleCode } from '../google';
import type { Env } from '../../shared/types';

function fakeEnv(): Env {
  const kv = new Map<string, string>();
  const users = new Map<string, Record<string, unknown>>();
  return {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    APP_BASE_URL: 'https://congress.trade',
    CONFIG_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
      delete: async (key: string) => { kv.delete(key); },
    },
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[],
        bind(...params: unknown[]) { this.params = params; return this; },
        async first() {
          if (/WHERE email/i.test(sql)) return [...users.values()].find((u) => u.email === this.params[0]) ?? null;
          if (/WHERE id/i.test(sql)) return users.get(this.params[0] as string) ?? null;
          return null;
        },
        async run() {
          if (/INSERT INTO users/i.test(sql)) {
            const [id, email, name, picture, googleSub, emailVerified, createdAt, lastLoginAt] = this.params;
            users.set(id as string, {
              id, email, name, picture, google_sub: googleSub, email_verified: emailVerified,
              created_at: createdAt, last_login_at: lastLoginAt,
            });
          }
          return {};
        },
        async all() { return { results: [] }; },
      }),
    },
  } as unknown as Env;
}

describe('OAuth host-only state cookie', () => {
  it('canonicalizes non-apex starts before issuing state and completing OAuth', async () => {
    const app = buildAuthRouter();
    const env = fakeEnv();
    const start = await app.request('https://www.congress.trade/google/start', {}, env);

    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toBe('https://congress.trade/google/start');

    const canonicalStart = await app.request('https://congress.trade/google/start', {}, env);
    expect(canonicalStart.status).toBe(302);
    expect(vi.mocked(buildGoogleAuthUrl)).toHaveBeenLastCalledWith(
      env,
      'https://congress.trade/auth/google/callback',
      expect.any(String),
    );
    const state = (canonicalStart.headers.get('set-cookie') ?? '').match(/ct_oauth_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();

    const callback = await app.request(
      `https://congress.trade/google/callback?code=code&state=${state}`,
      { headers: { Cookie: `ct_oauth_state=${state}; ct_auth_origin=https://congress.trade` } },
      env,
    );
    expect(callback.headers.get('location')).toBe('https://congress.trade/?login=ok');
    expect(vi.mocked(exchangeGoogleCode)).toHaveBeenLastCalledWith(
      env,
      'code',
      'https://congress.trade/auth/google/callback',
    );
  });
});
