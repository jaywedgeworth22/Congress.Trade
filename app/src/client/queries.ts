import type { Env, Subscription, User } from '../shared/types';
import { all, first, get } from '../shared/db';
import {
  buildTransactionsCountQuery,
  buildTransactionsQuery,
  escapeLikePattern,
  mapSubscription,
} from '../delivery/rows';
import type { SubscriptionRow, TxQueryParams } from '../delivery/rows';
import type {
  ClientTradeListEnvelope,
  ClientTradeRow,
  MemberProfileRow,
  ResolvedMember,
  SecurityRefRow,
} from './types';
import {
  clientTradeFromRow,
  clientIdForUser,
  ClientInputError,
  num,
} from './utils';
import { getSubscription } from '../delivery/subscriptions';
import type { ClientTrade } from '../shared/types';

export const SUBSCRIPTION_COLS =
  'id, client_id, delivery, target_url, secret, filters, cursor, active, created_at';

export const CLIENT_TRADE_SELECT =
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

export const CLIENT_TRADE_BY_ID_SQL =
  CLIENT_TRADE_SELECT + 'WHERE t.deprecated_at IS NULL AND t.id = ? LIMIT 1';

export function tickerSummarySql(ticker: string): { sql: string; params: string[] } {
  return {
    sql:
      'SELECT COUNT(*) AS total_trades, ' +
      "SUM(CASE WHEN t.tx_type = 'P' THEN 1 ELSE 0 END) AS buy_count, " +
      "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END) AS sell_count, " +
      "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
      'COUNT(DISTINCT t.filer_id) AS member_count, ' +
      `SUM(t.est_value) AS est_volume, ` +
      `SUM(CASE WHEN t.tx_type = 'P' THEN t.est_value WHEN t.tx_type = 'S' THEN -t.est_value ELSE 0 END) AS est_net_flow, ` +
      'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
      'FROM transactions t WHERE t.deprecated_at IS NULL AND t.ticker = ?',
    params: [ticker],
  };
}

export function memberSummarySql(memberId: string): { sql: string; params: string[] } {
  return {
    sql:
      'SELECT COUNT(*) AS total_trades, ' +
      "SUM(CASE WHEN t.tx_type = 'P' THEN 1 ELSE 0 END) AS buy_count, " +
      "SUM(CASE WHEN t.tx_type = 'S' THEN 1 ELSE 0 END) AS sell_count, " +
      "SUM(CASE WHEN t.tx_type = 'E' THEN 1 ELSE 0 END) AS exchange_count, " +
      "COUNT(DISTINCT CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN t.ticker END) AS unique_tickers, " +
      "COUNT(DISTINCT COALESCE(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN t.ticker END, NULLIF(t.asset_name, ''))) AS unique_assets, " +
      `SUM(t.est_value) AS est_volume, ` +
      `SUM(CASE WHEN t.tx_type = 'P' THEN t.est_value WHEN t.tx_type = 'S' THEN -t.est_value ELSE 0 END) AS est_net_flow, ` +
      'MIN(t.tx_date) AS first_trade, MAX(t.tx_date) AS last_trade ' +
      'FROM transactions t WHERE t.deprecated_at IS NULL AND t.filer_id = ?',
    params: [memberId],
  };
}

export async function readClientTradeList(env: Env, params: TxQueryParams): Promise<ClientTradeListEnvelope> {
  const built = buildTransactionsQuery(params);
  const rows = await all<ClientTradeRow>(env.DB, built.sql, built.params);
  const items = rows.map(clientTradeFromRow);
  const maxCursor = items.reduce((m, t) => (t.cursor > m ? t.cursor : m), params.since ?? 0);

  // Zero-delta incremental poll: a `?since=` cursor that comes back with no
  // new rows is the steady-state case for both known clients (the dashboard's
  // fetchUpdates() and the PWA's poll() both bail out — `if (!txs.length)
  // return` / `if (delta.items.length > 0)` — before ever reading `total` on
  // an empty delta). Skip the full unindexed COUNT(*) scan entirely rather
  // than paying D1 read cost for a number no conforming client observes.
  // `total` is omitted here (not falsely reported as 0) so a future consumer
  // that reads it on every poll can tell "not computed this round" apart from
  // "actually zero".
  if (params.since !== undefined && items.length === 0) {
    return { items, cursor: maxCursor, count: 0, limit: built.limit };
  }

  const countQuery = buildTransactionsCountQuery(params);
  const countRow = await first<{ total: number | string | null }>(env.DB, countQuery.sql, countQuery.params);
  return {
    items,
    cursor: maxCursor,
    count: items.length,
    total: num(countRow?.total ?? items.length),
    limit: built.limit,
  };
}

export async function getClientTrade(env: Env, id: string): Promise<ClientTrade | null> {
  const row = await get<ClientTradeRow>(env.DB, CLIENT_TRADE_BY_ID_SQL, [id]);
  return row ? clientTradeFromRow(row) : null;
}

export async function getSecurityRef(env: Env, ticker: string): Promise<SecurityRefRow | null> {
  return get<SecurityRefRow>(
    env.DB,
    'SELECT ticker, company_name, sector, industry, asset_class, country, exchange_short, currency, market_cap, market_cap_bucket, current_price, current_price_date FROM securities_ref WHERE ticker = ?',
    [ticker],
  );
}

export async function resolveMember(env: Env, value: string): Promise<ResolvedMember | null> {
  const term = value.trim();
  const byId = await get<MemberProfileRow>(
    env.DB,
    'SELECT bioguide_id, chamber, full_name, party, state, district, committees, photo_url FROM filers WHERE LOWER(bioguide_id) = LOWER(?) LIMIT 1',
    [term],
  );
  if (byId) return { id: byId.bioguide_id, profile: byId };
  const byName = await get<MemberProfileRow>(
    env.DB,
    "SELECT bioguide_id, chamber, full_name, party, state, district, committees, photo_url FROM filers WHERE LOWER(full_name) = LOWER(?) OR LOWER(full_name) LIKE ? ESCAPE '\\' ORDER BY CASE WHEN LOWER(full_name) = LOWER(?) THEN 0 ELSE 1 END, full_name LIMIT 1",
    [term, `%${escapeLikePattern(term.toLowerCase())}%`, term],
  );
  if (byName) return { id: byName.bioguide_id, profile: byName };
  if (/^[A-Za-z0-9_-]{1,64}$/.test(term)) return { id: term, profile: null };
  return null;
}

export async function listUserSubscriptions(env: Env, user: User): Promise<Subscription[]> {
  const rows = await all<SubscriptionRow>(
    env.DB,
    `SELECT ${SUBSCRIPTION_COLS} FROM subscriptions WHERE client_id = ? ORDER BY created_at DESC`,
    [clientIdForUser(user)],
  );
  return rows.map(mapSubscription);
}

export async function getOwnedSubscription(env: Env, user: User, id: string): Promise<Subscription> {
  const sub = await getSubscription(env, id);
  if (!sub || sub.clientId !== clientIdForUser(user)) {
    throw new ClientInputError('subscription not found', 404);
  }
  return sub;
}
