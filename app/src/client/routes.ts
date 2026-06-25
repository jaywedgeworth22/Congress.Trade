/**
 * src/client/routes.ts
 *
 * Shared backend-owned API for the phone-first PWA and SwiftUI app.
 * Mounted at /api/client/v1. Public reads stay public; preferences and commands
 * require the existing opaque session via cookie or Authorization bearer.
 */

import { Hono, type Context } from 'hono';
import type {
  Chamber,
  ClientCommandType,
  ClientTrade,
  DeliveryChannel,
  Env,
  Subscription,
  SubscriptionFilters,
  TxType,
  User,
} from '../shared/types';
import { all, get } from '../shared/db';
import { getCurrentUserFromRequest } from '../auth/session';
import { entitlementOf } from '../billing/entitlement';
import {
  buildTransactionsCountQuery,
  buildTransactionsQuery,
  mapFeedTransaction,
  type FeedTransactionRow,
  type TxQueryParams,
} from '../delivery/rows';
import {
  createSubscription,
  getSubscription,
  updateSubscription,
} from '../delivery/subscriptions';
import { mapSubscription, type SubscriptionRow } from '../delivery/rows';
import { normalizeTickerLogoSymbol } from '../ui/tickerLogos';
import {
  createCommand,
  findCommandByIdempotencyKey,
  getCommand,
  getPreferences,
  listCommands,
  updateCommandStatus,
  upsertPreferences,
} from './state';

type ClientContext = Context<{ Bindings: Env }>;

const SUBSCRIPTION_COLS =
  'id, client_id, delivery, target_url, secret, filters, cursor, active, created_at';

class ClientInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type ClientErrorStatus = 400 | 401 | 404 | 500 | 501;

function errorStatus(err: ClientInputError): ClientErrorStatus {
  if (err.status === 401 || err.status === 404 || err.status === 501) return err.status;
  if (err.status === 400) return 400;
  return 500;
}

function parseIntOrUndef(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asChamber(v: string | undefined): Chamber | undefined {
  return v === 'house' || v === 'senate' ? v : undefined;
}

function asTxType(v: string | undefined): TxType | undefined {
  return v === 'P' || v === 'S' || v === 'E' ? v : undefined;
}

/** Whitelist the sort direction; anything other than 'desc' falls back to asc. */
function asOrder(v: string | undefined): 'asc' | 'desc' | undefined {
  return v === 'desc' ? 'desc' : v === 'asc' ? 'asc' : undefined;
}

function asDelivery(v: unknown): DeliveryChannel {
  if (v === 'sse' || v === undefined || v === null || v === '') return 'sse';
  if (v === 'webhook') return 'webhook';
  throw new ClientInputError("delivery must be 'sse' or 'webhook'");
}

function clientIdForUser(user: User): string {
  return `user:${user.id}`;
}

async function requireUser(c: ClientContext): Promise<User> {
  const user = await getCurrentUserFromRequest(c);
  if (!user) throw new ClientInputError('sign in required', 401);
  return user;
}

function isLocalHttpUrl(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  );
}

function validateWebhookTargetUrl(targetUrl: string | null): void {
  if (!targetUrl) throw new ClientInputError('targetUrl is required for webhook subscriptions');
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new ClientInputError('targetUrl must be a valid absolute URL');
  }
  if (url.protocol !== 'https:' && !isLocalHttpUrl(url)) {
    throw new ClientInputError('targetUrl must use https:// outside localhost development');
  }
}

function arrayOfStrings(value: unknown, opts: { upper?: boolean } = {}): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ClientInputError('filters arrays must contain strings');
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (opts.upper ? v.toUpperCase() : v));
  return Array.from(new Set(out));
}

