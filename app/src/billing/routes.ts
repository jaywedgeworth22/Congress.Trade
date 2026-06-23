/**
 * src/billing/routes.ts
 * Stripe billing router (mounted at /billing).
 *
 *   GET  /billing/status    -> { configured, entitlement } for the current user
 *   POST /billing/checkout  -> { url } : start a subscription Checkout (auth required)
 *   POST /billing/portal    -> { url } : open the Stripe Billing Portal (auth required)
 *   POST /billing/webhook   -> Stripe event sink (signature-verified, no auth)
 *
 * Identity comes from the end-user session cookie (auth/session.ts). Entitlement
 * is derived purely from the user's billing fields (entitlement.ts). The webhook
 * is the source of truth for subscription state — checkout/portal just kick off
 * hosted Stripe flows.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { BillingPlan, Env } from '../shared/types';
import { getCurrentUser } from '../auth/session';
import { entitlementOf } from './entitlement';
import {
  stripeConfigured,
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  verifyStripeSignature,
} from './stripe';
import {
  linkCustomerToUser,
  parseSubscription,
  applySubscription,
  endSubscription,
} from './subscription';

const DEFAULT_TRIAL_DAYS = 7;

/** Public-facing origin for redirects (APP_BASE_URL, else request origin). */
function baseUrl(c: Context<{ Bindings: Env }>): string {
  const configured = c.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return new URL(c.req.url).origin;
}

function trialDays(env: Env): number {
  const n = Number(env.STRIPE_TRIAL_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TRIAL_DAYS;
}

function priceForPlan(env: Env, plan: BillingPlan): string | undefined {
  return plan === 'annual' ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;
}

export function buildBillingRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /billing/status ------------------------------------------------
  r.get('/status', async (c) => {
    const user = await getCurrentUser(c);
    return c.json({ configured: stripeConfigured(c.env), entitlement: entitlementOf(user) });
  });

  // --- POST /billing/checkout ---------------------------------------------
  r.post('/checkout', async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.json({ error: 'sign in to subscribe', needLogin: true }, 401);
    if (!stripeConfigured(c.env)) return c.json({ error: 'billing not configured' }, 503);

    let body: { plan?: unknown };
    try {
      body = (await c.req.json()) as { plan?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const plan: BillingPlan = body.plan === 'annual' ? 'annual' : 'monthly';
    const priceId = priceForPlan(c.env, plan);
    if (!priceId) return c.json({ error: `no Stripe price configured for ${plan} plan` }, 503);

    try {
      // Create the Stripe customer up-front (if needed) so the customer<->user
      // link is persisted before any subscription webhook arrives.
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await createCustomer(c.env, {
          email: user.email,
          metadata: { userId: user.id },
        });
        customerId = customer.id;
        await linkCustomerToUser(c.env, user.id, customerId);
      }
      const base = baseUrl(c);
      const session = await createCheckoutSession(c.env, {
        priceId,
        customerId,
        clientReferenceId: user.id,
        successUrl: `${base}/?checkout=success`,
        cancelUrl: `${base}/?checkout=cancel`,
        trialDays: trialDays(c.env),
      });
      return c.json({ url: session.url });
    } catch (err) {
      console.error('checkout failed:', (err as Error).message);
      return c.json({ error: 'could not start checkout' }, 502);
    }
  });

  // --- POST /billing/portal -----------------------------------------------
  r.post('/portal', async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.json({ error: 'sign in first', needLogin: true }, 401);
    if (!stripeConfigured(c.env)) return c.json({ error: 'billing not configured' }, 503);
    if (!user.stripeCustomerId) return c.json({ error: 'no billing account yet' }, 400);
    try {
      const session = await createBillingPortalSession(c.env, {
        customerId: user.stripeCustomerId,
        returnUrl: `${baseUrl(c)}/?billing=portal`,
      });
      return c.json({ url: session.url });
    } catch (err) {
      console.error('portal failed:', (err as Error).message);
      return c.json({ error: 'could not open billing portal' }, 502);
    }
  });

  // --- POST /billing/webhook ----------------------------------------------
  // Stripe event sink. Verifies the signature against STRIPE_WEBHOOK_SECRET,
  // then reconciles subscription state. Must read the RAW body for the HMAC.
  r.post('/webhook', async (c) => {
    const secret = c.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'webhook not configured' }, 503);
    const payload = await c.req.text();
    const sig = c.req.header('stripe-signature');
    const valid = await verifyStripeSignature(payload, sig, secret);
    if (!valid) return c.json({ error: 'invalid signature' }, 400);

    let event: { type?: string; data?: { object?: unknown } };
    try {
      event = JSON.parse(payload) as { type?: string; data?: { object?: unknown } };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }

    try {
      const obj = event.data?.object as Record<string, unknown> | undefined;
      switch (event.type) {
        case 'checkout.session.completed': {
          // Link the customer to the user; subscription.* events carry the detail.
          const userId = obj?.client_reference_id;
          const customer = obj?.customer;
          if (typeof userId === 'string' && typeof customer === 'string') {
            await linkCustomerToUser(c.env, userId, customer);
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = parseSubscription(obj ?? {});
          if (sub) await applySubscription(c.env, sub);
          break;
        }
        case 'customer.subscription.deleted': {
          const customer = typeof obj?.customer === 'string' ? obj.customer : undefined;
          if (customer) await endSubscription(c.env, customer);
          break;
        }
        default:
          break; // ignore unrelated events
      }
    } catch (err) {
      console.error('webhook handling error:', (err as Error).message);
      return c.json({ error: 'webhook handling failed' }, 500);
    }
    return c.json({ received: true });
  });

  return r;
}
