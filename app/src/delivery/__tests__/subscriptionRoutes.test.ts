import { describe, it, expect } from 'vitest';
import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';
import type { SubscriptionRow } from '../rows.ts';

function makeEnv(
  seed: SubscriptionRow[] = [],
  overrides: Partial<Env> = {},
  opts: { quotaRace?: boolean; userPlans?: Record<string, 'premium' | 'free'> } = {},
) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));

  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/SELECT \* FROM users WHERE id = \?/i.test(sql)) {
        // Default (no userPlans map) keeps every id premium so existing tests
        // are unaffected; the owner-gate tests key plans by user id.
        const id = String(this.params[0] ?? 'user_1');
        const isFree = opts.userPlans?.[id] === 'free';
        return ({
          id, email: `${id}@example.com`, name: 'User', picture: null,
          google_sub: null, email_verified: 1, created_at: '2026-01-01T00:00:00.000Z',
          last_login_at: null,
          subscription_status: isFree ? 'canceled' : 'active',
          plan: isFree ? null : 'monthly',
        } as T);
      }
      if (/COUNT\(\*\) AS total/i.test(sql)) {
        const clientId = String(this.params[0]);
        const owned = Array.from(rows.values()).filter((row) => row.client_id === clientId);
        return ({ total: owned.length, active: owned.filter((row) => row.active === 1).length } as T);
      }
      if (/FROM subscriptions WHERE id = \?/i.test(sql)) {
        return (rows.get(String(this.params[0])) ?? null) as T | null;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/COUNT\(\*\) AS total/i.test(sql)) {
        const clientId = String(this.params[0]);
        const owned = Array.from(rows.values()).filter((row) => row.client_id === clientId);
        return { results: [{ total: owned.length, active: owned.filter((row) => row.active === 1).length } as T] };
      }
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
        if (opts.quotaRace) throw new Error('D1_ERROR: subscription active quota exceeded');
        const row = rows.get(String(this.params[1]));
        if (row) row.active = this.params[0] ? 1 : 0;
      }
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      CONFIG_KV: {
        get: async (key: string) => {
          if (key === 'sess:user-token') return JSON.stringify({ userId: 'user_1' });
          if (key === 'sess:premium-token') return JSON.stringify({ userId: 'user_9' });
          return null;
        },
        put: async () => {}, delete: async () => {},
      },
      ...overrides,
    } as unknown as Env,
    rows,
  };
}

