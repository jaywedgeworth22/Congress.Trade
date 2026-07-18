/**
 * src/delivery/subscriptions.ts
 * OWNER: delivery agent
 *
 * Subscription CRUD + matching logic. Creates/updates/cancels subscriptions and
 * decides whether a given transaction matches a subscription's filters
 * (politicians/tickers/chambers/amount range/sides/sectors/market-cap buckets).
 */

import type { Env, Subscription, SubscriptionFilters, Transaction } from '../shared/types';
import { all, first, get, run } from '../shared/db';
import { prefixedId } from '../shared/ids';
import { mapSubscription, type SubscriptionRow } from './rows';
import { getUserById } from '../auth/users';
import { isPremiumUser } from '../billing/entitlement';

const SELECT_COLS =
  'id, client_id, delivery, target_url, secret, filters, cursor, active, created_at';

export const MAX_SUBSCRIPTIONS_PER_USER = 20;
export const MAX_ACTIVE_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_SUBSCRIPTION_SECRET_LENGTH = 256;
export const MAX_WEBHOOK_TARGET_URL_LENGTH = 2048;
/** Stricter floor for an operator-supplied secret rotated in after an incident. */
export const MIN_ROTATED_SUBSCRIPTION_SECRET_LENGTH = 32;

export class SubscriptionQuotaError extends Error {}

/**
 * Entitlement re-check at delivery/connection time. Subscription creation is
 * premium-gated, but a durable subscription outlives its owner's billing
 * state (trial-and-cancel would otherwise keep webhook/SSE delivery working
 * forever). User-owned rows store clientId as `user:<id>`; the owner must
 * still satisfy the same canonical predicate the UI/REST layer uses
 * (billing/entitlement isPremiumUser over the users row). Admin
 * operator-provisioned integration ids are intentionally ungated, matching
 * the PATCH /subscriptions/:id policy.
 */
export async function subscriptionOwnerEntitled(
  env: Env,
  clientId: string | null | undefined,
): Promise<boolean> {
  if (!clientId?.startsWith('user:')) return true;
  const owner = await getUserById(env, clientId.slice('user:'.length));
  return isPremiumUser(owner);
}

