/**
 * src/delivery/rest.ts
 * OWNER: delivery agent
 *
 * Read-only REST API over transactions + subscription CRUD. Exposes a Hono
 * router mounted under /api by index.ts. Supports cursor pagination via
 * ?since=<cursor_seq>, a rolling trade-date window via ?from=/?to=
 * (YYYY-MM-DD), and filtering by ticker / member / chamber / type.
 *
 * Routes (all relative to /api):
 *   GET   /transactions      cursor-paged transaction feed (reconciliation backstop)
 *   GET   /stream            SSE live stream (?since= or Last-Event-ID resume)
 *   GET   /filings/:docId    single filing (+ its transactions) for the dashboard
 *   GET   /members           distinct filers seen in transactions
 *   POST  /subscriptions     create a subscription; returns its secret once
 *   GET   /subscriptions     disabled publicly; use /api/admin/subscriptions
 *   GET   /subscriptions/:id fetch one subscription with its secret
 *   PATCH /subscriptions/:id update a subscription with its secret
 */

import { Hono, type Context } from 'hono';
import { MAX_REFS_BATCH } from '@jaywedgeworth22/congress-trading-shared';
import type { Chamber, Env, Subscription, TxType } from '../shared/types.ts';
import { all, first, get } from '../shared/db.ts';
import { cached } from '../shared/kvCache.ts';
import {
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsTodayFilingsQuery,
  buildTransactionsExportQuery,
  mapFiling,
  mapTransaction,
  mapFeedTransaction,
  toPublicFiling,
  type FilingRow,
  type TransactionRow,
  type FeedTransactionRow,
  type TxQueryParams,
} from './rows.ts';
import { getCurrentUserFromRequest } from '../auth/session.ts';
import { isPremiumUser } from '../billing/entitlement.ts';
import { getUserById } from '../auth/users.ts';
import {
  createSubscription,
  getSubscription,
  updateSubscription,
  validateSubscriptionFilters,
  assertSubscriptionQuota,
  SubscriptionQuotaError,
  subscriptionSecretError,
  webhookTargetLengthError,
} from './subscriptions.ts';
import { openSseStream } from './sse.ts';
import { handleTickerLogoRequest } from '../ui/tickerLogos.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { constantTimeEqual } from '../auth/tokens.ts';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from './webhookTarget.ts';
import { rateLimit, clientIp } from '../shared/rateLimit.ts';
import { checkRowBudget, spendRowBudget, MAX_PUBLIC_TX_OFFSET } from '../security/botDefense.ts';
import { checkReadiness } from '../shared/readiness.ts';

