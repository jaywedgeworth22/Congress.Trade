/**
 * src/billing/routes.ts
 * Stripe billing router (mounted at /billing).
 *
 *   GET  /billing/status    -> checkout/portal capabilities + entitlement
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
import type { BillingPlan, Env } from '../shared/types.ts';
import { getCurrentUser } from '../auth/session.ts';
import { getUserById } from '../auth/users.ts';
import { entitlementOf } from './entitlement.ts';
import {
  billingCapabilitiesAsync,
  checkoutConfiguredAsync,
  portalConfiguredAsync,
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  verifyStripeSignature,
} from './stripe.ts';
import { resolveSecret, resolveSecrets } from '../secrets/infisical.ts';
import {
  linkCustomerToUser,
  parseSubscription,
  applySubscription,
  endSubscription,
} from './subscription.ts';
import {
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  releaseStripeWebhookEvent,
} from './webhookEvents.ts';

const DEFAULT_TRIAL_DAYS = 7;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdForStripe(c: Context): { id: string } | { error: string } {
  const supplied = c.req.header('Idempotency-Key');
  if (supplied == null) return { error: 'Idempotency-Key required' };
  const id = supplied.trim();
  return REQUEST_ID_RE.test(id) ? { id } : { error: 'invalid Idempotency-Key' };
}

function stripeOperationKey(operation: string, userId: string, requestId?: string): string {
  return ['congress-trade', operation, userId, requestId].filter(Boolean).join(':');
}

/** Stripe expandable-id fields may be either an id string or `{ id }`. */
function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Public-facing origin for redirects (APP_BASE_URL, else request origin). */
async function baseUrl(c: Context<{ Bindings: Env }>): Promise<string> {
  const configured = (await resolveSecret(c.env, 'APP_BASE_URL')).value?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return new URL(c.req.url).origin;
}

