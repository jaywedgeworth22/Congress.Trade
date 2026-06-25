/**
 * src/delivery/subscriptions.ts
 * OWNER: delivery agent
 *
 * Subscription CRUD + matching logic. Creates/updates/cancels subscriptions and
 * decides whether a given transaction matches a subscription's filters
 * (members/tickers/chambers/amount range/sides/sectors/market-cap buckets).
 */

import type { Env, Subscription, SubscriptionFilters, Transaction } from '../shared/types';
import { all, get, run } from '../shared/db';
import { prefixedId } from '../shared/ids';
import { mapSubscription, type SubscriptionRow } from './rows';

const SELECT_COLS =
  'id, client_id, delivery, target_url, secret, filters, cursor, active, created_at';

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

  await run(
    env.DB,
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
    await run(
      env.DB,
      `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  const updated = await getSubscription(env, id);
  if (!updated) throw new Error(`subscription not found: ${id}`);
  return updated;
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
