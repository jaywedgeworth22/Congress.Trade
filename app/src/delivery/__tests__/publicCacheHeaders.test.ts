/**
 * src/delivery/__tests__/publicCacheHeaders.test.ts
 *
 * Public, read-only GETs must carry an edge-cache policy (short s-maxage +
 * stale-while-revalidate) so shared caches can absorb repeat traffic. Auth'd,
 * mutation, and admin-style routes must NOT get one.
 */
import { describe, it, expect } from 'vitest';
import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

function makeEnv(): Env {
  const prepare = (sql: string) => ({
    bind() {
      return this;
    },
    async first<T>() {
      if (/COUNT/i.test(sql)) return { total: 0 } as T;
      return null as T | null;
    },
    async all<T>() {
      return { results: [] as T[], meta: {} };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });
  return { DB: { prepare } as unknown as D1Database } as unknown as Env;
}

describe('Cache-Control on public read GETs', () => {
  const app = buildRestRouter();

  it('marks the live feed with a short shared-cache window', async () => {
    const res = await app.request('http://localhost/transactions', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=15');
    expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate');
  });

  it('marks the members roster and market reads with the stable-cache window', async () => {
    for (const path of ['/members', '/market/spx', '/market/refs?tickers=AAPL']) {
      const res = await app.request(`http://localhost${path}`, {}, makeEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('s-maxage=300');
      expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate');
    }
  });

  it('does not mark the disabled subscription listing (not a public read)', async () => {
    const res = await app.request('http://localhost/subscriptions', {}, makeEnv());
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});
