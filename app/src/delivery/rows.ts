/**
 * src/delivery/rows.ts
 * OWNER: delivery agent (helper)
 *
 * Row <-> domain mappers shared by the delivery + admin modules. D1 stores
 * SQLite scalars (TEXT/INTEGER/REAL); these helpers translate raw rows into the
 * camelCase domain shapes declared in shared/types.ts and back again. Kept
 * dependency-free and pure so they are trivially unit-testable.
 */

import type {
  Chamber,
  DeliveryChannel,
  Filing,
  Owner,
  Subscription,
  SubscriptionFilters,
  Transaction,
  TxSource,
  TxType,
} from '../shared/types';
import { parseJson, toBool } from '../shared/db';

// ---------------------------------------------------------------------------
// Raw row shapes (mirror the D1 column names in migrations/0001_init.sql)
// ---------------------------------------------------------------------------

export interface TransactionRow {
  id: string;
  doc_id: string;
  filer_id: string | null;
  tx_date: string | null;
  owner: string | null;
  asset_name: string | null;
  ticker: string | null;
  asset_type: string | null;
  tx_type: string | null;
  amount_min: number | null;
  amount_max: number | null;
  is_option: number | null;
  cap_gains_over_200: number | null;
  raw_text: string | null;
  confidence: number | null;
  source: string | null;
  created_at: string | null;
  cursor_seq: number | null;
}

/**
 * A transaction row with the filer's identity joined in (LEFT JOIN filers).
 * Used by the dashboard feed + SSE stream so each row can show a resolved
 * member name + headshot. The filer columns are nullable: transactions.filer_id
 * may be null or may not resolve to a filers row (e.g. seed/backfill rows).
 */
export interface FeedTransactionRow extends TransactionRow {
  filer_full_name: string | null;
  filer_state: string | null;
  filer_photo_url: string | null;
  filing_filed_date: string | null;
  filing_first_seen_at: string | null;
}

export interface SubscriptionRow {
  id: string;
  client_id: string | null;
  delivery: string | null;
  target_url: string | null;
  secret: string | null;
  filters: string | null;
  cursor: number | null;
  active: number | null;
  created_at: string | null;
}

export interface FilingRow {
  doc_id: string;
  chamber: string | null;
  filer_id: string | null;
  filing_type: string | null;
  filed_date: string | null;
  source_url: string | null;
  raw_object_key: string | null;
  ingest_status: string | null;
  doc_kind: string | null;
  extractor: string | null;
  model_version: string | null;
  confidence: number | null;
  first_seen_at: string | null;
  source_updated_at: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    docId: row.doc_id,
    filerId: row.filer_id,
    txDate: row.tx_date,
    owner: (row.owner as Owner | null) ?? null,
    assetName: row.asset_name ?? '',
    ticker: row.ticker,
    assetType: row.asset_type,
    txType: (row.tx_type as TxType) ?? 'P',
    amountMin: row.amount_min,
    amountMax: row.amount_max,
    isOption: toBool(row.is_option),
    capGainsOver200: toBool(row.cap_gains_over_200),
    rawText: row.raw_text ?? '',
    confidence: row.confidence ?? 0,
    source: (row.source as TxSource) ?? 'primary',
    createdAt: row.created_at ?? '',
    cursorSeq: row.cursor_seq ?? 0,
  };
}

/**
 * Map a feed row (transaction + joined filer identity) to a Transaction,
 * carrying the resolved member name/state/headshot. Kept separate from
 * mapTransaction so the webhook/normalizer paths (which never join filers) are
 * unaffected.
 */
export function mapFeedTransaction(row: FeedTransactionRow): Transaction {
  return {
    ...mapTransaction(row),
    fullName: row.filer_full_name,
    state: row.filer_state,
    photoUrl: row.filer_photo_url,
    filedDate: row.filing_filed_date,
    firstSeenAt: row.filing_first_seen_at,
  };
}

