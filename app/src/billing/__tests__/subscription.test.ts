import { describe, it, expect } from 'vitest';
import {
  planForPrice,
  parseSubscription,
  applySubscription,
  endSubscription,
  getUserByStripeCustomerId,
} from '../subscription';
import type { Env } from '../../shared/types';

interface Row {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  google_sub: string | null;
  email_verified: number;
  created_at: string;
  last_login_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  plan: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  trial_end: string | null;
}

function newRow(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    email: id + '@x.com',
    name: null,
    picture: null,
    google_sub: null,
    email_verified: 1,
    created_at: 'now',
    last_login_at: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: null,
    plan: null,
    current_period_end: null,
    cancel_at_period_end: 0,
    trial_end: null,
    ...over,
  };
}

/** In-memory `users` table supporting exactly the queries the module issues. */
function fakeEnv(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  const env = {
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
          if (/UPDATE users SET stripe_customer_id = \? WHERE id/i.test(sql)) {
            const r = rows.get(p[1] as string);
            if (r) r.stripe_customer_id = p[0] as string;
          } else if (/UPDATE\s+users\s+SET\s+stripe_customer_id = \?,\s+stripe_subscription_id/i.test(sql)) {
            const [cust, sub, status, plan, cpe, cape, trial, id] = p as [
              string, string, string, string | null, string | null, number, string | null, string,
            ];
            const r = rows.get(id);
            if (r) {
              r.stripe_customer_id = cust;
              r.stripe_subscription_id = sub;
              r.subscription_status = status;
              r.plan = plan;
              r.current_period_end = cpe;
              r.cancel_at_period_end = cape;
              r.trial_end = trial;
            }
          } else if (/subscription_status = 'canceled'/i.test(sql)) {
            const r = rows.get(p[0] as string);
            if (r) {
              r.subscription_status = 'canceled';
              r.cancel_at_period_end = 0;
              r.trial_end = null;
            }
          }
          return { success: true } as unknown;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      }),
    },
  } as unknown as Env;
  return { env, rows };
}

describe('planForPrice', () => {
  it('maps configured price ids to cadences, else null', () => {
    const { env } = fakeEnv();
    expect(planForPrice(env, 'price_m')).toBe('monthly');
    expect(planForPrice(env, 'price_a')).toBe('annual');
    expect(planForPrice(env, 'price_other')).toBeNull();
    expect(planForPrice(env, null)).toBeNull();
  });
});

describe('parseSubscription', () => {
  it('normalizes a raw Stripe subscription (unix -> ISO, nested price + customer)', () => {
    const parsed = parseSubscription({
      id: 'sub_1',
      status: 'trialing',
      customer: 'cus_1',
      current_period_end: 1_700_000_000,
      cancel_at_period_end: true,
      trial_end: 1_699_000_000,
      items: { data: [{ price: { id: 'price_a' } }] },
      metadata: { userId: 'u1' },
    });
    expect(parsed).toMatchObject({
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'trialing',
      priceId: 'price_a',
      cancelAtPeriodEnd: true,
      metadataUserId: 'u1',
    });
    expect(parsed!.currentPeriodEnd).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(parsed!.trialEnd).toBe(new Date(1_699_000_000 * 1000).toISOString());
  });

  it('accepts an expanded customer object and returns null when essentials are missing', () => {
    expect(parseSubscription({ id: 's', status: 'active', customer: { id: 'cus_2' } })?.customerId).toBe('cus_2');
    expect(parseSubscription({ status: 'active', customer: 'cus' })).toBeNull();
    expect(parseSubscription({ id: 's', customer: 'cus' })).toBeNull();
  });
});

describe('applySubscription', () => {
  it('updates the user resolved by stripe customer id', async () => {
    const { env, rows } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    const id = await applySubscription(env, {
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: '2030-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId: null,
    });
    expect(id).toBe('u1');
    const r = rows.get('u1')!;
    expect(r.subscription_status).toBe('active');
    expect(r.plan).toBe('monthly');
    expect(r.stripe_subscription_id).toBe('sub_1');
  });

  it('falls back to metadata userId and links the customer when no row matches', async () => {
    const { env, rows } = fakeEnv([newRow('u1')]); // no customer linked yet
    const id = await applySubscription(env, {
      id: 'sub_9',
      customerId: 'cus_new',
      status: 'trialing',
      priceId: 'price_a',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: '2030-02-01T00:00:00.000Z',
      metadataUserId: 'u1',
    });
    expect(id).toBe('u1');
    const r = rows.get('u1')!;
    expect(r.stripe_customer_id).toBe('cus_new');
    expect(r.subscription_status).toBe('trialing');
    expect(r.plan).toBe('annual');
  });

  it('returns null when the subscription cannot be tied to any user', async () => {
    const { env } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    const id = await applySubscription(env, {
      id: 'sub_x',
      customerId: 'cus_unknown',
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId: null,
    });
    expect(id).toBeNull();
  });
});

describe('endSubscription', () => {
  it('marks the subscription canceled for the matching customer', async () => {
    const { env, rows } = fakeEnv([
      newRow('u1', { stripe_customer_id: 'cus_1', subscription_status: 'active', cancel_at_period_end: 1 }),
    ]);
    const id = await endSubscription(env, 'cus_1');
    expect(id).toBe('u1');
    expect(rows.get('u1')!.subscription_status).toBe('canceled');
    expect(rows.get('u1')!.cancel_at_period_end).toBe(0);
  });

  it('returns null for an unknown customer', async () => {
    const { env } = fakeEnv();
    expect(await endSubscription(env, 'cus_none')).toBeNull();
  });
});

describe('getUserByStripeCustomerId', () => {
  it('returns the mapped user or null', async () => {
    const { env } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    expect((await getUserByStripeCustomerId(env, 'cus_1'))?.id).toBe('u1');
    expect(await getUserByStripeCustomerId(env, 'nope')).toBeNull();
  });
});
