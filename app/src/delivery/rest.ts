/**
 * src/delivery/rest.ts
 * OWNER: delivery agent
 *
 * Read-only REST API over transactions + subscription CRUD. Exposes a Hono
 * router mounted under /api by index.ts. Supports cursor pagination via
 * ?since=<cursor_seq> and filtering by ticker / member / chamber / type.
 *
 * Routes (all relative to /api):
 *   GET   /transactions      cursor-paged transaction feed (reconciliation backstop)
 *   GET   /stream            SSE live stream (delegates to openSseStream)
 *   GET   /filings/:docId    single filing (+ its transactions) for the dashboard
 *   GET   /members           distinct filers seen in transactions
 *   POST  /subscriptions     create a subscription
 *   GET   /subscriptions     list subscriptions
 *   GET   /subscriptions/:id fetch one subscription
 *   PATCH /subscriptions/:id update a subscription
 */

import { Hono } from 'hono';
import type { Chamber, Env, SubscriptionFilters, TxType } from '../shared/types';
import { all, get } from '../shared/db';
import {
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsExportQuery,
  mapFiling,
  mapTransaction,
  mapFeedTransaction,
  FREE_WINDOW_DAYS,
  FREE_TX_LIMIT,
  type FilingRow,
  type TransactionRow,
  type FeedTransactionRow,
  type TxQueryParams,
} from './rows';
import { getCurrentUser } from '../auth/session';
import { isPremiumUser } from '../billing/entitlement';
import {
  createSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
} from './subscriptions';
import { openSseStream } from './sse';
import { handleTickerLogoRequest } from '../ui/tickerLogos';

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

/** `YYYY-MM-DD` for `days` ago (UTC), for the freemium recency gate. */
function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Parse the shared ticker/member/type/chamber filters from the query string. */
function filtersFromQuery(q: Record<string, string>): TxQueryParams {
  return {
    ticker: q.ticker || undefined,
    member: q.member || undefined,
    chamber: asChamber(q.chamber),
    type: asTxType(q.type),
  };
}

