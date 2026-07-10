import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createSession, resolveSession, destroySession, getCurrentUserFromRequest, getCookieDomain, getSafeRedirectUrl } from '../session';
import type { Env } from '../../shared/types';

function fakeEnv(user?: { id: string }) {
  const kv = new Map<string, string>();
  const prepare = (sql: string) => ({
    _p: [] as unknown[],
    bind(...p: unknown[]) {
      this._p = p;
      return this;
    },
    async first<T>() {
      if (/FROM users WHERE id/i.test(sql) && user && this._p[0] === user.id) {
        return {
          id: user.id,
          email: 'u@e.com',
          name: null,
          picture: null,
          google_sub: null,
          email_verified: 1,
          created_at: 'now',
          last_login_at: null,
        } as unknown as T;
      }
      return null as T | null;
    },
    async run() {
      return { success: true } as unknown;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
  } as unknown as Env;
  return { env, kv };
}

describe('sessions', () => {
  it('create -> resolve returns the fresh user', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const token = await createSession(env, 'user-1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const u = await resolveSession(env, token);
    expect(u?.id).toBe('user-1');
    expect(u?.email).toBe('u@e.com');
    expect(u?.emailVerified).toBe(true);
  });

  it('resolve returns null for missing / unknown tokens', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    expect(await resolveSession(env, undefined)).toBeNull();
    expect(await resolveSession(env, 'nope')).toBeNull();
  });

  it('destroy removes the session', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const token = await createSession(env, 'user-1');
    await destroySession(env, token);
    expect(await resolveSession(env, token)).toBeNull();
  });

  it('resolves bearer sessions for native clients', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const token = await createSession(env, 'user-1');
    const app = new Hono<{ Bindings: Env }>();
    app.get('/me', async (c) => c.json({ user: await getCurrentUserFromRequest(c) }));

    const res = await app.request('http://localhost/me', { headers: { authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe('user-1');
  });

  it('getCookieDomain resolves domain from APP_BASE_URL correctly', async () => {
    const { env: envProd } = fakeEnv();
    (envProd as any).APP_BASE_URL = 'https://congress.trade';
    const cProd = { env: envProd } as any;
    expect(await getCookieDomain(cProd)).toBe('congress.trade');

    const { env: envLocal } = fakeEnv();
    (envLocal as any).APP_BASE_URL = 'http://localhost:8787';
    const cLocal = { env: envLocal } as any;
    expect(await getCookieDomain(cLocal)).toBeUndefined();
  });

  it('getSafeRedirectUrl validates and sanitizes origins correctly', () => {
    const base = 'https://congress.trade';
    const domain = 'congress.trade';

    // Allowed domains
    expect(getSafeRedirectUrl('https://congress.trade/path', base, domain)).toBe('https://congress.trade/path');
    expect(getSafeRedirectUrl('https://admin.congress.trade/path', base, domain)).toBe('https://admin.congress.trade/path');
    expect(getSafeRedirectUrl('http://localhost:8787/path', base, domain)).toBe('http://localhost:8787/path');

    // Mismatched domains fallback to defaultBase
    expect(getSafeRedirectUrl('https://malicious.com/path', base, domain)).toBe(base);
    expect(getSafeRedirectUrl(undefined, base, domain)).toBe(base);
  });
});