async function trialDays(env: Env): Promise<number> {
  const n = Number((await resolveSecret(env, 'STRIPE_TRIAL_DAYS')).value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TRIAL_DAYS;
}

async function priceForPlan(env: Env, plan: BillingPlan): Promise<string | undefined> {
  const prices = await resolveSecrets(env, ['STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL']);
  return plan === 'annual'
    ? prices.STRIPE_PRICE_ANNUAL
    : prices.STRIPE_PRICE_MONTHLY;
}

export function buildBillingRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /billing/status ------------------------------------------------
  r.get('/status', async (c) => {
    const user = await getCurrentUser(c);
    return c.json({
      ...(await billingCapabilitiesAsync(c.env)),
      hasCustomer: Boolean(user?.stripeCustomerId),
      entitlement: entitlementOf(user),
    });
  });

  // --- POST /billing/checkout ---------------------------------------------
  r.post('/checkout', async (c) => {
    const user = await getCurrentUser(c);
    if (!user) return c.json({ error: 'sign in to subscribe', needLogin: true }, 401);
    if (!(await checkoutConfiguredAsync(c.env))) return c.json({ error: 'checkout not configured' }, 503);

    let body: { plan?: unknown };
    try {
      body = (await c.req.json()) as { plan?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const plan: BillingPlan = body.plan === 'annual' ? 'annual' : 'monthly';
    const priceId = await priceForPlan(c.env, plan);
    if (!priceId) return c.json({ error: `no Stripe price configured for ${plan} plan` }, 503);
    const requestId = requestIdForStripe(c);
    if ('error' in requestId) return c.json({ error: requestId.error }, 400);

    try {
      // Create the Stripe customer up-front (if needed) so the customer<->user
      // link is persisted before any subscription webhook arrives.
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await createCustomer(c.env, {
          email: user.email,
          metadata: { userId: user.id },
          idempotencyKey: stripeOperationKey('customer', user.id),
        });
        customerId = customer.id;
        const linked = await linkCustomerToUser(c.env, user.id, customerId);
        if (!linked) {
          // Another request or webhook linked a customer after our user read.
          // Keep the existing owner link authoritative for this checkout.
          const current = await getUserById(c.env, user.id);
          if (!current?.stripeCustomerId) throw new Error('could not persist Stripe customer link');
          customerId = current.stripeCustomerId;
        }
      }
      const base = await baseUrl(c);
      const session = await createCheckoutSession(c.env, {
        priceId,
        customerId,
        clientReferenceId: user.id,
        successUrl: `${base}/?checkout=success`,
        cancelUrl: `${base}/?checkout=cancel`,
        trialDays: await trialDays(c.env),
        idempotencyKey: stripeOperationKey(`checkout:${plan}`, user.id, requestId.id),
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
    if (!(await portalConfiguredAsync(c.env))) return c.json({ error: 'billing portal not configured' }, 503);
    if (!user.stripeCustomerId) return c.json({ error: 'no billing account yet' }, 400);
    const requestId = requestIdForStripe(c);
    if ('error' in requestId) return c.json({ error: requestId.error }, 400);
    try {
      const session = await createBillingPortalSession(c.env, {
        customerId: user.stripeCustomerId,
        returnUrl: `${await baseUrl(c)}/?billing=portal`,
        idempotencyKey: stripeOperationKey('portal', user.id, requestId.id),
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
    const secret = (await resolveSecret(c.env, 'STRIPE_WEBHOOK_SECRET')).value;
    if (!secret) return c.json({ error: 'webhook not configured' }, 503);
    const payload = await c.req.text();
    const sig = c.req.header('stripe-signature');
    const valid = await verifyStripeSignature(payload, sig, secret);
    if (!valid) return c.json({ error: 'invalid signature' }, 400);

    let event: { id?: string; type?: string; created?: number; data?: { object?: unknown } };
    try {
      event = JSON.parse(payload) as { id?: string; type?: string; created?: number; data?: { object?: unknown } };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    if (
      !event.id
      || !event.type
      || typeof event.created !== 'number'
      || !Number.isInteger(event.created)
      || event.created < 0
    ) {
      return c.json({ error: 'invalid Stripe event' }, 400);
    }

    let claimToken: string | null = null;
    try {
      const claim = await claimStripeWebhookEvent(c.env, event.id, event.type);
      if (claim.status === 'duplicate') return c.json({ received: true, duplicate: true });
      if (claim.status === 'busy') {
        return c.json({ error: 'webhook event is already being processed' }, 503, { 'Retry-After': '5' });
      }
      claimToken = claim.claimToken;

      const obj = event.data?.object as Record<string, unknown> | undefined;
      switch (event.type) {
        case 'checkout.session.completed': {
          // Link the customer to the user; subscription.* events carry the detail.
          const userId = obj?.client_reference_id;
          const customerId = stripeObjectId(obj?.customer);
          if (typeof userId !== 'string' || userId.length === 0 || !customerId) {
            throw new Error('malformed checkout.session.completed payload');
          }
          await linkCustomerToUser(c.env, userId, customerId);
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = parseSubscription(obj ?? {});
          if (!sub) throw new Error(`malformed ${event.type} payload`);
          await applySubscription(c.env, sub, {
            id: event.id,
            created: event.created,
            type: event.type,
          });
          break;
        }
        case 'customer.subscription.deleted': {
          const subscriptionId = stripeObjectId(obj?.id);
          const customerId = stripeObjectId(obj?.customer);
          const metadata = obj?.metadata;
          const metadataUserId = metadata && typeof metadata === 'object'
            && typeof (metadata as Record<string, unknown>).userId === 'string'
            ? (metadata as Record<string, unknown>).userId as string
            : null;
          if (!customerId || !subscriptionId) {
            throw new Error('malformed customer.subscription.deleted payload');
          }
          await endSubscription(c.env, customerId, subscriptionId, {
            id: event.id,
            created: event.created,
            type: event.type,
          }, metadataUserId);
          break;
        }
        default:
          break; // ignore unrelated events
      }
      if (!(await markStripeWebhookEventProcessed(c.env, event.id, claimToken))) {
        throw new Error('webhook claim was lost before completion');
      }
    } catch (err) {
      if (claimToken) {
        try {
          await releaseStripeWebhookEvent(c.env, event.id, claimToken);
        } catch (releaseErr) {
          console.error('webhook idempotency release failed:', (releaseErr as Error).message);
        }
      }
      console.error('webhook handling error:', (err as Error).message);
      return c.json({ error: 'webhook handling failed' }, 500);
    }
    return c.json({ received: true });
  });

  return r;
}