/** CSV-escape a single cell (RFC 4180: wrap in quotes, double embedded quotes). */
function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildRestRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /transactions --------------------------------------------------
  // Reconciliation backstop: rows with cursor_seq > since, ASC, plus the max
  // cursor in the page so clients can poll forward deterministically.
  r.get('/transactions', async (c) => {
    const q = c.req.query();
    const premium = isPremiumUser(await getCurrentUser(c));
    const params: TxQueryParams = {
      since: parseIntOrUndef(q.since),
      ticker: q.ticker || undefined,
      member: q.member || undefined,
      chamber: asChamber(q.chamber),
      type: asTxType(q.type),
      limit: parseIntOrUndef(q.limit),
    };
    // Freemium gate: non-premium visitors see only the recent window and a
    // smaller page. The count query honors `filedSince` too, so "X of N" and the
    // Load-more affordance reflect exactly what the visitor can access.
    if (!premium) {
      params.filedSince = isoDateDaysAgo(FREE_WINDOW_DAYS);
      params.limit = Math.min(params.limit ?? FREE_TX_LIMIT, FREE_TX_LIMIT);
    }
    const built = buildTransactionsQuery(params);
    // The query SELECTs the resolved chamber + member name alongside the feed
    // columns via `__chamber` / `__member_name` (see buildTransactionsQuery).
    // mapFeedTransaction maps the filer/filing columns (fullName, state,
    // photoUrl, dates); we then attach the resolved `chamber` / `memberName`,
    // which aren't part of the base Transaction type.
    const rows = await all<
      FeedTransactionRow & { __chamber?: string | null; __member_name?: string | null }
    >(c.env.DB, built.sql, built.params);
    const transactions = rows.map((row) => ({
      ...mapFeedTransaction(row),
      chamber: (row.__chamber as Chamber | null) ?? null,
      memberName: row.__member_name ?? null,
    }));
    const maxCursor = transactions.reduce(
      (m, t) => (t.cursorSeq > m ? t.cursorSeq : m),
      params.since ?? 0,
    );
    // Total = ALL rows matching the same ticker/member/type/chamber filters,
    // ignoring the cursor backstop (so the UI can show "showing X of N").
    const countQuery = buildTransactionsCountQuery(params);
    const countRow = await get<{ total: number }>(c.env.DB, countQuery.sql, countQuery.params);
    const total = countRow?.total ?? transactions.length;
    return c.json({
      transactions,
      cursor: maxCursor,
      count: transactions.length,
      total,
      limit: built.limit,
      premium,
      // When gated, tell the client why so it can surface an upgrade CTA.
      gated: !premium,
      ...(premium ? {} : { freeWindowDays: FREE_WINDOW_DAYS }),
    });
  });

  // --- GET /export/transactions.csv ---------------------------------------
  // Premium-only full-history CSV download. Honors the same ticker/member/
  // type/chamber filters as the feed; non-premium callers get 402 + an upgrade
  // hint so the UI can route them to checkout.
  r.get('/export/transactions.csv', async (c) => {
    if (!isPremiumUser(await getCurrentUser(c))) {
      return c.json({ error: 'premium subscription required', upgradeRequired: true }, 402);
    }
    const built = buildTransactionsExportQuery(filtersFromQuery(c.req.query()));
    const rows = await all<
      FeedTransactionRow & { __chamber?: string | null; __member_name?: string | null }
    >(c.env.DB, built.sql, built.params);

    const header = [
      'filed_at',
      'tx_date',
      'member',
      'chamber',
      'ticker',
      'asset',
      'type',
      'amount_min',
      'amount_max',
      'owner',
      'source',
      'confidence',
      'doc_id',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const t = mapFeedTransaction(row);
      lines.push(
        [
          t.createdAt,
          t.txDate ?? '',
          row.__member_name ?? t.fullName ?? t.filerId ?? '',
          (row.__chamber as string | null) ?? '',
          t.ticker ?? '',
          t.assetName ?? '',
          t.txType,
          t.amountMin ?? '',
          t.amountMax ?? '',
          t.owner ?? '',
          t.source,
          t.confidence,
          t.docId,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const csv = lines.join('\r\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="congress-trades-${isoDateDaysAgo(0)}.csv"`,
      },
    });
  });

  // --- GET /stream --------------------------------------------------------
  r.get('/stream', async (c) => {
    const subscription = c.req.query('subscription');
    if (!subscription) {
      return c.json({ error: 'missing ?subscription=' }, 400);
    }
    const since = parseIntOrUndef(c.req.query('since'));
    return openSseStream(c.env, subscription, since);
  });

  // --- GET /logos/ticker --------------------------------------------------
  // Cached company-logo proxy (see ui/tickerLogos.ts). Reachable at
  // /api/logos/ticker?symbol=AAPL, matching the dashboard's <img> src.
  r.get('/logos/ticker', (c) => handleTickerLogoRequest(new URL(c.req.url)));

  // --- GET /filings/:docId ------------------------------------------------
  r.get('/filings/:docId', async (c) => {
    const docId = c.req.param('docId');
    const filingRow = await get<FilingRow>(
      c.env.DB,
      'SELECT * FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (!filingRow) return c.json({ error: 'filing not found' }, 404);

    const txRows = await all<TransactionRow>(
      c.env.DB,
      'SELECT * FROM transactions WHERE doc_id = ? ORDER BY cursor_seq ASC',
      [docId],
    );
    return c.json({
      filing: mapFiling(filingRow),
      transactions: txRows.map(mapTransaction),
    });
  });

  // --- Market cache reads (cross-app sharing, reverse direction) ----------
  // App A is the always-on system of record; these public, read-only endpoints
  // let a sibling app reuse the FMP-derived data App A has already pulled
  // (cache-aside) instead of spending its own FMP quota. Shapes mirror the
  // POST /api/admin/securities/import payload, so the two apps are symmetric.

  // GET /market/ref/:ticker -> the cached securities_ref row (or 404).
  r.get('/market/ref/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const row = await get<SecurityRefRow>(
      c.env.DB,
      'SELECT * FROM securities_ref WHERE ticker = ?',
      [ticker],
    );
    if (!row) return c.json({ error: 'ticker not found' }, 404);
    return c.json({ ref: mapSecurityRef(row) });
  });

  // GET /market/refs?tickers=AAPL,MSFT,... -> cached refs for many tickers.
  r.get('/market/refs', async (c) => {
    const tickers = (c.req.query('tickers') || '')
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 500);
    if (tickers.length === 0) return c.json({ refs: [] });
    const placeholders = tickers.map(() => '?').join(',');
    const rows = await all<SecurityRefRow>(
      c.env.DB,
      `SELECT * FROM securities_ref WHERE ticker IN (${placeholders})`,
      tickers,
    );
    return c.json({ refs: rows.map(mapSecurityRef) });
  });

  // GET /market/prices/:ticker?from=YYYY-MM-DD&to=YYYY-MM-DD
  //   -> { ticker, closes:[{date,close}], currentPrice, currentPriceDate }.
  r.get('/market/prices/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const { sql, params } = priceRangeQuery('price_eod', ticker, c.req.query('from'), c.req.query('to'));
    const closes = await all<{ date: string; close: number }>(c.env.DB, sql, params);
    const ref = await get<{ current_price: number | null; current_price_date: string | null }>(
      c.env.DB,
      'SELECT current_price, current_price_date FROM securities_ref WHERE ticker = ?',
      [ticker],
    );
    return c.json({
      ticker,
      closes,
      currentPrice: ref?.current_price ?? null,
      currentPriceDate: ref?.current_price_date ?? null,
    });
  });

  // GET /market/spx?from=YYYY-MM-DD&to=YYYY-MM-DD -> S&P 500 cached closes.
  r.get('/market/spx', async (c) => {
    const { sql, params } = priceRangeQuery('spx_eod', null, c.req.query('from'), c.req.query('to'));
    const closes = await all<{ date: string; close: number }>(c.env.DB, sql, params);
    return c.json({ closes });
  });

  // GET /market/bundle/:ticker?from=&to= -> ref + prices + spx in one call.
  r.get('/market/bundle/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const from = c.req.query('from');
    const to = c.req.query('to');
    const refRow = await get<SecurityRefRow>(c.env.DB, 'SELECT * FROM securities_ref WHERE ticker = ?', [ticker]);
    const pq = priceRangeQuery('price_eod', ticker, from, to);
    const closes = await all<{ date: string; close: number }>(c.env.DB, pq.sql, pq.params);
    const sq = priceRangeQuery('spx_eod', null, from, to);
    const spx = await all<{ date: string; close: number }>(c.env.DB, sq.sql, sq.params);
    return c.json({
      ticker,
      ref: refRow ? mapSecurityRef(refRow) : null,
      prices: {
        ticker,
        closes,
        currentPrice: refRow?.current_price ?? null,
        currentPriceDate: refRow?.current_price_date ?? null,
      },
      spx,
    });
  });

  // --- GET /members -------------------------------------------------------
  // Filers that actually appear in the transaction feed, joined to filer meta.
  r.get('/members', async (c) => {
    const rows = await all<{
      filer_id: string;
      full_name: string | null;
      chamber: string | null;
      party: string | null;
      state: string | null;
      district: string | null;
      tx_count: number;
    }>(
      c.env.DB,
      `SELECT t.filer_id AS filer_id,
              f.full_name AS full_name,
              f.chamber   AS chamber,
              f.party     AS party,
              f.state     AS state,
              f.district  AS district,
              COUNT(*)    AS tx_count
         FROM transactions t
         LEFT JOIN filers f ON f.bioguide_id = t.filer_id
        WHERE t.filer_id IS NOT NULL
        GROUP BY t.filer_id
        ORDER BY tx_count DESC`,
    );
    const members = rows.map((row) => ({
      filerId: row.filer_id,
      fullName: row.full_name,
      chamber: row.chamber,
      party: row.party,
      state: row.state,
      district: row.district,
      txCount: row.tx_count,
    }));
    return c.json({ members, count: members.length });
  });

  // --- POST /subscriptions ------------------------------------------------
  r.post('/subscriptions', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const delivery = body.delivery;
    if (delivery !== 'webhook' && delivery !== 'sse') {
      return c.json({ error: "delivery must be 'webhook' or 'sse'" }, 400);
    }
    const clientId = typeof body.clientId === 'string' ? body.clientId : '';
    if (!clientId) return c.json({ error: 'clientId is required' }, 400);

    const targetUrl =
      typeof body.targetUrl === 'string' && body.targetUrl.length > 0 ? body.targetUrl : null;
    if (delivery === 'webhook' && !targetUrl) {
      return c.json({ error: 'targetUrl is required for webhook subscriptions' }, 400);
    }

    const filters: SubscriptionFilters =
      body.filters && typeof body.filters === 'object'
        ? (body.filters as SubscriptionFilters)
        : {};
    const secret = typeof body.secret === 'string' ? body.secret : undefined;

    const sub = await createSubscription(c.env, {
      clientId,
      delivery,
      targetUrl,
      secret: secret ?? null,
      filters,
    });
    return c.json(sub, 201);
  });

  // --- GET /subscriptions -------------------------------------------------
  r.get('/subscriptions', async (c) => {
    const activeOnly = c.req.query('active') === 'true';
    const subs = await listSubscriptions(c.env, activeOnly);
    return c.json({ subscriptions: subs, count: subs.length });
  });

  // --- GET /subscriptions/:id ---------------------------------------------
  r.get('/subscriptions/:id', async (c) => {
    const sub = await getSubscription(c.env, c.req.param('id'));
    if (!sub) return c.json({ error: 'subscription not found' }, 404);
    return c.json(sub);
  });

  // --- PATCH /subscriptions/:id -------------------------------------------
  r.patch('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await getSubscription(c.env, id);
    if (!existing) return c.json({ error: 'subscription not found' }, 404);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const patch: Parameters<typeof updateSubscription>[2] = {};
    if (body.filters && typeof body.filters === 'object') {
      patch.filters = body.filters as SubscriptionFilters;
    }
    if (typeof body.targetUrl === 'string' || body.targetUrl === null) {
      patch.targetUrl = body.targetUrl as string | null;
    }
    if (typeof body.secret === 'string' || body.secret === null) {
      patch.secret = body.secret as string | null;
    }
    if (typeof body.active === 'boolean') {
      patch.active = body.active;
    }
    if (typeof body.cursor === 'number') {
      patch.cursor = body.cursor;
    }

    const updated = await updateSubscription(c.env, id, patch);
    return c.json(updated);
  });

  return r;
}