async function createSubscription(
  env: Env,
  body: Record<string, unknown> = { clientId: 'client_1', delivery: 'sse', filters: {} },
  requestUrl = 'http://localhost/subscriptions',
) {
  const app = buildRestRouter();
  return app.request(
    requestUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer user-token' },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('subscription routes', () => {
  it('rejects oversized secrets and webhook targets before persistence or DNS', async () => {
    const { env } = makeEnv();
    const secret = await createSubscription(env, {
      delivery: 'sse', filters: {}, secret: 's'.repeat(257),
    });
    expect(secret.status).toBe(400);

    const target = await createSubscription(env, {
      delivery: 'webhook', filters: {}, targetUrl: `https://example.com/${'x'.repeat(2049)}`,
    });
    expect(target.status).toBe(400);
  });

  it('requires authentication for every durable subscription', async () => {
    const { env } = makeEnv();
    const app = buildRestRouter();
    const res = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delivery: 'sse', filters: {} }),
    }, env);
    expect(res.status).toBe(401);
  });

  it('enforces a durable per-user total subscription quota', async () => {
    const seed: SubscriptionRow[] = Array.from({ length: 20 }, (_, i) => ({
      id: `sub_${i}`, client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: `secret_${i}`, filters: '{}', cursor: 0, active: i < 10 ? 1 : 0,
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    const { env } = makeEnv(seed);
    const res = await createSubscription(env);
    expect(res.status).toBe(409);
  });

  it('returns 409 when the active-quota trigger wins an update race', async () => {
    const seed: SubscriptionRow = {
      id: 'sub_inactive', client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: 'whsec_inactive_subscription', filters: '{}', cursor: 0, active: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const { env } = makeEnv([seed], {}, { quotaRace: true });
    const app = buildRestRouter();
    const res = await app.request('http://localhost/subscriptions/sub_inactive', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-subscription-secret': seed.secret ?? '' },
      body: JSON.stringify({ active: true }),
    }, env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('active subscription limit');
  });

  it('gates continuing delivery on the OWNER entitlement, not the request session (secret-only, free owner → 402)', async () => {
    const seed: SubscriptionRow = {
      id: 'sub_free_owner', client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: 'whsec_free_owner_secret', filters: '{}', cursor: 0, active: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const { env } = makeEnv([seed], {}, { userPlans: { user_1: 'free' } });
    const res = await buildRestRouter().request('http://localhost/subscriptions/sub_free_owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-subscription-secret': seed.secret ?? '' },
      body: JSON.stringify({ active: true }),
    }, env);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { feature?: string }).feature).toBe('alerts');
  });

  it('ignores a premium NON-owner session when gating a free owner subscription (→ 402)', async () => {
    const seed: SubscriptionRow = {
      id: 'sub_free_owner2', client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: 'whsec_free_owner_secret2', filters: '{}', cursor: 0, active: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const { env } = makeEnv([seed], {}, { userPlans: { user_1: 'free', user_9: 'premium' } });
    const res = await buildRestRouter().request('http://localhost/subscriptions/sub_free_owner2', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-subscription-secret': seed.secret ?? '',
        cookie: 'ct_session=premium-token',
      },
      body: JSON.stringify({ active: true }),
    }, env);
    expect(res.status).toBe(402);
  });

  it('allows a premium owner to continue delivery (secret-only, premium owner)', async () => {
    const seed: SubscriptionRow = {
      id: 'sub_prem_owner', client_id: 'user:user_1', delivery: 'sse', target_url: null,
      secret: 'whsec_prem_owner_secret', filters: '{}', cursor: 0, active: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const { env } = makeEnv([seed]); // default: owner is premium
    const res = await buildRestRouter().request('http://localhost/subscriptions/sub_prem_owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-subscription-secret': seed.secret ?? '' },
      body: JSON.stringify({ active: true }),
    }, env);
    expect(res.status).toBe(200);
  });

  it('does not gate admin/integration-owned subscriptions (non-user clientId)', async () => {
    const seed: SubscriptionRow = {
      id: 'sub_integration', client_id: 'integration:socratic', delivery: 'webhook',
      target_url: 'https://example.com/hook', secret: 'whsec_integration_secret', filters: '{}',
      cursor: 0, active: 0, created_at: '2026-01-01T00:00:00.000Z',
    };
    const { env } = makeEnv([seed]);
    const res = await buildRestRouter().request('http://localhost/subscriptions/sub_integration', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-subscription-secret': seed.secret ?? '' },
      body: JSON.stringify({ active: true }),
    }, env);
    expect(res.status).toBe(200);
  });

  it('rejects an oversized target on update', async () => {
    const seed: SubscriptionRow = {
      id: 'sub_webhook', client_id: 'user:user_1', delivery: 'webhook',
      target_url: 'https://example.com/hook', secret: 'whsec_update_secret', filters: '{}',
      cursor: 0, active: 1, created_at: '2026-01-01T00:00:00.000Z',
    };
    const { env } = makeEnv([seed]);
    const response = await buildRestRouter().request('http://localhost/subscriptions/sub_webhook', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-subscription-secret': seed.secret ?? '' },
      body: JSON.stringify({ targetUrl: `https://example.com/${'x'.repeat(2049)}` }),
    }, env);
    expect(response.status).toBe(400);
  });
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

  it('does not publicly list subscriptions (403: forbidden for everyone, not an auth challenge)', async () => {
    const { env } = makeEnv();
    const app = buildRestRouter();
    const res = await app.request('http://localhost/subscriptions', {}, env);
    expect(res.status).toBe(403);
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
    const { env, rows } = makeEnv();
    const sse = (await (await createSubscription(env)).json()) as { id: string; secret: string };
    const webhook = {
      id: 'sub_webhook', secret: 'whsec_webhook_test_secret',
    };
    rows.set(webhook.id, {
      id: webhook.id, client_id: 'user:u1', delivery: 'webhook', target_url: 'https://example.com/hook',
      secret: webhook.secret, filters: '{}', cursor: 0, active: 1, created_at: new Date().toISOString(),
    });
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

  it('accepts the stream token via Authorization: Bearer (keeps it out of the URL)', async () => {
    const { env } = makeEnv();
    const sse = (await (await createSubscription(env)).json()) as { id: string; secret: string };
    const app = buildRestRouter();
    const url = `http://localhost/stream?subscription=${encodeURIComponent(sse.id)}`;

    // A request whose token passes auth opens the stream (200); a missing or
    // wrong token is rejected (401). 200-via-header proves the header transport.
    const bearer = await app.request(
      url,
      { headers: { authorization: `Bearer ${sse.secret}` } },
      env,
    );
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get('content-type')).toContain('text/event-stream');
    await bearer.body?.cancel();

    const headerSecret = await app.request(
      url,
      { headers: { 'x-subscription-secret': sse.secret } },
      env,
    );
    expect(headerSecret.status).toBe(200);
    await headerSecret.body?.cancel();

    const noToken = await app.request(url, {}, env);
    expect(noToken.status).toBe(401);
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

  it('allows an authenticated localhost webhook target only in local development', async () => {
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
    'https://93.184.216.34/hook',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/hook',
  ])('rejects unsafe production webhook target URL %s', async (targetUrl) => {
    const { env } = makeEnv([], { APP_BASE_URL: 'https://congress.trade' });
    const res = await createSubscription(
      env,
      { clientId: 'client_prod', delivery: 'webhook', targetUrl, filters: {} },
      'https://congress.trade/subscriptions',
    );
    expect(res.status).toBe(400);
  });
});
