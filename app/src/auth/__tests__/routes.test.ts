import { describe, it, expect } from 'vitest';
import { buildAuthRouter } from '../routes';
import type { Env } from '../../shared/types';

function fakeEnv(over: Record<string, unknown> = {}): Env {
  const kv = new Map<string, string>();
  return {
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          return {};
        },
        async all() {
          return { results: [] };
        },
      }),
    },
    ...over,
  } as unknown as Env;
}

describe('auth router', () => {
  it('GET /me returns null when not signed in', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/me', {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it('GET /google/start is 503 when Google is not configured', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/google/start', {}, fakeEnv());
    expect(res.status).toBe(503);
  });

  it('GET /google/start redirects to Google when configured', async () => {
    const app = buildAuthRouter();
    const res = await app.request(
      'http://localhost/google/start',
      {},
      fakeEnv({ GOOGLE_OAUTH_CLIENT_ID: 'cid' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('accounts.google.com');
  });

  it('POST /magic/request rejects an invalid email', async () => {
    const app = buildAuthRouter();
    const res = await app.request(
      'http://localhost/magic/request',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'nope' }),
        headers: { 'content-type': 'application/json' },
      },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('POST /logout succeeds even without a session', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/logout', { method: 'POST' }, fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
