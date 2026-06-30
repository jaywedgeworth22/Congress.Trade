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

interface FakeCounters {
  customerLinks: number;
  subscriptionApplies: number;
  subscriptionEnds: number;
  webhookEventClaims: number;
  webhookEventProcessed: number;
  webhookEventReleased: number;
}

function fakeEnv(
  over: Record<string, unknown> = {},
  seed: URow[] = [],
): { env: Env; rows: Map<string, URow>; counters: FakeCounters } {
  const rows = new Map<string, URow>(seed.map((r) => [r.id, r]));
  const webhookEvents = new Map<string, { eventType: string; receivedAt: string; processedAt: string | null }>();
  const counters: FakeCounters = {
    customerLinks: 0,
    subscriptionApplies: 0,
    subscriptionEnds: 0,
    webhookEventClaims: 0,
    webhookEventProcessed: 0,
    webhookEventReleased: 0,
  };
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
          if (/INSERT OR IGNORE INTO stripe_webhook_events/i.test(sql)) {
            const [eventId, eventType, receivedAt] = p as [string, string, string];
            if (webhookEvents.has(eventId)) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            webhookEvents.set(eventId, { eventType, receivedAt, processedAt: null });
            counters.webhookEventClaims += 1;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (/UPDATE stripe_webhook_events\s+SET processed_at/i.test(sql)) {
            const [processedAt, eventId] = p as [string, string];
            const event = webhookEvents.get(eventId);
            if (event) {
              event.processedAt = processedAt;
              counters.webhookEventProcessed += 1;
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          if (/DELETE FROM stripe_webhook_events/i.test(sql)) {
            const [eventId] = p as [string];
            const event = webhookEvents.get(eventId);
            const changes = event && !event.processedAt ? 1 : 0;
            if (changes) {
              webhookEvents.delete(eventId);
              counters.webhookEventReleased += 1;
            }
            return { success: true, meta: { changes } } as unknown as D1Result;
          }
          if (/SET\s+stripe_customer_id = \?,\s+stripe_subscription_id/i.test(sql)) {
            const [cust, sub, status, plan, cpe, cape, trial, id] = p as [
              string, string, string, string | null, string | null, number, string | null, string,
            ];
            const r = rows.get(id);
            if (r) Object.assign(r, {
              stripe_customer_id: cust, stripe_subscription_id: sub, subscription_status: status,
              plan, current_period_end: cpe, cancel_at_period_end: cape, trial_end: trial,
            });
            counters.subscriptionApplies += 1;
          } else if (/UPDATE users SET stripe_customer_id = \? WHERE id/i.test(sql)) {
            const [customerId, userId] = p as [string, string];
            const r = rows.get(userId);
            if (r) r.stripe_customer_id = customerId;
            counters.customerLinks += 1;
          } else if (/subscription_status = 'canceled'/i.test(sql)) {
            const [id] = p as [string];
            const r = rows.get(id);
            if (r) {
              r.subscription_status = 'canceled';
              r.cancel_at_period_end = 0;
              r.trial_end = null;
            }
            counters.subscriptionEnds += 1;
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      }),
    },
    ...over,
  } as unknown as Env;
  return { env, rows, counters };
}

async function postWebhook(
  app: ReturnType<typeof buildBillingRouter>,
  env: Env,
  event: Record<string, unknown>,
): Promise<Response> {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const header = `t=${ts},v1=${await sign('whsec', ts, body)}`;
  return app.request(
    'http://localhost/webhook',
    { method: 'POST', body, headers: { 'stripe-signature': header, 'content-type': 'application/json' } },
    env,
  );
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
    const event = {
      id: 'evt_sub_update_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
          current_period_end: 1_900_000_000, cancel_at_period_end: false, trial_end: null,
        },
      },
    };
    const app = buildBillingRouter();
    const res = await postWebhook(app, env, event);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(rows.get('u1')!.subscription_status).toBe('active');
    expect(rows.get('u1')!.plan).toBe('monthly');
  });

  it('POST /webhook ignores duplicate checkout.session.completed events', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: null, subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows, counters } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const event = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'u1', customer: 'cus_1' } },
    };
    const app = buildBillingRouter();

    const first = await postWebhook(app, env, event);
    const second = await postWebhook(app, env, event);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(rows.get('u1')!.stripe_customer_id).toBe('cus_1');
    expect(counters.customerLinks).toBe(1);
    expect(counters.webhookEventClaims).toBe(1);
  });

  it('POST /webhook ignores duplicate subscription update events', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows, counters } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const event = {
      id: 'evt_sub_update_duplicate',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
        },
      },
    };
    const app = buildBillingRouter();

    const first = await postWebhook(app, env, event);
    const second = await postWebhook(app, env, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(rows.get('u1')!.subscription_status).toBe('active');
    expect(counters.subscriptionApplies).toBe(1);
    expect(counters.webhookEventProcessed).toBe(1);
  });

  it('POST /webhook ignores duplicate subscription deleted events', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'active', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 1, trial_end: 'later',
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows, counters } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const event = {
      id: 'evt_sub_deleted_1',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_1' } },
    };
    const app = buildBillingRouter();

    const first = await postWebhook(app, env, event);
    const second = await postWebhook(app, env, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(rows.get('u1')!.subscription_status).toBe('canceled');
    expect(counters.subscriptionEnds).toBe(1);
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
            if (/INSERT OR IGNORE INTO stripe_webhook_events/i.test(sql)) {
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            if (/DELETE FROM stripe_webhook_events/i.test(sql)) {
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            throw new Error('d1 unavailable');
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const event = {
      id: 'evt_sub_update_fails',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
        },
      },
    };
    const app = buildBillingRouter();
    const res = await postWebhook(app, env, event);
    expect(res.status).toBe(500);
  });
});