function parseIntOrUndef(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the SSE resume cursor. An explicit `?since=` wins (manual override for
 * tooling/curl); otherwise we honor the standard EventSource `Last-Event-ID`
 * header, which clients resend automatically on reconnect. Each `trade.new`
 * event is emitted with `id: <cursorSeq>`, so the header value is the last
 * cursor the client saw — replaying cursor_seq > that value resumes gap-free.
 * Returns undefined when neither is a finite number (openSseStream treats that
 * as "from the beginning").
 */
export function resolveResumeCursor(
  sinceParam: string | undefined,
  lastEventId: string | undefined,
): number | undefined {
  return parseIntOrUndef(sinceParam) ?? parseIntOrUndef(lastEventId);
}

type RestContext = Context<{ Bindings: Env }>;

interface PublicSubscription extends Omit<Subscription, 'secret'> {
  hasSecret: boolean;
  /** Returned only once, on creation or explicit secret rotation. */
  secret?: string;
  /** Browser EventSource helper for SSE subscriptions. Contains the one-time secret. */
  streamUrl?: string;
}

function toPublicSubscription(
  sub: Subscription,
  opts: { includeSecret?: boolean; basePath?: string } = {},
): PublicSubscription {
  const { secret, ...rest } = sub;
  const out: PublicSubscription = {
    ...rest,
    hasSecret: Boolean(secret),
  };
  if (opts.includeSecret && secret) {
    out.secret = secret;
    if (sub.delivery === 'sse') {
      const path = opts.basePath ?? '/api/stream';
      out.streamUrl = `${path}?subscription=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(secret)}`;
    }
  }
  return out;
}

function bearerToken(value: string | undefined): string | null {
  const prefix = 'Bearer ';
  if (!value || !value.startsWith(prefix)) return null;
  const token = value.slice(prefix.length).trim();
  return token || null;
}

function subscriptionSecretFromRequest(c: RestContext, allowQueryToken = false): string | null {
  return (
    bearerToken(c.req.header('Authorization')) ??
    c.req.header('X-Subscription-Secret') ??
    (allowQueryToken ? c.req.query('token') ?? null : null)
  );
}

async function isAuthorizedForSubscription(
  c: RestContext,
  sub: Subscription,
  allowQueryToken = false,
): Promise<boolean> {
  const provided = subscriptionSecretFromRequest(c, allowQueryToken);
  return Boolean(sub.secret && provided && (await constantTimeEqual(provided, sub.secret)));
}

function asChamber(v: string | undefined): Chamber | undefined {
  return v === 'house' || v === 'senate' || v === 'executive' ? v : undefined;
}

/** CSV multi-chamber selection; undefined = default congressional view
 *  (executive rows excluded — see TxQueryParams.chambers). */
function asChambers(v: string | undefined): Chamber[] | undefined {
  if (!v || !v.trim()) return undefined;
  const parsed = Array.from(
    new Set(v.split(',').map((part) => asChamber(part.trim())).filter((c): c is Chamber => !!c)),
  ).sort();
  return parsed.length ? parsed : undefined;
}

function asTxType(v: string | undefined): TxType | undefined {
  return v === 'P' || v === 'S' || v === 'E' ? v : undefined;
}

/** `YYYY-MM-DD` for `days` ago (UTC), for the freemium recency gate. */
function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Whitelist the sort direction; anything other than 'desc' falls back to asc. */
function asOrder(v: string | undefined): 'asc' | 'desc' | undefined {
  return v === 'desc' ? 'desc' : v === 'asc' ? 'asc' : undefined;
}

function asTxSort(v: string | undefined): TxQueryParams['sort'] {
  return v === 'published' ? 'published' : v === 'cursor' ? 'cursor' : v === 'tx_date' ? 'tx_date' : undefined;
}

/** Parse the shared ticker/member/type/chamber filters from the query string. */
function filtersFromQuery(q: Record<string, string>): TxQueryParams {
  return {
    ticker: q.ticker || undefined,
    member: q.member || undefined,
    memberName: q.memberName || undefined,
    chambers: asChambers(q.chamber),
    type: asTxType(q.type),
    txDateMin: q.from || q.txDateMin || undefined,
    txDateMax: q.to || q.txDateMax || undefined,
  };
}

/**
 * CSV-escape a single cell (RFC 4180: wrap in quotes, double embedded quotes),
 * neutralizing spreadsheet formula injection (CT-AUD-008): Excel/Sheets treat
 * cells starting with = + - @ (or tab/CR) as formulas, so a hostile member/
 * asset/ticker string like "=HYPERLINK(...)" would execute on open. String
 * cells starting with such a character are prefixed with a single quote (the
 * standard mitigation). Numeric cells (amount_min/amount_max/confidence are
 * numbers) and purely numeric negative strings keep their exact formatting.
 */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  const neutralized =
    typeof value === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)
      ? `'${s}`
      : s;
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

