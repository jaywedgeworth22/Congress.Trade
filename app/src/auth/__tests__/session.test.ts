import { describe, it, expect } from 'vitest';
import { createSession, resolveSession, destroySession } from '../session';
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
});