export function subscriptionSecretError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return 'secret must be a string';
  if (value.length < 16 || value.length > MAX_SUBSCRIPTION_SECRET_LENGTH) {
    return `secret must be 16-${MAX_SUBSCRIPTION_SECRET_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate a caller-supplied secret for POST .../rotate-secret. Rotation is
 * explicitly about replacing a production-facing HMAC key after an incident
 * (e.g. CT-AUD-003), so it holds a higher bar than creation's 16-char floor:
 * at least 32 characters, and no embedded whitespace (a common copy/paste
 * artifact that would silently break signature verification).
 */
export function rotateSubscriptionSecretError(value: unknown): string | null {
  if (typeof value !== 'string') return 'secret must be a string';
  if (
    value.length < MIN_ROTATED_SUBSCRIPTION_SECRET_LENGTH ||
    value.length > MAX_SUBSCRIPTION_SECRET_LENGTH
  ) {
    return `secret must be ${MIN_ROTATED_SUBSCRIPTION_SECRET_LENGTH}-${MAX_SUBSCRIPTION_SECRET_LENGTH} characters`;
  }
  if (/\s/.test(value)) return 'secret must not contain whitespace';
  return null;
}

export function webhookTargetLengthError(value: string | null): string | null {
  return value && value.length > MAX_WEBHOOK_TARGET_URL_LENGTH
    ? `targetUrl must be at most ${MAX_WEBHOOK_TARGET_URL_LENGTH} characters`
    : null;
}

function normalizedSubscriptionQuotaError(err: unknown): SubscriptionQuotaError | null {
  if (err instanceof SubscriptionQuotaError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/subscription total quota exceeded/i.test(message)) {
    return new SubscriptionQuotaError(`subscription limit reached (${MAX_SUBSCRIPTIONS_PER_USER} total)`);
  }
  if (/subscription active quota exceeded/i.test(message)) {
    return new SubscriptionQuotaError(`active subscription limit reached (${MAX_ACTIVE_SUBSCRIPTIONS_PER_USER})`);
  }
  return null;
}

async function runSubscriptionWrite(
  env: Env,
  sql: string,
  params: Array<string | number | null>,
): Promise<void> {
  try {
    await run(env.DB, sql, params);
  } catch (err) {
    const quotaError = normalizedSubscriptionQuotaError(err);
    if (quotaError) throw quotaError;
    throw err;
  }
}

/**
 * Durable D1-backed quota preflight; migration triggers are the race-safe
 * backstop (see trg_subscriptions_total_quota in migrations/0047_subscription_quota_active_only.sql).
 *
 * `total` deliberately counts ACTIVE rows only, not every lifetime row. There
 * is no hard-delete path for a subscription (only deactivate), so counting
 * deactivated rows here would permanently lock an account out of creating new
 * subscriptions once it accumulated 20 lifetime rows — the "lifetime
 * subscription lockout" bug. Deactivating an old subscription now reliably
 * frees its slot.
 */
export async function assertSubscriptionQuota(
  env: Env,
  clientId: string,
  opts: { creating?: boolean; activating?: boolean } = {},
): Promise<void> {
  const row = await first<{ total: number; active: number }>(
    env.DB,
    `SELECT COUNT(*) AS total, COUNT(*) AS active
       FROM subscriptions WHERE client_id = ? AND active = 1`,
    [clientId],
  );
  if (opts.creating && (row?.total ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER) {
    throw new SubscriptionQuotaError(`subscription limit reached (${MAX_SUBSCRIPTIONS_PER_USER} total)`);
  }
  if ((opts.creating || opts.activating) && (row?.active ?? 0) >= MAX_ACTIVE_SUBSCRIPTIONS_PER_USER) {
    throw new SubscriptionQuotaError(`active subscription limit reached (${MAX_ACTIVE_SUBSCRIPTIONS_PER_USER})`);
  }
}

export function validateSubscriptionFilters(value: unknown):
  | { ok: true; filters: SubscriptionFilters }
  | { ok: false; error: string } {
  if (value == null) return { ok: true, filters: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'filters must be an object' };
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['members', 'tickers', 'chambers', 'minAmount', 'maxAmount', 'sides', 'sectors', 'marketCapBuckets']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return { ok: false, error: 'filters contain unsupported fields' };

  const strings = (key: string, limit: number, maxLength: number): string[] | string => {
    const input = raw[key];
    if (input == null) return [];
    if (!Array.isArray(input) || input.length > limit || input.some((v) => typeof v !== 'string' || !v.trim() || v.length > maxLength)) {
      return `${key} must contain at most ${limit} bounded strings`;
    }
    return [...new Set(input.map((v) => (v as string).trim()))];
  };
  const members = strings('members', 50, 64); if (typeof members === 'string') return { ok: false, error: members };
  const tickersRaw = strings('tickers', 50, 20); if (typeof tickersRaw === 'string') return { ok: false, error: tickersRaw };
  const chambers = strings('chambers', 3, 10); if (typeof chambers === 'string') return { ok: false, error: chambers };
  const sides = strings('sides', 3, 1); if (typeof sides === 'string') return { ok: false, error: sides };
  const sectors = strings('sectors', 25, 100); if (typeof sectors === 'string') return { ok: false, error: sectors };
  const buckets = strings('marketCapBuckets', 6, 10); if (typeof buckets === 'string') return { ok: false, error: buckets };
  if (chambers.some((v) => v !== 'house' && v !== 'senate' && v !== 'executive')) return { ok: false, error: 'chambers contains an invalid value' };
  if (sides.some((v) => v !== 'P' && v !== 'S' && v !== 'E')) return { ok: false, error: 'sides contains an invalid value' };
  if (buckets.some((v) => !['mega', 'large', 'mid', 'small', 'micro', 'nano'].includes(v))) return { ok: false, error: 'marketCapBuckets contains an invalid value' };
  const min = raw.minAmount; const max = raw.maxAmount;
  if (min != null && (typeof min !== 'number' || !Number.isFinite(min) || min < 0)) return { ok: false, error: 'minAmount must be a non-negative number' };
  if (max != null && (typeof max !== 'number' || !Number.isFinite(max) || max < 0)) return { ok: false, error: 'maxAmount must be a non-negative number' };
  if (typeof min === 'number' && typeof max === 'number' && min > max) return { ok: false, error: 'minAmount cannot exceed maxAmount' };
  return { ok: true, filters: {
    ...(members.length ? { members } : {}), ...(tickersRaw.length ? { tickers: [...new Set(tickersRaw.map((v) => v.toUpperCase()))] } : {}),
    ...(chambers.length ? { chambers: chambers as SubscriptionFilters['chambers'] } : {}),
    ...(typeof min === 'number' ? { minAmount: min } : {}), ...(typeof max === 'number' ? { maxAmount: max } : {}),
    ...(sides.length ? { sides: sides as SubscriptionFilters['sides'] } : {}), ...(sectors.length ? { sectors } : {}),
    ...(buckets.length ? { marketCapBuckets: buckets } : {}),
  } };
}

/**
 * Generate a webhook signing secret (256 bits of entropy, hex). Uses WebCrypto
 * so it is Workers-compatible.
 */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `whsec_${hex}`;
}

/**
 * Create a new subscription. Generates the id and a per-subscription secret
 * unless the caller supplies one. Webhooks use it for HMAC signing; SSE and
 * management routes use it as the bearer credential. Defaults `active` to true,
 * `cursor` to 0, and stamps createdAt.
 */
export async function createSubscription(
  env: Env,
  input: Omit<Subscription, 'id' | 'cursor' | 'active' | 'createdAt'> &
    Partial<Pick<Subscription, 'cursor' | 'active'>>,
): Promise<Subscription> {
  const suppliedSecretError = input.secret == null ? null : subscriptionSecretError(input.secret);
  if (suppliedSecretError) throw new Error(suppliedSecretError);
  const targetLengthError = webhookTargetLengthError(input.targetUrl ?? null);
  if (targetLengthError) throw new Error(targetLengthError);
  const id = prefixedId('sub');
  const createdAt = new Date().toISOString();
  const cursor = input.cursor ?? 0;
  const active = input.active ?? true;
  const secret = input.secret ?? generateSecret();

  const sub: Subscription = {
    id,
    clientId: input.clientId,
    delivery: input.delivery,
    targetUrl: input.targetUrl ?? null,
    secret,
    filters: input.filters ?? {},
    cursor,
    active,
    createdAt,
  };

  await runSubscriptionWrite(
      env,
      `INSERT INTO subscriptions (${SELECT_COLS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sub.id,
        sub.clientId,
        sub.delivery,
        sub.targetUrl,
        sub.secret,
        JSON.stringify(sub.filters),
        sub.cursor,
        sub.active ? 1 : 0,
        sub.createdAt,
      ],
    );

  return sub;
}

