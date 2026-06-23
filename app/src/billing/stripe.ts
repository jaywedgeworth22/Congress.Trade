/**
 * src/billing/stripe.ts
 * Minimal, dependency-free Stripe REST client for Cloudflare Workers. We only
 * need a few endpoints (Customers, Checkout Sessions, Billing Portal) plus
 * webhook signature verification, so we hit the form-encoded REST API directly
 * rather than pulling in the Node-oriented `stripe` SDK.
 *
 * All calls require STRIPE_SECRET_KEY; webhook verification requires
 * STRIPE_WEBHOOK_SECRET. `stripeConfigured()` lets routes degrade to 503.
 */

import type { Env } from '../shared/types';

const STRIPE_API = 'https://api.stripe.com/v1';
// Pin an API version so server-side behaviour/field shapes are stable.
const STRIPE_API_VERSION = '2025-03-31.basil'; // Managed Payments requires basil+

/** True when the secret key is present (billing can operate). */
export function stripeConfigured(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

/**
 * Flatten a nested params object into Stripe's bracketed form-encoding, e.g.
 * { line_items: [{ price: 'p', quantity: 1 }] } ->
 *   line_items[0][price]=p&line_items[0][quantity]=1
 */
export function encodeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}[${k}]` : k, v);
      }
    } else {
      out.append(prefix, String(value));
    }
  };
  walk('', params);
  return out.toString();
}

async function stripePost<T>(env: Env, path: string, params: Record<string, unknown>): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
    },
    body: encodeForm(params),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`stripe ${path} failed: ${body?.error?.message || `HTTP ${res.status}`}`);
  }
  return body as T;
}

export interface StripeCustomer {
  id: string;
}

/** Create a Stripe customer for a signed-in user. */
export function createCustomer(
  env: Env,
  args: { email: string; metadata?: Record<string, string> },
): Promise<StripeCustomer> {
  return stripePost<StripeCustomer>(env, '/customers', {
    email: args.email,
    metadata: args.metadata,
  });
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Create a subscription Checkout Session and return its hosted URL. */
export function createCheckoutSession(
  env: Env,
  args: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    clientReferenceId: string;
    customerId?: string | null;
    customerEmail?: string | null;
    trialDays?: number;
  },
): Promise<CheckoutSession> {
  const params: Record<string, unknown> = {
    mode: 'subscription',
    line_items: [{ price: args.priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.clientReferenceId,
    allow_promotion_codes: true,
    // Stripe Managed Payments (merchant-of-record). Gated by env so it only
    // turns on once the account is approved + prices carry an eligible tax code.
    ...(env.STRIPE_MANAGED_PAYMENTS === 'true' ? { managed_payments: { enabled: true } } : {}),
    // Carry the user id on the subscription too, so subscription.* webhooks can
    // resolve the user even before the customer<->user link is persisted.
    subscription_data: {
      metadata: { userId: args.clientReferenceId },
      ...(args.trialDays && args.trialDays > 0 ? { trial_period_days: args.trialDays } : {}),
    },
  };
  // A Checkout Session takes EITHER an existing customer OR an email to create one.
  if (args.customerId) params.customer = args.customerId;
  else if (args.customerEmail) params.customer_email = args.customerEmail;
  return stripePost<CheckoutSession>(env, '/checkout/sessions', params);
}

export interface PortalSession {
  id: string;
  url: string;
}

/** Create a Billing Portal session so a customer can manage their subscription. */
export function createBillingPortalSession(
  env: Env,
  args: { customerId: string; returnUrl: string },
): Promise<PortalSession> {
  return stripePost<PortalSession>(env, '/billing_portal/sessions', {
    customer: args.customerId,
    return_url: args.returnUrl,
  });
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Stripe's `Stripe-Signature` scheme)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (avoids leaking match length via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/**
 * Verify a Stripe webhook signature. `header` is the `Stripe-Signature` value
 * (`t=<ts>,v1=<sig>,v1=<sig2>,…`); we recompute HMAC-SHA256 over `${t}.${body}`
 * and compare against any provided `v1` signature, rejecting stale timestamps.
 * Returns true only on a valid, fresh signature.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}
