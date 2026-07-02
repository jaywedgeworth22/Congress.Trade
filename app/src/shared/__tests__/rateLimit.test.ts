import { describe, it, expect } from 'vitest';
import { rateLimit, clientIp } from '../rateLimit';
import type { Env } from '../types';

function fakeEnv(): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  };
  return { CONFIG_KV: kv } as unknown as Env;
}

describe('rateLimit', () => {
  it('allows up to the limit then blocks within the window', async () => {
    const env = fakeEnv();
    let last = await rateLimit(env, 'b', 'id', 3, 60);
    for (let i = 0; i < 2; i++) last = await rateLimit(env, 'b', 'id', 3, 60);
    expect(last.ok).toBe(true);
    const blocked = await rateLimit(env, 'b', 'id', 3, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('tracks identifiers independently', async () => {
    const env = fakeEnv();
    await rateLimit(env, 'b', 'a', 1, 60);
    expect((await rateLimit(env, 'b', 'z', 1, 60)).ok).toBe(true);
  });

  it('fails open when KV is unavailable', async () => {
    expect((await rateLimit({} as Env, 'b', 'id', 1, 60)).ok).toBe(true);
  });
});

describe('clientIp', () => {
  it('prefers cf-connecting-ip', () => {
    const req = new Request('https://x', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('falls back to "unknown" with no proxy headers', () => {
    expect(clientIp(new Request('https://x'))).toBe('unknown');
  });
});
