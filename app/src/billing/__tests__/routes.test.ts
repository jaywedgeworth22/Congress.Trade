import { describe, it, expect } from 'vitest';
import { buildBillingRouter } from '../routes';
import { ANONYMOUS_ENTITLEMENT } from '../entitlement';
import type { Env } from '../../shared/types';

async function sign(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface URow {
  id: string;
  stripe_customer_id: string | null;
  subscription_status: string | null;
  plan: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  trial_end: string | null;
  email: string;
  name: null;
  picture: null;
  google_sub: null;
  email_verified: number;
  created_at: string;
  last_login_at: null;
}

function fakeEnv(over: Record<string, unknown> = {}, seed: URow[] = []): { env: Env; rows: Map<string, URow> } {
  const rows = new Map<string, URow>(seed.map((r) => [r.id, r]));
  const env = {
    CONFIG_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    STRIPE_PRICE_MONTHLY: 'price_m',
    STRIPE_PRICE_ANNUAL: 'price_a',
    DB: {
      prepare: (sql: string) => ({
        _p: [] as unknown[],
        bind(...p: unknown[]) {
          this._p = p;
          return this;
        },
        async first<T>() {
          if (/SELECT id FROM users WHERE stripe_customer_id/i.test(sql)) {
            const r = [...rows.values()].find((x) => x.stripe_customer_id === this._p[0]);
            return (r ? { id: r.id } : null) as T | null;
          }
          if (/SELECT \* FROM users WHERE id/i.test(sql)) {
            return ((rows.get(this._p[0] as string) ?? null) as unknown) as T | null;
          }
          return null as T | null;
        },
        async run() {
          const p = this._p;
          if (/SET\s+stripe_customer_id = \?,\s+stripe_subscription_id/i.test(sql)) {
            const [cust, sub, status, plan, cpe, cape, trial, id] = p as [
              string, string, string, string | null, string | null, number, string | null, string,
            ];
            const r = rows.get(id);
            if (r) Object.assign(r, {
              stripe_customer_id: cust, stripe_subscription_id: sub, subscription_status: status,
              plan, current_period_end: cpe, cancel_at_period_end: cape, trial_end: trial,
            });
          }
          return { success: true } as unknown;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      }),
    },
    ...over,
  } as unknown as Env;
  return { env, rows };
}

describe('billing router', () => {
  it('GET /status reports unconfigured + anonymous entitlement when signed out', async () => {
    const app = buildBillingRouter();
    const res = await app.request('http://localhost/status', {}, fakeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, entitlement: ANONYMOUS_ENTITLEMENT });
  });

  it('POST /checkout requires sign-in (401 needLogin)', async () => {
    const app = buildBillingRouter();
    const res = await app.request(
      'http://localhost/checkout',
      { method: 'POST', body: JSON.stringify({ plan: 'monthly' }), headers: { 'content-type': 'application/json' } },
      fakeEnv({ STRIPE_SECRET_KEY: 'sk' }).env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { needLogin?: boolean }).needLogin).toBe(true);
  });

  it('POST /portal requires sign-in', async () => {
    const app = buildBillingRouter();
    const res = await app.request('http://localhost/portal', { method: 'POST' }, fakeEnv({ STRIPE_SECRET_KEY: 'sk' }).env);
    expect(res.status).toBe(401);
  });

  it('POST /webhook is 503 when the signing secret is not configured', async () => {
    const app = buildBillingRouter();
    const res = await app.request('http://localhost/webhook', { method: 'POST', body: '{}' }, fakeEnv().env);
    expect(res.status).toBe(503);
  });

  it('POST /webhook rejects an invalid signature with 400', async () => {
    const app = buildBillingRouter();
    const res = await app.request(
      'http://localhost/webhook',
      { method: 'POST', body: '{"type":"x"}', headers: { 'stripe-signature': 't=1,v1=bad' } },
      fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }).env,
    );
    expect(res.status).toBe(400);
  });

  it('POST /webhook applies a subscription update on a valid signature', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const body = JSON.stringify({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
          current_period_end: 1_900_000_000, cancel_at_period_end: false, trial_end: null,
        },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${await sign('whsec', ts, body)}`;
    const app = buildBillingRouter();
    const res = await app.request(
      'http://localhost/webhook',
      { method: 'POST', body, headers: { 'stripe-signature': header, 'content-type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(rows.get('u1')!.subscription_status).toBe('active');
    expect(rows.get('u1')!.plan).toBe('monthly');
  });

  it('POST /webhook returns 500 when verified subscription persistence fails', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const base = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const env = {
      ...base.env,
      DB: {
        prepare: (sql: string) => ({
          _p: [] as unknown[],
          bind(...p: unknown[]) {
            this._p = p;
            return this;
          },
          async first<T>() {
            if (/SELECT id FROM users WHERE stripe_customer_id/i.test(sql)) return { id: 'u1' } as T;
            if (/SELECT \* FROM users WHERE id/i.test(sql)) return seed as unknown as T;
            return null as T | null;
          },
          async run() {
            throw new Error('d1 unavailable');
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const body = JSON.stringify({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
        },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${await sign('whsec', ts, body)}`;
    const app = buildBillingRouter();
    const res = await app.request(
      'http://localhost/webhook',
      { method: 'POST', body, headers: { 'stripe-signature': header, 'content-type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(500);
  });
});
