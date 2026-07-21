import type { Chamber, TxType, DeliveryChannel, SubscriptionFilters, Subscription, ClientTrade, User } from '../shared/types.ts';
import { normalizeTickerLogoSymbol } from '../ui/tickerLogos.ts';
import { mapFeedTransaction } from '../delivery/rows.ts';
import type { TxQueryParams } from '../delivery/rows.ts';
import type { ClientTradeRow, TradeSummaryRow, SecurityRefRow, MemberProfileRow } from './types.ts';
import { parseJson } from '../shared/db.ts';
import type { Context } from 'hono';
import type { Env } from '../shared/types.ts';
import { getCurrentUserFromRequest } from '../auth/session.ts';
import { validateSubscriptionFilters } from '../delivery/subscriptions.ts';

export type ClientContext = Context<{ Bindings: Env }>;

export class ClientInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type ClientErrorStatus = 400 | 401 | 402 | 404 | 409 | 429 | 500 | 501;

export function errorStatus(err: ClientInputError): ClientErrorStatus {
  if (err.status === 401 || err.status === 402 || err.status === 404 || err.status === 409 || err.status === 429 || err.status === 501) {
    return err.status;
  }
  if (err.status === 400) return 400;
  return 500;
}

export async function readJson(c: ClientContext): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.text();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new ClientInputError('invalid JSON body');
  }
}

export async function requireUser(c: ClientContext): Promise<User> {
  const user = await getCurrentUserFromRequest(c);
  if (!user) throw new ClientInputError('sign in required', 401);
  return user;
}

export function clientIdForUser(user: User): string {
  return `user:${user.id}`;
}

export function parseIntOrUndef(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function asChamber(v: string | undefined): Chamber | undefined {
  return v === 'house' || v === 'senate' || v === 'executive' ? v : undefined;
}

/**
 * Parse a CSV chamber selection (e.g. "house,executive"). Returns undefined
 * for absent/empty/fully-invalid input — the DEFAULT, which the feed queries
 * treat as house+senate (executive rows require explicit opt-in).
 */
export function asChambers(v: string | undefined): Chamber[] | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asChamber(part.trim())).filter((c): c is Chamber => !!c)),
  ).sort();
  return parsed.length ? parsed : undefined;
}

export function asTxType(v: string | undefined): TxType | undefined {
  return v === 'P' || v === 'S' || v === 'E' ? v : undefined;
}

export function asOrder(v: string | undefined): 'asc' | 'desc' | undefined {
  return v === 'desc' ? 'desc' : v === 'asc' ? 'asc' : undefined;
}

export function asSort(v: string | undefined): TxQueryParams['sort'] {
  return v === 'published' ? 'published' : v === 'cursor' ? 'cursor' : undefined;
}

export function asNonNegativeNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function asDelivery(v: unknown): DeliveryChannel {
  if (v === 'sse' || v === undefined || v === null || v === '') return 'sse';
  if (v === 'webhook') return 'webhook';
  throw new ClientInputError("delivery must be 'sse' or 'webhook'");
}

export function arrayOfStrings(value: unknown, opts: { upper?: boolean } = {}): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ClientInputError('filters arrays must contain strings');
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (opts.upper ? v.toUpperCase() : v));
  return Array.from(new Set(out));
}

export function normalizeFilters(value: unknown): SubscriptionFilters {
  const result = validateSubscriptionFilters(value);
  if (!result.ok) throw new ClientInputError(result.error);
  return result.filters;
}

export function publicSubscription(sub: Subscription, includeSecret = false): Record<string, unknown> {
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

export function filtersFromQuery(q: Record<string, string>): TxQueryParams {
  return {
    since: parseIntOrUndef(q.since),
    ticker: q.ticker || undefined,
    member: q.member || undefined,
    memberName: q.memberName || undefined,
    chambers: asChambers(q.chamber),
    type: asTxType(q.type),
    minAmount: asNonNegativeNumber(q.minAmount),
    maxAmount: asNonNegativeNumber(q.maxAmount),
    txDateMin: q.from || q.txDateMin || undefined,
    txDateMax: q.to || q.txDateMax || undefined,
    sort: asSort(q.sort),
    order: asOrder(q.order),
    limit: parseIntOrUndef(q.limit),
  };
}

export function clientLogoUrl(ticker: string | null): string | null {
  const symbol = normalizeTickerLogoSymbol(ticker);
  return symbol ? `/api/logos/ticker?symbol=${encodeURIComponent(symbol)}` : null;
}

export function clientTradeFromRow(row: ClientTradeRow): ClientTrade {
  const tx = mapFeedTransaction(row);
  const transaction = {
    date: tx.txDate,
    type: tx.txType,
    owner: tx.owner,
    amountMin: tx.amountMin,
    amountMax: tx.amountMax,
    estValue: row.est_value ?? null,
    isOption: tx.isOption,
  };
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
      name: tx.refCompanyName || tx.assetName,
      ticker: tx.ticker,
      type: tx.assetType,
      sector: tx.refSector ?? null,
      marketCapBucket: tx.refMarketCapBucket ?? null,
    },
    transaction,
    filing: {
      filedDate: tx.filedDate ?? null,
      firstSeenAt: tx.firstSeenAt ?? null,
      sourceUrl: tx.sourceUrl ?? null,
    },
    confidence: tx.confidence,
    source: (tx.source === 'manual' ? 'primary' : tx.source) as "primary" | "seed_dataset",
  };
}

export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

export function usd(value: unknown): number {
  return Math.round(num(value));
}

export function detailLimit(value: string | undefined, fallback = 25): number {
  const n = parseIntOrUndef(value);
  if (!n || n <= 0) return fallback;
  return Math.min(n, 100);
}

export function baseSummary(row: TradeSummaryRow | null) {
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

export function securityRef(ticker: string, row: SecurityRefRow | null) {
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

export function memberProfile(row: MemberProfileRow | null, id: string) {
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
