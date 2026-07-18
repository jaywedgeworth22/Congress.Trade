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
  return {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    APP_BASE_URL: 'https://congress.trade',
    CONFIG_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
      delete: async (key: string) => { kv.delete(key); },
    },
    DB: {
      prepare: () => ({
        bind() { return this; },
        async first() { return null; },
        async run() { return {}; },
        async all() { return { results: [] }; },
      }),
    },
  } as unknown as Env;
}

describe('OAuth host-only state cookie', () => {
  it('uses the initiating non-apex host for both OAuth callbacks', async () => {
    const app = buildAuthRouter();
    const env = fakeEnv();
    const start = await app.request('https://www.congress.trade/google/start', {}, env);

    expect(start.status).toBe(302);
    expect(vi.mocked(buildGoogleAuthUrl)).toHaveBeenLastCalledWith(
      env,
      'https://www.congress.trade/auth/google/callback',
      expect.any(String),
    );
    const state = (start.headers.get('set-cookie') ?? '').match(/ct_oauth_state=([^;]+)/)?.[1];
    expect(state).toBeTruthy();

    await app.request(
      `https://www.congress.trade/google/callback?code=code&state=${state}`,
      { headers: { Cookie: `ct_oauth_state=${state}` } },
      env,
    );
    expect(vi.mocked(exchangeGoogleCode)).toHaveBeenLastCalledWith(
      env,
      'code',
      'https://www.congress.trade/auth/google/callback',
    );
  });
});