function normalizeFilters(value: unknown): SubscriptionFilters {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientInputError('filters must be an object');
  }
  const input = value as Record<string, unknown>;
  const chambers = arrayOfStrings(input.chambers);
  const out: SubscriptionFilters = {};
  const members = arrayOfStrings(input.members);
  const tickers = arrayOfStrings(input.tickers, { upper: true });
  if (members && members.length) out.members = members;
  if (tickers && tickers.length) out.tickers = tickers;
  if (chambers && chambers.length) {
    const valid = chambers.filter((c): c is Chamber => c === 'house' || c === 'senate');
    if (valid.length !== chambers.length) throw new ClientInputError("chambers must be 'house' or 'senate'");
    out.chambers = valid;
  }
  if (input.minAmount !== undefined && input.minAmount !== null && input.minAmount !== '') {
    const n = Number(input.minAmount);
    if (!Number.isFinite(n) || n < 0) throw new ClientInputError('minAmount must be a positive number');
    out.minAmount = Math.floor(n);
  }
  return out;
}

function publicSubscription(sub: Subscription, includeSecret = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: sub.id,
    delivery: sub.delivery,
    targetUrl: sub.targetUrl,
    filters: sub.filters,
    cursor: sub.cursor,
    active: sub.active,
    createdAt: sub.createdAt,
    hasSecret: Boolean(sub.secret),
  };
  if (includeSecret && sub.secret) {
    out.secret = sub.secret;
    if (sub.delivery === 'sse') {
      out.streamUrl = `/api/stream?subscription=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(sub.secret)}`;
    }
  }
  return out;
}

function filtersFromQuery(q: Record<string, string>): TxQueryParams {
  return {
    since: parseIntOrUndef(q.since),
    ticker: q.ticker || undefined,
    member: q.member || undefined,
    chamber: asChamber(q.chamber),
    type: asTxType(q.type),
    txDateMin: q.from || q.txDateMin || undefined,
    txDateMax: q.to || q.txDateMax || undefined,
    order: asOrder(q.order),
    limit: parseIntOrUndef(q.limit),
  };
}

/**
 * Same-origin cached logo URL for a ticker, or null when the symbol can't be
 * resolved. Points at the shared `/api/logos/ticker` proxy (see ui/tickerLogos.ts)
 * so every client — web, PWA, Swift — renders the identical logo and benefits
 * from the edge cache. The symbol is normalized (uppercased, `$`-stripped,
 * validated) so we never emit a URL the proxy would reject.
 */
function clientLogoUrl(ticker: string | null): string | null {
  const symbol = normalizeTickerLogoSymbol(ticker);
  return symbol ? `/api/logos/ticker?symbol=${encodeURIComponent(symbol)}` : null;
}

function clientTradeFromRow(row: FeedTransactionRow & { __chamber?: string | null; __member_name?: string | null; __party?: string | null }): ClientTrade {
  const tx = mapFeedTransaction(row);
  return {
    id: tx.id,
    cursor: tx.cursorSeq,
    docId: tx.docId,
    member: {
      id: tx.filerId,
      name: tx.fullName ?? row.__member_name ?? null,
      chamber: (row.__chamber as Chamber | null) ?? null,
      party: row.__party ?? null,
      state: tx.state ?? null,
      photoUrl: tx.photoUrl ?? null,
    },
    asset: {
      name: tx.assetName,
      ticker: tx.ticker,
      companyName: tx.refCompanyName ?? null,
      logoUrl: clientLogoUrl(tx.ticker),
      type: tx.assetType,
      sector: tx.refSector ?? null,
      marketCapBucket: tx.refMarketCapBucket ?? null,
    },
    transaction: {
      date: tx.txDate,
      type: tx.txType,
      owner: tx.owner,
      amountMin: tx.amountMin,
      amountMax: tx.amountMax,
      isOption: tx.isOption,
    },
    filing: {
      filedDate: tx.filedDate ?? null,
      firstSeenAt: tx.firstSeenAt ?? null,
      sourceUrl: tx.sourceUrl ?? null,
    },
    confidence: tx.confidence,
    source: tx.source,
  };
}