export function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    clientId: row.client_id ?? '',
    delivery: (row.delivery as DeliveryChannel) ?? 'webhook',
    targetUrl: row.target_url,
    secret: row.secret,
    filters: parseJson<SubscriptionFilters>(row.filters, {}),
    cursor: row.cursor ?? 0,
    active: toBool(row.active),
    createdAt: row.created_at ?? '',
  };
}

export function mapFiling(row: FilingRow): Filing {
  return {
    docId: row.doc_id,
    chamber: (row.chamber as Chamber) ?? 'house',
    filerId: row.filer_id,
    filingType: row.filing_type ?? 'P',
    filedDate: row.filed_date,
    sourceUrl: row.source_url ?? '',
    rawObjectKey: row.raw_object_key,
    ingestStatus: (row.ingest_status as Filing['ingestStatus']) ?? 'new',
    docKind: (row.doc_kind as Filing['docKind']) ?? 'unknown',
    extractor: row.extractor,
    modelVersion: row.model_version,
    confidence: row.confidence,
    firstSeenAt: row.first_seen_at ?? '',
    sourceUpdatedAt: row.source_updated_at,
    error: row.error,
  };
}

// ---------------------------------------------------------------------------
// Transactions query builder (the REST `?since=` cursor backstop)
// ---------------------------------------------------------------------------

export interface TxQueryParams {
  since?: number;
  ticker?: string;
  member?: string;
  chamber?: Chamber;
  type?: TxType;
  limit?: number;
  /**
   * Freemium gate: only rows whose filing date (or, lacking a filing, trade
   * date) is on/after this `YYYY-MM-DD` are returned. Applied to both the feed
   * and the count, so non-premium visitors see a consistent recent window.
   */
  filedSince?: string;
}

export interface BuiltQuery {
  sql: string;
  params: Array<string | number>;
  limit: number;
}

/** Default and hard-cap page sizes for the transactions endpoint. */
export const DEFAULT_TX_LIMIT = 100;
export const MAX_TX_LIMIT = 500;

/**
 * Freemium gate for non-premium visitors: only the most recent
 * FREE_WINDOW_DAYS of trades, capped at FREE_TX_LIMIT rows per page. Premium
 * subscribers get full history up to MAX_TX_LIMIT. See delivery/rest.ts.
 */
export const FREE_WINDOW_DAYS = 30;
export const FREE_TX_LIMIT = 50;

/**
 * Shared FROM/JOIN clause for the transactions feed. Chamber + member name are
 * resolved primarily through the `filers` table (joined on bioguide_id), which
 * is the authoritative source for the seed dataset — those rows have no owning
 * `filings` row, so a filings-only chamber join would silently drop them. We
 * also LEFT JOIN `filings` and COALESCE the chamber so live pipeline rows
 * (which DO have a filing) still resolve when the filer meta is missing.
 */
const TX_FROM_JOINS =
  'FROM transactions t ' +
  'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
  'LEFT JOIN filings f ON f.doc_id = t.doc_id ';

/** SQL expression resolving the chamber, preferring the filers table. */
const CHAMBER_EXPR = 'COALESCE(fl.chamber, f.chamber)';

/**
 * Build the shared WHERE clauses + bound params for the transactions feed.
 * `includeCursor` controls whether the `cursor_seq > since` backstop clause is
 * added — the count query omits it so it reports ALL rows matching the
 * ticker/member/type/chamber filters (independent of paging position).
 */
function buildTxFilters(
  p: TxQueryParams,
  includeCursor: boolean,
): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (includeCursor) {
    const since = Number.isFinite(p.since) ? Number(p.since) : 0;
    where.push('t.cursor_seq > ?');
    params.push(since);
  }

  if (p.ticker) {
    where.push('t.ticker = ?');
    params.push(p.ticker.toUpperCase());
  }
  if (p.member) {
    where.push('t.filer_id = ?');
    params.push(p.member);
  }
  if (p.type) {
    where.push('t.tx_type = ?');
    params.push(p.type);
  }
  if (p.chamber) {
    where.push(`${CHAMBER_EXPR} = ?`);
    params.push(p.chamber);
  }
  if (p.filedSince) {
    // Prefer the filing date; seed rows without a filing fall back to tx_date.
    where.push('COALESCE(f.filed_date, t.tx_date) >= ?');
    params.push(p.filedSince);
  }

  return { where, params };
}

