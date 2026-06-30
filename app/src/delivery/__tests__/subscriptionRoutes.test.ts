import { describe, it, expect } from 'vitest';
import { buildRestRouter } from '../rest';
import type { Env } from '../../shared/types';
import type { SubscriptionRow } from '../rows';

function makeEnv(seed: SubscriptionRow[] = [], overrides: Partial<Env> = {}) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));

  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/FROM subscriptions WHERE id = \?/i.test(sql)) {
        return (rows.get(String(this.params[0])) ?? null) as T | null;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/FROM subscriptions/i.test(sql)) {
        return { results: Array.from(rows.values()) as T[] };
      }
      return { results: [] as T[] };
    },
    async run() {
      if (/INSERT INTO subscriptions/i.test(sql)) {
        const [
          id,
          clientId,
          delivery,
          targetUrl,
          secret,
          filters,
          cursor,
          active,
          createdAt,
        ] = this.params;
        rows.set(String(id), {
          id: String(id),
          client_id: String(clientId),
          delivery: String(delivery),
          target_url: targetUrl == null ? null : String(targetUrl),
          secret: secret == null ? null : String(secret),
          filters: String(filters ?? '{}'),
          cursor: Number(cursor ?? 0),
          active: Number(active ?? 0),
          created_at: String(createdAt),
        });
      } else if (/UPDATE subscriptions SET active = \? WHERE id = \?/i.test(sql)) {
        const row = rows.get(String(this.params[1]));
        if (row) row.active = this.params[0] ? 1 : 0;
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
      ...overrides,
    } as unknown as Env,
    rows,
  };
}

async function createSubscription(
  env: Env,
  body: Record<string, unknown> = { clientId: 'client_1', delivery: 'sse', filters: {} },
) {
  const app = buildRestRouter();
  return app.request(
    'http://localhost/subscriptions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('subscription routes', () => {
  it('returns a generated secret once when creating an SSE subscription', async () => {
    const { env } = makeEnv();
    const res = await createSubscription(env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      hasSecret: boolean;
      secret?: string;
      streamUrl?: string;
    };
    expect(body.id).toMatch(/^sub_/);
    expect(body.hasSecret).toBe(true);
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.streamUrl).toContain(`subscription=${encodeURIComponent(body.id)}`);
    expect(body.streamUrl).toContain(`token=${encodeURIComponent(body.secret ?? '')}`);
  });

  it('does not publicly list subscriptions', async () => {
    const { env } = makeEnv();
    const app = buildRestRouter();
    const res = await app.request('http://localhost/subscriptions', {}, env);
    expect(res.status).toBe(401);
  });

  it('requires the subscription secret to read and redacts the secret in the response', async () => {
    const { env } = makeEnv();
    const created = (await (await createSubscription(env)).json()) as { id: string; secret: string };
    const app = buildRestRouter();

    const noAuth = await app.request(`http://localhost/subscriptions/${created.id}`, {}, env);
    expect(noAuth.status).toBe(401);

    const authed = await app.request(
      `http://localhost/subscriptions/${created.id}`,
      { headers: { authorization: `Bearer ${created.secret}` } },
      env,
    );
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { hasSecret: boolean; secret?: string };
    expect(body.hasSecret).toBe(true);
    expect(body.secret).toBeUndefined();
  });

  it('requires a token for SSE streams and rejects non-SSE subscriptions', async () => {
    const { env } = makeEnv();
    const sse = (await (await createSubscription(env)).json()) as { id: string; secret: string };
    const webhook = (await (
      await createSubscription(env, {
        clientId: 'client_2',
        delivery: 'webhook',
        targetUrl: 'https://example.com/hook',
        filters: {},
      })
    ).json()) as { id: string; secret: string };
    const app = buildRestRouter();

    const missingToken = await app.request(
      `http://localhost/stream?subscription=${encodeURIComponent(sse.id)}`,
      {},
      env,
    );
    expect(missingToken.status).toBe(401);

    const wrongChannel = await app.request(
      `http://localhost/stream?subscription=${encodeURIComponent(webhook.id)}&token=${encodeURIComponent(webhook.secret)}`,
      {},
      env,
    );
    expect(wrongChannel.status).toBe(409);
  });

  it('rejects non-HTTPS webhook target URLs outside localhost development', async () => {
    const { env } = makeEnv();
    const res = await createSubscription(env, {
      clientId: 'client_3',
      delivery: 'webhook',
      targetUrl: 'http://example.com/hook',
      filters: {},
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('https://');
  });

  it('allows localhost webhook target URLs only for local development requests', async () => {
    const { env } = makeEnv();
    const res = await createSubscription(env, {
      clientId: 'client_local',
      delivery: 'webhook',
      targetUrl: 'http://localhost:8788/hook',
      filters: {},
    });
    expect(res.status).toBe(201);
  });

  it.each([
    'http://localhost:8788/hook',
    'https://127.0.0.1/hook',
    'https://192.168.1.10/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[fe80::1]/hook',
  ])('rejects unsafe production webhook target URL %s', async (targetUrl) => {
    const { env } = makeEnv([], { APP_BASE_URL: 'https://congress.trade' });
    const res = await createSubscription(env, {
      clientId: 'client_prod',
      delivery: 'webhook',
      targetUrl,
      filters: {},
    });
    expect(res.status).toBe(400);
  });
});