/** Fetch a subscription by id, or null if absent. */
export async function getSubscription(env: Env, id: string): Promise<Subscription | null> {
  const row = await get<SubscriptionRow>(
    env.DB,
    `SELECT ${SELECT_COLS} FROM subscriptions WHERE id = ?`,
    [id],
  );
  return row ? mapSubscription(row) : null;
}

/** List subscriptions (optionally only active ones), newest first. */
export async function listSubscriptions(env: Env, activeOnly = false): Promise<Subscription[]> {
  const sql = activeOnly
    ? `SELECT ${SELECT_COLS} FROM subscriptions WHERE active = 1 ORDER BY created_at DESC`
    : `SELECT ${SELECT_COLS} FROM subscriptions ORDER BY created_at DESC`;
  const rows = await all<SubscriptionRow>(env.DB, sql);
  return rows.map(mapSubscription);
}

/**
 * Update mutable fields of a subscription (filters, target_url, secret, active,
 * cursor). Only provided keys are written. Returns the updated subscription.
 */
export async function updateSubscription(
  env: Env,
  id: string,
  patch: Partial<Pick<Subscription, 'filters' | 'targetUrl' | 'secret' | 'active' | 'cursor'>>,
): Promise<Subscription> {
  const suppliedSecretError = patch.secret == null ? null : subscriptionSecretError(patch.secret);
  if (suppliedSecretError) throw new Error(suppliedSecretError);
  const targetLengthError = patch.targetUrl === undefined
    ? null
    : webhookTargetLengthError(patch.targetUrl);
  if (targetLengthError) throw new Error(targetLengthError);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (patch.filters !== undefined) {
    sets.push('filters = ?');
    params.push(JSON.stringify(patch.filters));
  }
  if (patch.targetUrl !== undefined) {
    sets.push('target_url = ?');
    params.push(patch.targetUrl);
  }
  if (patch.secret !== undefined) {
    sets.push('secret = ?');
    params.push(patch.secret);
  }
  if (patch.active !== undefined) {
    sets.push('active = ?');
    params.push(patch.active ? 1 : 0);
  }
  if (patch.cursor !== undefined) {
    sets.push('cursor = ?');
    params.push(patch.cursor);
  }

  if (sets.length > 0) {
    params.push(id);
    await runSubscriptionWrite(
      env,
      `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  const updated = await getSubscription(env, id);
  if (!updated) throw new Error(`subscription not found: ${id}`);
  return updated;
}

export interface RotateSubscriptionSecretResult {
  subscription: Subscription;
  /** True when the secret was server-generated (only then is it safe to echo). */
  generated: boolean;
}

/**
 * Rotate a subscription's signing secret with zero secret exposure on the
 * caller-supplied path. If `secret` is omitted, generates a fresh one (same
 * entropy as creation) and returns it once for display; a caller-supplied
 * secret is validated (see {@link rotateSubscriptionSecretError}) but never
 * echoed back or logged.
 */
export async function rotateSubscriptionSecret(
  env: Env,
  id: string,
  secret?: string,
): Promise<RotateSubscriptionSecretResult> {
  const generated = secret === undefined;
  if (!generated) {
    const err = rotateSubscriptionSecretError(secret);
    if (err) throw new Error(err);
  }
  const nextSecret = generated ? generateSecret() : (secret as string);
  const subscription = await updateSubscription(env, id, { secret: nextSecret });
  return { subscription, generated };
}

/**
 * Deactivate a subscription: excludes it from delivery fanout (webhook/SSE
 * dispatch already filter on `active = 1`) and frees its slot against the
 * creation quota (see {@link assertSubscriptionQuota}). Idempotent — safe to
 * call on an already-inactive subscription.
 */
export async function deactivateSubscription(env: Env, id: string): Promise<Subscription> {
  return updateSubscription(env, id, { active: false });
}

/**
 * Pure predicate: does a transaction match a subscription's filters?
 *
 * Semantics (all clauses are AND-ed; an empty/undefined clause matches all):
 *   - members[]:  filer bioguide id must be in the set (matched by tx.filerId).
 *   - tickers[]:  tx.ticker must be in the set (case-insensitive).
 *   - chambers[]: NOTE — Transaction carries no chamber column; chamber filtering
 *                 is applied at the query layer (REST join on filings). This
 *                 predicate therefore treats `chambers` as advisory and only
   *                 enforces members/tickers/minAmount. Webhook dispatch resolves
 *                 chamber separately (see webhook.ts).
 *   - minAmount:  tx.amountMin must be >= filter.minAmount.
 */
export function matchesFilters(tx: Transaction, filters: SubscriptionFilters): boolean {
  if (!filters) return true;

  if (filters.members && filters.members.length > 0) {
    if (!tx.filerId || !filters.members.includes(tx.filerId)) return false;
  }

  if (filters.tickers && filters.tickers.length > 0) {
    const want = filters.tickers.map((t) => t.toUpperCase());
    if (!tx.ticker || !want.includes(tx.ticker.toUpperCase())) return false;
  }

  if (filters.minAmount !== undefined && filters.minAmount !== null) {
    const amt = tx.amountMin ?? 0;
    if (amt < filters.minAmount) return false;
  }

  if (filters.maxAmount !== undefined && filters.maxAmount !== null) {
    const amt = tx.amountMin ?? 0;
    if (amt > filters.maxAmount) return false;
  }

  if (filters.sides && filters.sides.length > 0) {
    if (!filters.sides.includes(tx.txType)) return false;
  }

  return true;
}

/** Resolved per-transaction context the predicate can't read off the row itself. */
export interface DeliveryContext {
  /** Owning filing's chamber ('house' | 'senate'). */
  chamber?: string | null;
  /** securities_ref.sector for the tx ticker. */
  sector?: string | null;
  /** securities_ref.market_cap_bucket for the tx ticker. */
  marketCapBucket?: string | null;
}

/**
 * Filter variant that enforces the clauses needing resolved context the caller
 * supplies (chamber from the owning filing; sector + market-cap bucket from
 * securities_ref). A filtered field with no resolved value never matches, so a
 * subscription that asks for e.g. mega-caps won't receive un-enriched tickers.
 */
export function matchesFiltersWithContext(
  tx: Transaction,
  filters: SubscriptionFilters,
  ctx: DeliveryContext,
): boolean {
  if (!matchesFilters(tx, filters)) return false;
  if (filters.chambers && filters.chambers.length > 0) {
    if (!ctx.chamber || !filters.chambers.includes(ctx.chamber as never)) return false;
  } else if (ctx.chamber === 'executive') {
    // Default delivery = congressional. Executive (OGE 278-T) rows are pushed
    // only to subscriptions that explicitly include 'executive' in their
    // chambers filter — a subscriber set up before executive tracking existed
    // must not suddenly receive a 3,000-row presidential filing.
    return false;
  }
  if (filters.sectors && filters.sectors.length > 0) {
    if (!ctx.sector || !filters.sectors.includes(ctx.sector)) return false;
  }
  if (filters.marketCapBuckets && filters.marketCapBuckets.length > 0) {
    if (!ctx.marketCapBucket || !filters.marketCapBuckets.includes(ctx.marketCapBucket)) return false;
  }
  return true;
}

/**
 * Back-compat wrapper: enforce chambers[] only (sector/cap unresolved). Prefer
 * {@link matchesFiltersWithContext} where securities_ref is available.
 */
export function matchesFiltersWithChamber(
  tx: Transaction,
  filters: SubscriptionFilters,
  chamber: string | null,
): boolean {
  return matchesFiltersWithContext(tx, filters, { chamber });
}