async function listUserSubscriptions(env: Env, user: User): Promise<Subscription[]> {
  const rows = await all<SubscriptionRow>(
    env.DB,
    `SELECT ${SUBSCRIPTION_COLS} FROM subscriptions WHERE client_id = ? ORDER BY created_at DESC`,
    [clientIdForUser(user)],
  );
  return rows.map(mapSubscription);
}

async function getOwnedSubscription(env: Env, user: User, id: string): Promise<Subscription> {
  const sub = await getSubscription(env, id);
  if (!sub || sub.clientId !== clientIdForUser(user)) {
    throw new ClientInputError('subscription not found', 404);
  }
  return sub;
}

function commandType(value: unknown): ClientCommandType {
  const type = String(value || '');
  if (
    type === 'update_preferences' ||
    type === 'create_subscription' ||
    type === 'update_subscription' ||
    type === 'start_checkout' ||
    type === 'request_export'
  ) {
    return type;
  }
  throw new ClientInputError('unsupported command type');
}

async function executeCommand(env: Env, user: User, type: ClientCommandType, payload: unknown): Promise<unknown> {
  const input = (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
  if (type === 'update_preferences') {
    return { preferences: await upsertPreferences(env, user.id, normalizePreferencePatch(input)) };
  }
  if (type === 'create_subscription') {
    const delivery = asDelivery(input.delivery);
    const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
    if (delivery === 'webhook') validateWebhookTargetUrl(targetUrl);
    const sub = await createSubscription(env, {
      clientId: clientIdForUser(user),
      delivery,
      targetUrl: delivery === 'webhook' ? targetUrl : null,
      secret: null,
      filters: normalizeFilters(input.filters),
    });
    return { subscription: publicSubscription(sub, true) };
  }
  if (type === 'update_subscription') {
    const id = typeof input.id === 'string' ? input.id : '';
    if (!id) throw new ClientInputError('id is required');
    await getOwnedSubscription(env, user, id);
    const patch: Partial<Pick<Subscription, 'filters' | 'targetUrl' | 'active'>> = {};
    if (input.filters !== undefined) patch.filters = normalizeFilters(input.filters);
    if (input.active !== undefined) patch.active = input.active === true;
    if (input.targetUrl !== undefined) {
      const targetUrl = typeof input.targetUrl === 'string' ? input.targetUrl.trim() : null;
      if (targetUrl) validateWebhookTargetUrl(targetUrl);
      patch.targetUrl = targetUrl;
    }
    const updated = await updateSubscription(env, id, patch);
    return { subscription: publicSubscription(updated) };
  }
  throw new ClientInputError(`${type} is not implemented yet`, 501);
}

function normalizePreferencePatch(input: Record<string, unknown>) {
  const patch: Parameters<typeof upsertPreferences>[2] = {};
  if (input.savedFilters !== undefined) {
    if (typeof input.savedFilters !== 'object' || Array.isArray(input.savedFilters) || input.savedFilters === null) {
      throw new ClientInputError('savedFilters must be an object');
    }
    patch.savedFilters = input.savedFilters as Record<string, unknown>;
  }
  if (input.watchlist !== undefined) patch.watchlist = arrayOfStrings(input.watchlist, { upper: true }) ?? [];
  if (input.notificationSettings !== undefined) {
    if (
      typeof input.notificationSettings !== 'object' ||
      Array.isArray(input.notificationSettings) ||
      input.notificationSettings === null
    ) {
      throw new ClientInputError('notificationSettings must be an object');
    }
    patch.notificationSettings = input.notificationSettings as Record<string, unknown>;
  }
  if (input.defaultWindow !== undefined) {
    patch.defaultWindow = input.defaultWindow == null ? null : String(input.defaultWindow);
  }
  return patch;
}

async function readJson(c: ClientContext): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.text();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new ClientInputError('invalid JSON body');
  }
}

