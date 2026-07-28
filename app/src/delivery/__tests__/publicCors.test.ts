/**
 * src/delivery/__tests__/publicCors.test.ts
 *
 * Explicit CORS policy: public, read-only GET responses carry
 * Access-Control-Allow-Origin: * (plus Vary: Origin); auth'd, mutation, and
 * disabled routes must never carry it.
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

describe('CORS on public read-only GETs', () => {
  const app = buildRestRouter();

  it('allows cross-origin reads on the public feed, members, market, and filings', async () => {
    for (const path of [
      '/transactions',
      '/members',
      '/market/spx',
      '/market/refs?tickers=AAPL',
      '/filings/H-2026-1',
      '/api/transactions', // production mount point form
    ]) {
      const res = await app.request(`http://localhost${path}`, {}, makeEnv());
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Vary')).toContain('Origin');
    }
  });

  it('never stamps CORS on auth’d, mutation, or disabled routes', async () => {
    const listing = await app.request('http://localhost/subscriptions', {}, makeEnv());
    expect(listing.status).toBe(403);
    expect(listing.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const stream = await app.request('http://localhost/stream', {}, makeEnv());
    expect(stream.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const create = await app.request(
      'http://localhost/subscriptions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      makeEnv(),
    );
    expect(create.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