/**
 * Build the parameterized SQL for `GET /transactions`. Always orders by
 * cursor_seq ASC (so callers can use the max returned cursor to page forward)
 * and only returns rows with cursor_seq > since (the reconciliation backstop).
 *
 * `chamber` is resolved via the `filers` table (authoritative for seed data),
 * falling back to the owning filing's chamber. The member's full name and
 * resolved chamber are SELECTed alongside `t.*` as `__member_name`/`__chamber`
 * so the REST handler can attach them without changing the Transaction type.
 *
 * Pure + deterministic so it can be unit-tested without a DB.
 */
export function buildTransactionsQuery(p: TxQueryParams): BuiltQuery {
  const { where, params } = buildTxFilters(p, true);

  let limit = Number.isFinite(p.limit) ? Number(p.limit) : DEFAULT_TX_LIMIT;
  if (limit <= 0) limit = DEFAULT_TX_LIMIT;
  if (limit > MAX_TX_LIMIT) limit = MAX_TX_LIMIT;

  const sql =
    `SELECT t.*, ${CHAMBER_EXPR} AS __chamber, fl.full_name AS __member_name, ` +
    'fl.full_name AS filer_full_name, fl.state AS filer_state, ' +
    'fl.photo_url AS filer_photo_url, ' +
    'f.filed_date AS filing_filed_date, f.first_seen_at AS filing_first_seen_at ' +
    TX_FROM_JOINS +
    `WHERE ${where.join(' AND ')} ` +
    'ORDER BY t.cursor_seq ASC ' +
    `LIMIT ${limit}`;

  return { sql, params, limit };
}

/**
 * Build the COUNT(*) companion query for `GET /transactions`. Uses the SAME
 * ticker/member/type/chamber filters as {@link buildTransactionsQuery} but
 * deliberately drops the cursor backstop so the total reflects every matching
 * row, not just the unseen tail. Returned as `total` in the API response.
 */
export function buildTransactionsCountQuery(
  p: TxQueryParams,
): { sql: string; params: Array<string | number> } {
  const { where, params } = buildTxFilters(p, false);
  const sql =
    'SELECT COUNT(*) AS total ' +
    TX_FROM_JOINS +
    (where.length ? `WHERE ${where.join(' AND ')}` : '');
  return { sql, params };
}

/** Hard cap on rows in a single CSV export (premium full-history download). */
export const MAX_EXPORT_ROWS = 50000;

/**
 * Build the query backing the premium CSV export. Unlike the paged feed it
 * drops the cursor backstop (exports the full matching set), orders newest-first
 * for a readable download, and allows up to `maxRows` (>> MAX_TX_LIMIT). The
 * same ticker/member/type/chamber filters apply; `filedSince` is normally unset
 * for premium callers but is honored if provided.
 */
export function buildTransactionsExportQuery(
  p: TxQueryParams,
  maxRows = MAX_EXPORT_ROWS,
): BuiltQuery {
  const { where, params } = buildTxFilters(p, false);
  let limit = Number.isFinite(maxRows) ? Number(maxRows) : MAX_EXPORT_ROWS;
  if (limit <= 0 || limit > MAX_EXPORT_ROWS) limit = MAX_EXPORT_ROWS;
  const sql =
    `SELECT t.*, ${CHAMBER_EXPR} AS __chamber, fl.full_name AS __member_name, ` +
    'fl.full_name AS filer_full_name, fl.state AS filer_state, ' +
    'fl.photo_url AS filer_photo_url, ' +
    'f.filed_date AS filing_filed_date, f.first_seen_at AS filing_first_seen_at ' +
    TX_FROM_JOINS +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    'ORDER BY t.cursor_seq DESC ' +
    `LIMIT ${limit}`;
  return { sql, params, limit };
}