export function buildRestRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /health --------------------------------------------------------
  // Deployment readiness: D1 must be reachable and the required schema current.
  r.get('/health', async (c) => {
    const readiness = await checkReadiness(c.env.DB);
    return c.json({ ...readiness, time: new Date().toISOString() }, readiness.ok ? 200 : 503);
  });

  // --- GET /transactions --------------------------------------------------
  // Reconciliation backstop: rows with cursor_seq > since, ASC, plus the max
  // cursor in the page so clients can poll forward deterministically.
  //
  // Rolling-window pulls: pass ?from=YYYY-MM-DD (and optionally ?to=) to bound
  // the trade date. A consumer fetching the last N days passes from=today-Nd so
  // the server drops out-of-window rows up front — without it, a bounded pager
  // would have to page through all historical rows (oldest first) to reach
  // recent trades. `txDateMin`/`txDateMax` are accepted as aliases of from/to.
  //
  // Ordering: defaults to oldest-first (cursor_seq ASC) so a consumer can sync
  // incrementally by feeding the returned `cursor` back as the next `since`.
  // Pass ?order=desc for a newest-first "latest trades" snapshot (pair with
  // ?from= to bound the window); DESC is a snapshot, not a resumable forward
  // pager, so incremental-sync consumers should keep the asc default.
  r.get('/transactions', async (c) => {
    const q = c.req.query();
    // The live feed is fully public — it's the site's SEO/discovery hook. The
    // freemium boundary is premium-only *full-history export* (see
    // /export/transactions.csv), not hiding feed rows or public analytics.
    // (Earlier this gated the
    // feed to a short recent window for logged-out visitors, which emptied the page
    // on datasets without recent filings.)
    const params: TxQueryParams = {
      since: parseIntOrUndef(q.since),
      offset: parseIntOrUndef(q.offset),
      ticker: q.ticker || undefined,
      member: q.member || undefined,
      memberName: q.memberName || undefined,
      chambers: asChambers(q.chamber),
      type: asTxType(q.type),
      txDateMin: q.from || q.txDateMin || undefined,
      txDateMax: q.to || q.txDateMax || undefined,
      order: asOrder(q.order),
      sort: asTxSort(q.sort),
      limit: parseIntOrUndef(q.limit),
    };
    // Anti-scrape guards (src/security/botDefense.ts). The pager stays public
    // for humans; depth + daily row budgets make walking the whole corpus via
    // offset/since the job of the Premium CSV export / token-gated bulk
    // snapshot instead. Both checks no-op unless SCRAPE_GUARD_ENABLED.
    if ((params.offset ?? 0) > MAX_PUBLIC_TX_OFFSET) {
      return c.json(
        {
          error: `offset beyond ${MAX_PUBLIC_TX_OFFSET} is not available on the public feed`,
          hint: 'Use the Premium CSV export for full history.',
        },
        400,
      );
    }
    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json(
        { error: 'daily feed row budget reached', hint: 'Use the Premium CSV export for bulk access.' },
        429,
        { 'Retry-After': String(budget.retryAfterSec) },
      );
    }
    const built = buildTransactionsQuery(params);
    // The query SELECTs the resolved chamber + politician name alongside the feed
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
    // Zero-delta incremental poll: a `?since=` cursor with no new rows is the
    // dashboard's steady state (its fetchUpdates() bails out on an empty
    // delta before ever reading `total`/`filingsImportedToday`), so skip the
    // full unindexed COUNT(*) scan AND the today-filings aggregate entirely
    // rather than paying D1 read cost every ~poll interval for numbers nobody
    // reads. Both fields are omitted (not falsely reported as 0) so a
    // reconciliation consumer that DOES want a fresh total on every poll can
    // tell "not computed this round" apart from "actually zero".
    const isIncrementalNoOp = params.since !== undefined && transactions.length === 0;
    let total: number | undefined;
    let filingsImportedToday: number | undefined;
    if (!isIncrementalNoOp) {
      // Total = ALL rows matching the same ticker/member/type/chamber filters,
      // ignoring the cursor backstop (so the UI can show "showing X of N").
      const countQuery = buildTransactionsCountQuery(params);
      const countRow = await first<{ total: number }>(c.env.DB, countQuery.sql, countQuery.params);
      total = countRow?.total ?? transactions.length;
      const today = new Date().toISOString().slice(0, 10);
      const todayQuery = buildTransactionsTodayFilingsQuery(params, today);
      const todayRow = await first<{ total: number }>(c.env.DB, todayQuery.sql, todayQuery.params);
      filingsImportedToday = todayRow?.total ?? 0;
    }
    // Count served rows against the caller's daily budget. Incremental polls
    // (the dashboard's steady state) return zero rows and skip the KV write.
    await spendRowBudget(c.env, ip, transactions.length);
    return c.json({
      transactions,
      cursor: maxCursor,
      count: transactions.length,
      total,
      filingsImportedToday,
      limit: built.limit,
      offset: built.offset,
    });
  });

  // --- GET /export/transactions.csv ---------------------------------------
  // Public/free full-history CSV download. Honors the same ticker/member/
  // type/chamber filters as the feed.
  r.get('/export/transactions.csv', async (c) => {
    // No premium/auth gate here (see #558 — "remove all column gating and CSV
    // export premium limits"; the old gate used cookie-only getCurrentUser(),
    // which would have wrongly rejected bearer-only native clients had it
    // stayed). A full-history CSV is still a heavy D1 scan regardless of who's
    // asking; cap per IP so it can't be scripted into unbounded read/CPU cost.
    // Fails open if KV down.
    const exRl = await rateLimit(c.env, 'export-ip', clientIp(c.req.raw), 30, 600);
    if (!exRl.ok) {
      return c.json({ error: 'too many export requests' }, 429, {
        'Retry-After': String(exRl.retryAfterSec),
      });
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
  // SSE live stream. Resume point comes from ?since=<cursor_seq> or, on an
  // automatic EventSource reconnect, the Last-Event-ID header (each trade event
  // carries id:<cursorSeq>). The backlog replay is sourced from the full
  // transactions table, so resume is gap-free regardless of how long the client
  // was disconnected.
  r.get('/stream', async (c) => {
    const subscription = c.req.query('subscription');
    if (!subscription) {
      return c.json({ error: 'missing ?subscription=' }, 400);
    }
    const since = resolveResumeCursor(c.req.query('since'), c.req.header('Last-Event-ID'));
    const token = subscriptionSecretFromRequest(c, true) ?? undefined;
    return openSseStream(c.env, subscription, since, token, clientIp(c.req.raw));
  });

  // --- GET /logos/ticker --------------------------------------------------
  // Cached company-logo proxy (see ui/tickerLogos.ts). Reachable at
  // /api/logos/ticker?symbol=AAPL, matching the dashboard's <img> src.
  r.get('/logos/ticker', async (c) =>
    handleTickerLogoRequest(new URL(c.req.url), (await resolveSecret(c.env, 'LOGODEV_PUBLISHABLE_KEY')).value),
  );

  // --- GET /filings/:docId ------------------------------------------------
  // Detail endpoint on the same public corpus as /transactions: applies the
  // same per-IP daily row budget (a filing detail can carry many transaction
  // rows) and never hands back internal fields — see toPublicFiling.
  r.get('/filings/:docId', async (c) => {
    const docId = c.req.param('docId');
    const filingRow = await get<FilingRow>(
      c.env.DB,
      'SELECT * FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (!filingRow) return c.json({ error: 'filing not found' }, 404);

    const ip = clientIp(c.req.raw);
    const budget = await checkRowBudget(c.env, ip);
    if (!budget.ok) {
      return c.json(
        { error: 'daily feed row budget reached', hint: 'Use the Premium CSV export for bulk access.' },
        429,
        { 'Retry-After': String(budget.retryAfterSec) },
      );
    }

    const txRows = await all<TransactionRow>(
      c.env.DB,
      'SELECT * FROM transactions WHERE doc_id = ? ORDER BY cursor_seq ASC',
      [docId],
    );
    await spendRowBudget(c.env, ip, txRows.length);
    return c.json({
      filing: toPublicFiling(mapFiling(filingRow)),
      transactions: txRows.map(mapTransaction),
    });
  });

  // --- GET /documents/:docId/pdf ------------------------------------------
  // Serves the raw PDF (if we fetched it) directly from R2, bypassing rate
  // limits/walls on original sources.
  r.get('/documents/:docId/pdf', async (c) => {
    const docId = c.req.param('docId');
    const filingRow = await get<FilingRow>(
      c.env.DB,
      'SELECT raw_object_key FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (!filingRow || !filingRow.raw_object_key) {
      return c.json({ error: 'document not found or not fetched' }, 404);
    }
    const obj = await c.env.RAW_FILES.get(filingRow.raw_object_key);
    if (!obj) {
      return c.json({ error: 'document not found in storage' }, 404);
    }
    
    // We expect PDFs, but let's be safe and use the stored content type if available,
    // or fallback to application/pdf.
    const contentType = obj.httpMetadata?.contentType || 'application/pdf';
    return new Response(obj.body, {
      headers: {
        'content-type': contentType,
        'content-disposition': 'inline', // Attempt to display in browser instead of auto-download
      },
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
      .slice(0, MAX_REFS_BATCH);
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
    const closes = await all<{ date: string; close: number; volume?: number | null }>(c.env.DB, sql, params);
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

  // GET /market/insider/:ticker?from=&to= -> insider (Form 4) daily aggregates.
  r.get('/market/insider/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const rows = await all<{
      date: string; sentiment: number | null; buy_filings: number | null;
      sell_filings: number | null; buy_shares: number | null; sell_shares: number | null;
      owners: string | null;
    }>(
      c.env.DB,
      `SELECT date, sentiment, buy_filings, sell_filings, buy_shares, sell_shares, owners
         FROM insider_eod WHERE ${where.join(' AND ')} ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({
        date: r2.date,
        sentiment: r2.sentiment,
        buyFilings: r2.buy_filings,
        sellFilings: r2.sell_filings,
        buyShares: r2.buy_shares,
        sellShares: r2.sell_shares,
        owners: r2.owners ? (safeParse(r2.owners) ?? []) : [],
      })),
    });
  });

  // GET /market/fundamentals/:ticker?from=&to= -> cached fundamentals (P/E, EPS,
  // beta, 52w, FCF yield, debt/equity, EPS growth, dividend yield). Lets a sibling
  // app read back the fundamentals it (or our enrichment) already stored instead of
  // re-paying a provider — see docs/fmp-data-sharing.md.
  r.get('/market/fundamentals/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const rows = await all<{
      date: string; pe_ratio: number | null; eps: number | null; beta: number | null;
      dividend_yield: number | null; week52_high: number | null; week52_low: number | null;
      fcf_yield: number | null; debt_to_equity: number | null; eps_growth: number | null;
      source: string | null; updated_at: string;
    }>(
      c.env.DB,
      `SELECT date, pe_ratio, eps, beta, dividend_yield, week52_high, week52_low,
              fcf_yield, debt_to_equity, eps_growth, source, updated_at
         FROM fundamentals_eod WHERE ${where.join(' AND ')} ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({
        date: r2.date, peRatio: r2.pe_ratio, eps: r2.eps, beta: r2.beta,
        dividendYield: r2.dividend_yield, week52High: r2.week52_high, week52Low: r2.week52_low,
        fcfYield: r2.fcf_yield, debtToEquity: r2.debt_to_equity, epsGrowth: r2.eps_growth,
        source: r2.source, updatedAt: r2.updated_at,
      })),
    });
  });

  // GET /market/analyst/:ticker?from=&to= -> cached analyst consensus + targets.
  r.get('/market/analyst/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const rows = await all<{
      date: string; rating: string | null; target_mean: number | null; target_high: number | null;
      target_low: number | null; target_median: number | null; analyst_count: number | null;
      strong_buy: number | null; buy: number | null; hold: number | null; sell: number | null;
      strong_sell: number | null; source: string | null; updated_at: string;
    }>(
      c.env.DB,
      `SELECT date, rating, target_mean, target_high, target_low, target_median, analyst_count,
              strong_buy, buy, hold, sell, strong_sell, source, updated_at
         FROM analyst_consensus WHERE ${where.join(' AND ')} ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({
        date: r2.date, rating: r2.rating, targetMean: r2.target_mean, targetHigh: r2.target_high,
        targetLow: r2.target_low, targetMedian: r2.target_median, analystCount: r2.analyst_count,
        strongBuy: r2.strong_buy, buy: r2.buy, hold: r2.hold, sell: r2.sell, strongSell: r2.strong_sell,
        source: r2.source, updatedAt: r2.updated_at,
      })),
    });
  });

  // GET /market/short-volume/:ticker?from=&to= -> FINRA short-volume daily.
  r.get('/market/short-volume/:ticker', async (c) => {
    const ticker = c.req.param('ticker').toUpperCase();
    const where = ['ticker = ?'];
    const params: (string | number)[] = [ticker];
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from) { where.push('date >= ?'); params.push(from.slice(0, 10)); }
    if (to) { where.push('date <= ?'); params.push(to.slice(0, 10)); }
    const rows = await all<{ date: string; short_volume_ratio: number | null; elevated: number }>(
      c.env.DB,
      `SELECT date, short_volume_ratio, elevated FROM short_volume_eod
        WHERE ${where.join(' AND ')} ORDER BY date ASC`,
      params,
    );
    return c.json({
      ticker,
      rows: rows.map((r2) => ({ date: r2.date, ratio: r2.short_volume_ratio, elevated: r2.elevated === 1 })),
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
    const closes = await all<{ date: string; close: number; volume?: number | null }>(c.env.DB, pq.sql, pq.params);
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
    // Full-corpus GROUP BY over transactions with a joined-table filter — not
    // indexable, and recomputed on every members page load. Cache the whole
    // roster (no params → a single key); it only shifts with the daily ingest
    // bursts, so a 30-min TTL is invisible to users and cuts a full scan per hit.
    const payload = await cached(c.env, 'members:roster', 1800, async () => {
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
      return { members, count: members.length };
    });
    return c.json(payload);
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
    const user = await getCurrentUserFromRequest(c);
    if (!user) return c.json({ error: 'authentication required for durable subscriptions' }, 401);
    if (!isPremiumUser(user)) {
      return c.json({ error: `${delivery === 'webhook' ? 'Webhook' : 'SSE'} delivery requires a Premium account`, upgradeRequired: true, feature: 'alerts' }, 402);
    }
    const clientId = `user:${user.id}`;
    const subRl = await rateLimit(c.env, 'sub-create-user', clientId, 10, 3600);
    if (!subRl.ok) return c.json({ error: 'too many subscription requests' }, 429, { 'Retry-After': String(subRl.retryAfterSec) });

    const targetUrl =
      typeof body.targetUrl === 'string' && body.targetUrl.length > 0 ? body.targetUrl : null;
    const targetLengthError = webhookTargetLengthError(targetUrl);
    if (targetLengthError) return c.json({ error: targetLengthError }, 400);
    if (delivery === 'webhook') {
      const targetUrlError = await validatePublicWebhookTarget(targetUrl, {
        allowLocalhost: localWebhookTargetsAllowed(c.env, c.req.url),
      });
      if (targetUrlError) return c.json({ error: targetUrlError }, 400);
    }

    const validatedFilters = validateSubscriptionFilters(body.filters);
    if (!validatedFilters.ok) return c.json({ error: (validatedFilters as any).error }, 400);
    const secretError = subscriptionSecretError(body.secret);
    if (secretError) return c.json({ error: secretError }, 400);
    const secret = typeof body.secret === 'string' ? body.secret : undefined;

    try {
      await assertSubscriptionQuota(c.env, clientId, { creating: true });
      const sub = await createSubscription(c.env, {
        clientId,
        delivery,
        targetUrl,
        secret: secret ?? null,
        filters: validatedFilters.filters,
      });
      return c.json(toPublicSubscription(sub, { includeSecret: true }), 201);
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  // --- GET /subscriptions -------------------------------------------------
  r.get('/subscriptions', async (c) => {
    return c.json(
      { error: 'public subscription listing is disabled; use /api/admin/subscriptions' },
      401,
    );
  });

  // --- GET /subscriptions/:id ---------------------------------------------
  r.get('/subscriptions/:id', async (c) => {
    const sub = await getSubscription(c.env, c.req.param('id'));
    if (!sub) return c.json({ error: 'subscription not found' }, 404);
    if (!(await isAuthorizedForSubscription(c, sub))) {
      return c.json({ error: 'subscription secret required' }, 401);
    }
    return c.json(toPublicSubscription(sub));
  });

  // --- PATCH /subscriptions/:id -------------------------------------------
  r.patch('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await getSubscription(c.env, id);
    if (!existing) return c.json({ error: 'subscription not found' }, 404);
    if (!(await isAuthorizedForSubscription(c, existing))) {
      return c.json({ error: 'subscription secret required' }, 401);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    // The premium gate is anchored to the subscription OWNER, never the
    // request's session (any premium cookie must not unlock someone else's
    // subscription). User-owned rows store clientId as `user:<id>`; admin
    // operator-provisioned integration ids are intentionally ungated.
    const isContinuingOrChangingDelivery = body.filters !== undefined || body.targetUrl !== undefined || body.active === true;
    if (isContinuingOrChangingDelivery && existing.clientId?.startsWith('user:')) {
      const ownerUser = await getUserById(c.env, existing.clientId.slice('user:'.length));
      if (!ownerUser || !isPremiumUser(ownerUser)) {
        return c.json({ error: 'subscription management requires a Premium account', upgradeRequired: true, feature: 'alerts' }, 402);
      }
    }

    const patch: Parameters<typeof updateSubscription>[2] = {};
    if (body.filters !== undefined) {
      const validatedFilters = validateSubscriptionFilters(body.filters);
      if (!validatedFilters.ok) return c.json({ error: (validatedFilters as any).error }, 400);
      patch.filters = validatedFilters.filters;
    }
    if (typeof body.targetUrl === 'string' || body.targetUrl === null) {
      patch.targetUrl = body.targetUrl as string | null;
      const targetLengthError = webhookTargetLengthError(patch.targetUrl);
      if (targetLengthError) return c.json({ error: targetLengthError }, 400);
      if (existing.delivery === 'webhook') {
        const targetUrlError = await validatePublicWebhookTarget(patch.targetUrl, {
          allowLocalhost: localWebhookTargetsAllowed(c.env, c.req.url),
        });
        if (targetUrlError) return c.json({ error: targetUrlError }, 400);
      }
    }
    if (body.secret !== undefined && body.secret !== null && typeof body.secret !== 'string') {
      return c.json({ error: 'secret must be a string' }, 400);
    }
    if (typeof body.secret === 'string') {
      const secretError = subscriptionSecretError(body.secret);
      if (secretError) return c.json({ error: secretError }, 400);
      patch.secret = body.secret;
    } else if (body.secret === null) {
      return c.json({ error: 'secret cannot be cleared' }, 400);
    }
    if (typeof body.active === 'boolean') {
      if (body.active && !existing.active) {
        try {
          await assertSubscriptionQuota(c.env, existing.clientId, { activating: true });
        } catch (err) {
          if (err instanceof SubscriptionQuotaError) return c.json({ error: err.message }, 409);
          throw err;
        }
      }
      patch.active = body.active;
    }
    if (typeof body.cursor === 'number') {
      patch.cursor = body.cursor;
    }

    try {
      const updated = await updateSubscription(c.env, id, patch);
      return c.json(toPublicSubscription(updated, { includeSecret: patch.secret !== undefined }));
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) return c.json({ error: err.message }, 409);
      throw err;
    }
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
  // price_eod carries a daily volume column; spx_eod does not.
  const cols = table === 'price_eod' ? 'date, close, volume' : 'date, close';
  if (!from && !to) {
    // No window: cap at the LATEST 1000 rows (not the oldest), re-sorted
    // ascending for charting.
    return {
      sql: `SELECT ${cols} FROM (SELECT ${cols} FROM ${table}${clause} ORDER BY date DESC LIMIT 1000) ORDER BY date ASC`,
      params,
    };
  }
  return { sql: `SELECT ${cols} FROM ${table}${clause} ORDER BY date ASC`, params };
}

/** JSON.parse that returns null instead of throwing. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
