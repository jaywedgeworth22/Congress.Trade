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
import { all, get, parseJson } from '../shared/db';
import { getCurrentUserFromRequest } from '../auth/session';
import { entitlementOf } from '../billing/entitlement';
import {
  buildTransactionsCountQuery,
  buildTransactionsQuery,
  mapFeedTransaction,
  type FeedTransactionRow,
  type TxQueryParams,
} from '../delivery/rows';
import { canonicalizeAssetType } from '../shared/assetTypes';
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
type ClientTradeRow = FeedTransactionRow & {
  __chamber?: string | null;
  __member_name?: string | null;
  __party?: string | null;
};

type ClientTradeListEnvelope = {
  items: ClientTrade[];
  cursor: number;
  count: number;
  total: number;
  limit: number;
};

type TradeSummaryRow = {
  total_trades: number | string | null;
  buy_count: number | string | null;
  sell_count: number | string | null;
  exchange_count: number | string | null;
  member_count?: number | string | null;
  unique_tickers?: number | string | null;
  unique_assets?: number | string | null;
  est_volume: number | string | null;
  est_net_flow: number | string | null;
  first_trade: string | null;
  last_trade: string | null;
};

type SecurityRefRow = {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  asset_class: string | null;
  country: string | null;
  exchange_short: string | null;
  currency: string | null;
  market_cap: number | string | null;
  market_cap_bucket: string | null;
  current_price?: number | string | null;
  current_price_date?: string | null;
};

type MemberProfileRow = {
  bioguide_id: string;
  chamber: string | null;
  full_name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  committees: string | null;
  photo_url: string | null;
};
type ResolvedMember = {
  id: string;
  profile: MemberProfileRow | null;
};

const SUBSCRIPTION_COLS =
  'id, client_id, delivery, target_url, secret, filters, cursor, active, created_at';
const CLIENT_TRADE_SELECT =
  'SELECT t.*, COALESCE(fl.chamber, f.chamber) AS __chamber, fl.full_name AS __member_name, fl.party AS __party, ' +
  'fl.full_name AS filer_full_name, fl.state AS filer_state, ' +
  'fl.photo_url AS filer_photo_url, ' +
  'sr.company_name AS ref_company_name, sr.sector AS ref_sector, sr.market_cap AS ref_market_cap, ' +
  'sr.market_cap_bucket AS ref_market_cap_bucket, sr.country AS ref_country, ' +
  'sr.exchange_short AS ref_exchange_short, sr.asset_class AS ref_asset_class, ' +
  'f.filed_date AS filing_filed_date, f.first_seen_at AS filing_first_seen_at, f.source_url AS filing_source_url ' +
  'FROM transactions t ' +
  'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
  'LEFT JOIN filings f ON f.doc_id = t.doc_id ' +
  'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ';
const CLIENT_TRADE_BY_ID_SQL = CLIENT_TRADE_SELECT + 'WHERE t.deprecated_at IS NULL AND t.id = ? LIMIT 1';
const EST_VALUE_SQL =
  '(CASE ' +
  'WHEN t.amount_min IS NULL AND t.amount_max IS NULL THEN 0 ' +
  'WHEN t.amount_min IS NULL THEN t.amount_max ' +
  'WHEN t.amount_max IS NULL THEN t.amount_min ' +
  'ELSE (t.amount_min + t.amount_max) / 2.0 END)';

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

