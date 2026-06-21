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
  mapFiling,
  mapTransaction,
  type FilingRow,
  type TransactionRow,
  type TxQueryParams,
} from './rows';
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

export function buildRestRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /transactions --------------------------------------------------
  // Reconciliation backstop: rows with cursor_seq > since, ASC, plus the max
  // cursor in the page so clients can poll forward deterministically.
  r.get('/transactions', async (c) => {
    const q = c.req.query();
    const params: TxQueryParams = {
      since: parseIntOrUndef(q.since),
      ticker: q.ticker || undefined,
      member: q.member || undefined,
      chamber: asChamber(q.chamber),
      type: asTxType(q.type),
      limit: parseIntOrUndef(q.limit),
    };
    const built = buildTransactionsQuery(params);
    const rows = await all<TransactionRow>(c.env.DB, built.sql, built.params);
    const transactions = rows.map(mapTransaction);
    const maxCursor = transactions.reduce(
      (m, t) => (t.cursorSeq > m ? t.cursorSeq : m),
      params.since ?? 0,
    );
    return c.json({
      transactions,
      cursor: maxCursor,
      count: transactions.length,
      limit: built.limit,
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
