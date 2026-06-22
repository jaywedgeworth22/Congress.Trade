import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  encodeForm,
  verifyStripeSignature,
  stripeConfigured,
  createCheckoutSession,
} from '../stripe';
import type { Env } from '../../shared/types';

/** Recompute the v1 signature the way Stripe does, for the verify tests. */
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

describe('encodeForm', () => {
  it('bracket-encodes nested arrays/objects and skips null/undefined', () => {
    const s = encodeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      subscription_data: { metadata: { userId: 'u1' }, trial_period_days: 7 },
      customer: undefined,
      note: null,
    });
    const p = new URLSearchParams(s);
    expect(p.get('mode')).toBe('subscription');
    expect(p.get('line_items[0][price]')).toBe('price_1');
    expect(p.get('line_items[0][quantity]')).toBe('1');
    expect(p.get('subscription_data[metadata][userId]')).toBe('u1');
    expect(p.get('subscription_data[trial_period_days]')).toBe('7');
    expect(s).not.toContain('customer');
    expect(s).not.toContain('note');
  });
});

describe('stripeConfigured', () => {
  it('reflects presence of the secret key', () => {
    expect(stripeConfigured({} as Env)).toBe(false);
    expect(stripeConfigured({ STRIPE_SECRET_KEY: 'sk' } as Env)).toBe(true);
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"customer.subscription.updated"}';

  it('accepts a fresh, correct signature', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body, header, secret, 300, ts + 10)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body + 'x', header, secret, 300, ts + 10)).toBe(false);
  });

  it('rejects a stale timestamp outside tolerance', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body, header, secret, 300, ts + 10_000)).toBe(false);
  });

  it('rejects missing header / wrong secret / malformed header', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body, null, secret, 300, ts)).toBe(false);
    expect(await verifyStripeSignature(body, header, 'wrong', 300, ts)).toBe(false);
    expect(await verifyStripeSignature(body, 'garbage', secret, 300, ts)).toBe(false);
  });
});

describe('createCheckoutSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs subscription params with trial + customer and returns the URL', async () => {
    let captured: { url: string; body: string } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: String(init.body) };
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://stripe/checkout' }), { status: 200 });
    });
    const env = { STRIPE_SECRET_KEY: 'sk_test' } as Env;
    const res = await createCheckoutSession(env, {
      priceId: 'price_m',
      successUrl: 'https://app/?checkout=success',
      cancelUrl: 'https://app/?checkout=cancel',
      clientReferenceId: 'u1',
      customerId: 'cus_1',
      trialDays: 7,
    });
    expect(res.url).toBe('https://stripe/checkout');
    expect(captured!.url).toContain('/checkout/sessions');
    const p = new URLSearchParams(captured!.body);
    expect(p.get('mode')).toBe('subscription');
    expect(p.get('line_items[0][price]')).toBe('price_m');
    expect(p.get('customer')).toBe('cus_1');
    expect(p.get('client_reference_id')).toBe('u1');
    expect(p.get('subscription_data[trial_period_days]')).toBe('7');
    expect(p.get('subscription_data[metadata][userId]')).toBe('u1');
  });

  it('throws when the secret key is missing', async () => {
    await expect(
      createCheckoutSession({} as Env, {
        priceId: 'p',
        successUrl: 's',
        cancelUrl: 'c',
        clientReferenceId: 'u1',
      }),
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});
