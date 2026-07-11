import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes';
import type { Env } from '../../shared/types';
import type { SubscriptionRow } from '../../delivery/rows';

function makeEnv(seed: SubscriptionRow[]) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    async first<T>() {
      if (/COUNT\(\*\) AS total/i.test(sql)) {
        const owned = Array.from(rows.values()).filter((row) => row.client_id === this.params[0]);
        return { total: owned.length, active: owned.filter((row) => row.active === 1).length } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/FROM subscriptions/i.test(sql)) return { results: Array.from(rows.values()) as T[] };
      return { results: [] as T[] };
    },
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async run() {
      if (/INSERT INTO subscriptions/i.test(sql)) {
        const [id, clientId, delivery, targetUrl, secret, filters, cursor, active, createdAt] = this.params;
        rows.set(String(id), {
          id: String(id), client_id: String(clientId), delivery: String(delivery),
          target_url: targetUrl == null ? null : String(targetUrl),
          secret: secret == null ? null : String(secret), filters: String(filters),
          cursor: Number(cursor), active: active ? 1 : 0, created_at: String(createdAt),
        });
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
      ADMIN_OPEN_IN_DEV: 'true',
    } as unknown as Env,
    rows,
  };
}

describe('admin subscription routes', () => {
  it('redacts subscription secrets from the admin list', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([
      {
        id: 'sub_1',
        client_id: 'client_1',
        delivery: 'sse',
        target_url: null,
        secret: 'whsec_super_secret',
        filters: '{}',
        cursor: 0,
        active: 1,
        created_at: '2026-06-30T00:00:00.000Z',
      },
    ]);

    const res = await app.request('http://localhost/subscriptions', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ hasSecret: boolean; secret?: string }>;
    };
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].hasSecret).toBe(true);
    expect(body.subscriptions[0].secret).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('whsec_super_secret');
  });

  it('provisions an explicit operator client id and returns the generated secret once', async () => {
    const app = buildAdminRouter();
    const { env, rows } = makeEnv([]);
    const res = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'integration:socratic-trade', delivery: 'sse', filters: { tickers: ['aapl'] } }),
    }, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; clientId: string; secret: string; streamUrl: string };
    expect(body).toMatchObject({ clientId: 'integration:socratic-trade' });
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.streamUrl).toContain(`/api/stream?subscription=${encodeURIComponent(body.id)}`);
    expect(rows.get(body.id)).toMatchObject({
      client_id: 'integration:socratic-trade', filters: JSON.stringify({ tickers: ['AAPL'] }),
    });
  });

  it('rejects an unbounded operator client id', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([]);
    const res = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'x'.repeat(129), delivery: 'sse', filters: {} }),
    }, env);
    expect(res.status).toBe(400);
  });

  it('rejects oversized operator secrets and target URLs', async () => {
    const app = buildAdminRouter();
    const { env } = makeEnv([]);
    const secret = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'integration:test', delivery: 'sse', filters: {}, secret: 's'.repeat(257) }),
    }, env);
    expect(secret.status).toBe(400);
    const target = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'integration:test', delivery: 'webhook', filters: {}, targetUrl: `https://example.com/${'x'.repeat(2049)}` }),
    }, env);
    expect(target.status).toBe(400);
  });
});