// --- Market cache read helpers (cross-app sharing) ------------------------

interface SecurityRefRow {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  asset_class: string | null;
  is_etf: number | null;
  is_adr: number | null;
  country: string | null;
  state_hq: string | null;
  state_of_incorp: string | null;
  exchange: string | null;
  exchange_short: string | null;
  currency: string | null;
  market_cap: number | null;
  market_cap_bucket: string | null;
  ipo_date: string | null;
  cik: string | null;
  sic_code: string | null;
  sic_description: string | null;
  source: string | null;
  enriched_at: string | null;
  current_price: number | null;
  current_price_date: string | null;
}

/** Map a securities_ref row to the camelCase shape the import API accepts. */
export function mapSecurityRef(row: SecurityRefRow) {
  return {
    ticker: row.ticker,
    companyName: row.company_name,
    sector: row.sector,
    industry: row.industry,
    assetClass: row.asset_class,
    isEtf: row.is_etf === 1,
    isAdr: row.is_adr === 1,
    country: row.country,
    stateHq: row.state_hq,
    stateOfIncorp: row.state_of_incorp,
    exchange: row.exchange,
    exchangeShort: row.exchange_short,
    currency: row.currency,
    marketCap: row.market_cap,
    marketCapBucket: row.market_cap_bucket,
    ipoDate: row.ipo_date,
    cik: row.cik,
    sicCode: row.sic_code,
    sicDescription: row.sic_description,
    source: row.source,
    enrichedAt: row.enriched_at,
    currentPrice: row.current_price,
    currentPriceDate: row.current_price_date,
  };
}

/**
 * Build an ascending close-series query for price_eod (needs a ticker) or
 * spx_eod (no ticker), with optional inclusive from/to date bounds.
 */
export function priceRangeQuery(
  table: 'price_eod' | 'spx_eod',
  ticker: string | null,
  from?: string,
  to?: string,
): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (table === 'price_eod' && ticker) {
    where.push('ticker = ?');
    params.push(ticker);
  }
  if (from) {
    where.push('date >= ?');
    params.push(from.slice(0, 10));
  }
  if (to) {
    where.push('date <= ?');
    params.push(to.slice(0, 10));
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  return { sql: `SELECT date, close FROM ${table}${clause} ORDER BY date ASC`, params };
}