function persistedCommandResult(type: ClientCommandType, result: unknown): unknown {
  if (type !== 'create_subscription' || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const root = result as { subscription?: unknown };
  if (!root.subscription || typeof root.subscription !== 'object' || Array.isArray(root.subscription)) {
    return result;
  }
  return {
    ...root,
    subscription: publicSubscription(root.subscription as Subscription),
  };
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

function clientTradeFromRow(row: ClientTradeRow): ClientTrade {
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
    source: (tx.source === 'manual' ? 'primary' : tx.source) as "primary" | "seed_dataset",
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function usd(value: unknown): number {
  return Math.round(num(value));
}

function detailLimit(value: string | undefined, fallback = 25): number {
  const n = parseIntOrUndef(value);
  if (!n || n <= 0) return fallback;
  return Math.min(n, 100);
}

function tickerSummarySql(ticker: string): { sql: string; params: string[] } {
  return {
    sql:
      'SELECT COUNT(*) AS total_trades, ' +
      "SUM(CASE WHEN t.tx_type = 'P' THEN 1 ELSE 0 END) AS buy_count, " +
      "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END) AS sell_count, " +
      "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
      'COUNT(DISTINCT t.filer_id) AS member_count, ' +
      `SUM(${EST_VALUE_SQL}) AS est_volume, ` +
      `SUM(CASE WHEN t.tx_type = 'P' THEN ${EST_VALUE_SQL} WHEN t.tx_type = 'S' THEN -${EST_VALUE_SQL} ELSE 0 END) AS est_net_flow, ` +
      'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
      'FROM transactions t WHERE t.deprecated_at IS NULL AND t.ticker = ?',
    params: [ticker],
  };
}

function memberSummarySql(memberId: string): { sql: string; params: string[] } {
  return {
    sql:
      'SELECT COUNT(*) AS total_trades, ' +
      "SUM(CASE WHEN t.tx_type = 'P' THEN 1 ELSE 0 END) AS buy_count, " +
      "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END) AS sell_count, " +
      "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
      "COUNT(DISTINCT CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN t.ticker END) AS unique_tickers, " +
      "COUNT(DISTINCT COALESCE(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN t.ticker END, NULLIF(t.asset_name, ''))) AS unique_assets, " +
      `SUM(${EST_VALUE_SQL}) AS est_volume, ` +
      `SUM(CASE WHEN t.tx_type = 'P' THEN ${EST_VALUE_SQL} WHEN t.tx_type = 'S' THEN -${EST_VALUE_SQL} ELSE 0 END) AS est_net_flow, ` +
      'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
      'FROM transactions t WHERE t.deprecated_at IS NULL AND t.filer_id = ?',
    params: [memberId],
  };
}

function baseSummary(row: TradeSummaryRow | null) {
  return {
    totalTrades: num(row?.total_trades),
    buyCount: num(row?.buy_count),
    sellCount: num(row?.sell_count),
    exchangeCount: num(row?.exchange_count),
    estimatedVolumeUsd: usd(row?.est_volume),
    estimatedNetFlowUsd: usd(row?.est_net_flow),
    firstTrade: str(row?.first_trade),
    lastTrade: str(row?.last_trade),
  };
}

function securityRef(ticker: string, row: SecurityRefRow | null) {
  return {
    ticker,
    companyName: row?.company_name ?? null,
    logoUrl: clientLogoUrl(ticker),
    sector: row?.sector ?? null,
    industry: row?.industry ?? null,
    assetClass: row?.asset_class ?? null,
    country: row?.country ?? null,
    exchangeShort: row?.exchange_short ?? null,
    currency: row?.currency ?? null,
    marketCap: nullableNum(row?.market_cap),
    marketCapBucket: row?.market_cap_bucket ?? null,
    currentPrice: nullableNum(row?.current_price),
    currentPriceDate: row?.current_price_date ?? null,
  };
}

function memberProfile(row: MemberProfileRow | null, id: string) {
  if (!row) {
    return {
      id,
      name: null,
      chamber: null,
      party: null,
      state: null,
      district: null,
      committees: [],
      photoUrl: null,
    };
  }
  const committees = parseJson<string[]>(row.committees, []);
  return {
    id: row.bioguide_id,
    name: row.full_name,
    chamber: asChamber(row.chamber ?? undefined) ?? null,
    party: row.party,
    state: row.state,
    district: row.district,
    committees: Array.isArray(committees) ? committees : [],
    photoUrl: row.photo_url,
  };
}

async function readClientTradeList(env: Env, params: TxQueryParams): Promise<ClientTradeListEnvelope> {
  const built = buildTransactionsQuery(params);
  const rows = await all<ClientTradeRow>(env.DB, built.sql, built.params);
  const items = rows.map(clientTradeFromRow);
  const maxCursor = items.reduce((m, t) => (t.cursor > m ? t.cursor : m), params.since ?? 0);
  const countQuery = buildTransactionsCountQuery(params);
  const countRow = await get<{ total: number | string | null }>(env.DB, countQuery.sql, countQuery.params);
  return {
    items,
    cursor: maxCursor,
    count: items.length,
    total: num(countRow?.total ?? items.length),
    limit: built.limit,
  };
}

async function getClientTrade(env: Env, id: string): Promise<ClientTrade | null> {
  const row = await get<ClientTradeRow>(env.DB, CLIENT_TRADE_BY_ID_SQL, [id]);
  return row ? clientTradeFromRow(row) : null;
}

async function getSecurityRef(env: Env, ticker: string): Promise<SecurityRefRow | null> {
  return get<SecurityRefRow>(
    env.DB,
    'SELECT ticker, company_name, sector, industry, asset_class, country, exchange_short, currency, market_cap, market_cap_bucket, current_price, current_price_date FROM securities_ref WHERE ticker = ?',
    [ticker],
  );
}

async function resolveMember(env: Env, value: string): Promise<ResolvedMember | null> {
  const term = value.trim();
  const byId = await get<MemberProfileRow>(
    env.DB,
    'SELECT bioguide_id, chamber, full_name, party, state, district, committees, photo_url FROM filers WHERE LOWER(bioguide_id) = LOWER(?) LIMIT 1',
    [term],
  );
  if (byId) return { id: byId.bioguide_id, profile: byId };
  const byName = await get<MemberProfileRow>(
    env.DB,
    'SELECT bioguide_id, chamber, full_name, party, state, district, committees, photo_url FROM filers WHERE LOWER(full_name) = LOWER(?) OR LOWER(full_name) LIKE ? ORDER BY CASE WHEN LOWER(full_name) = LOWER(?) THEN 0 ELSE 1 END, full_name LIMIT 1',
    [term, `%${term.toLowerCase()}%`, term],
  );
  if (byName) return { id: byName.bioguide_id, profile: byName };
  if (/^[A-Za-z0-9_-]{1,64}$/.test(term)) return { id: term, profile: null };
  return null;
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
        trade: '/api/client/v1/trade/:id',
        ticker: '/api/client/v1/ticker/:ticker',
        member: '/api/client/v1/member/:memberIdOrName',
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
    return c.json({ ...(await readClientTradeList(c.env, params)), nextPollAfterSec: 30 });
  });

  r.get('/trade/:id', async (c) => {
    const id = (c.req.param('id') || '').trim();
    if (!id || id.length > 128) return c.json({ error: 'invalid trade id' }, 400);
    const item = await getClientTrade(c.env, id);
    if (!item) return c.json({ error: 'trade not found' }, 404);
    return c.json({
      item,
      items: [item],
      cursor: item.cursor,
      count: 1,
      total: 1,
      limit: 1,
    });
  });

  r.get('/ticker/:ticker', async (c) => {
    const ticker = normalizeTickerLogoSymbol(c.req.param('ticker'));
    if (!ticker) return c.json({ error: 'invalid ticker' }, 400);
    const params: TxQueryParams = {
      ticker,
      limit: detailLimit(c.req.query('limit')),
      order: asOrder(c.req.query('order')) ?? 'desc',
    };
    const summaryQ = tickerSummarySql(ticker);
    const [list, summaryRow, refRow] = await Promise.all([
      readClientTradeList(c.env, params),
      get<TradeSummaryRow>(c.env.DB, summaryQ.sql, summaryQ.params),
      getSecurityRef(c.env, ticker),
    ]);
    return c.json({
      ticker,
      asset: securityRef(ticker, refRow),
      summary: {
        ...baseSummary(summaryRow),
        memberCount: num(summaryRow?.member_count),
      },
      ...list,
    });
  });

  r.get('/member/:memberIdOrName', async (c) => {
    const memberIdOrName = (c.req.param('memberIdOrName') || '').trim();
    if (!memberIdOrName || memberIdOrName.length > 120) {
      return c.json({ error: 'invalid member id or name' }, 400);
    }
    const resolved = await resolveMember(c.env, memberIdOrName);
    if (!resolved) return c.json({ error: 'member not found' }, 404);
    const params: TxQueryParams = {
      member: resolved.id,
      limit: detailLimit(c.req.query('limit')),
      order: asOrder(c.req.query('order')) ?? 'desc',
    };
    const summaryQ = memberSummarySql(resolved.id);
    const [list, summaryRow] = await Promise.all([
      readClientTradeList(c.env, params),
      get<TradeSummaryRow>(c.env.DB, summaryQ.sql, summaryQ.params),
    ]);
    if (!resolved.profile && list.total === 0) return c.json({ error: 'member not found' }, 404);
    return c.json({
      member: memberProfile(resolved.profile, resolved.id),
      summary: {
        ...baseSummary(summaryRow),
        uniqueTickers: num(summaryRow?.unique_tickers),
        uniqueAssets: num(summaryRow?.unique_assets),
      },
      ...list,
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
      const done = await updateCommandStatus(c.env, user.id, command.id, 'succeeded', {
        result: persistedCommandResult(type, result),
      });
      return c.json({ command: done, result }, 201);
    } catch (err) {
      const e = err as ClientInputError;
      const failed = await updateCommandStatus(c.env, user.id, command.id, 'failed', { error: e.message });
      return c.json({ command: failed, error: e.message }, errorStatus(e));
    }
  });

  return r;
}
