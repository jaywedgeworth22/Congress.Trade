import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes';
import type { Env } from '../../shared/types';
import type { SubscriptionRow } from '../../delivery/rows';

function makeEnv(seed: SubscriptionRow[]) {
  const prepare = (sql: string) => ({
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      if (/FROM subscriptions/i.test(sql)) return { results: seed as T[] };
      return { results: [] as T[] };
    },
    bind() {
      return this;
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });

  return {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    ADMIN_OPEN_IN_DEV: 'true',
  } as unknown as Env;
}

describe('admin subscription routes', () => {
  it('redacts subscription secrets from the admin list', async () => {
    const app = buildAdminRouter();
    const env = makeEnv([
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
});