export function buildClientRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  r.get('/bootstrap', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    return c.json({
      serverTime: new Date().toISOString(),
      auth: {
        user: user
          ? { id: user.id, email: user.email, name: user.name, picture: user.picture }
          : null,
        entitlement: entitlementOf(user),
      },
      capabilities: {
        feed: true,
        sse: true,
        webhooks: Boolean(user),
        commands: Boolean(user),
        preferences: Boolean(user),
      },
      endpoints: {
        feed: '/api/client/v1/feed',
        commands: '/api/client/v1/commands',
        preferences: '/api/client/v1/preferences',
        subscriptions: '/api/client/v1/subscriptions',
      },
    });
  });

  r.get('/me', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    return c.json({ user, entitlement: entitlementOf(user) });
  });

  r.get('/feed', async (c) => {
    const params = filtersFromQuery(c.req.query());
    const built = buildTransactionsQuery(params);
    const rows = await all<FeedTransactionRow & { __chamber?: string | null; __member_name?: string | null; __party?: string | null }>(
      c.env.DB,
      built.sql,
      built.params,
    );
    const items = rows.map(clientTradeFromRow);
    const maxCursor = items.reduce((m, t) => (t.cursor > m ? t.cursor : m), params.since ?? 0);
    const countQuery = buildTransactionsCountQuery(params);
    const countRow = await get<{ total: number }>(c.env.DB, countQuery.sql, countQuery.params);
    return c.json({
      items,
      cursor: maxCursor,
      count: items.length,
      total: countRow?.total ?? items.length,
      limit: built.limit,
      nextPollAfterSec: 30,
    });
  });

  r.get('/preferences', async (c) => {
    try {
      const user = await requireUser(c);
      return c.json({ preferences: await getPreferences(c.env, user.id) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.put('/preferences', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await readJson(c);
      return c.json({ preferences: await upsertPreferences(c.env, user.id, normalizePreferencePatch(body)) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/subscriptions', async (c) => {
    try {
      const user = await requireUser(c);
      const subs = await listUserSubscriptions(c.env, user);
      return c.json({ subscriptions: subs.map((sub) => publicSubscription(sub)) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/commands', async (c) => {
    try {
      const user = await requireUser(c);
      return c.json({ commands: await listCommands(c.env, user.id, parseIntOrUndef(c.req.query('limit')) ?? 20) });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.get('/commands/:id', async (c) => {
    try {
      const user = await requireUser(c);
      const command = await getCommand(c.env, user.id, c.req.param('id'));
      if (!command) return c.json({ error: 'command not found' }, 404);
      return c.json({ command });
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }
  });

  r.post('/commands', async (c) => {
    let user: User;
    let body: Record<string, unknown>;
    try {
      user = await requireUser(c);
      body = await readJson(c);
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }

    let type: ClientCommandType;
    try {
      type = commandType(body.type ?? body.kind);
    } catch (err) {
      const e = err as ClientInputError;
      return c.json({ error: e.message }, errorStatus(e));
    }

    const payload = body.payload ?? body.input ?? {};
    const idempotencyKey =
      (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) ||
      c.req.header('Idempotency-Key') ||
      null;
    const replay = await findCommandByIdempotencyKey(c.env, user.id, idempotencyKey);
    if (replay) return c.json({ command: replay, replayed: true }, 200);

    const command = await createCommand(c.env, { userId: user.id, type, payload, idempotencyKey });
    await updateCommandStatus(c.env, user.id, command.id, 'running');
    try {
      const result = await executeCommand(c.env, user, type, payload);
      const done = await updateCommandStatus(c.env, user.id, command.id, 'succeeded', { result });
      return c.json({ command: done, result }, 201);
    } catch (err) {
      const e = err as ClientInputError;
      const failed = await updateCommandStatus(c.env, user.id, command.id, 'failed', { error: e.message });
      return c.json({ command: failed, error: e.message }, errorStatus(e));
    }
  });

  return r;
}
