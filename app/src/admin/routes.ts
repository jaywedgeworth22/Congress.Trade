/**
 * src/admin/routes.ts
 * OWNER: admin agent
 *
 * Admin Hono router (mounted under /api/admin). Endpoints:
 *   GET   /poll-config              -> current PollConfig
 *   PUT   /poll-config              -> update schedule / aggressiveMode (setConfig)
 *   GET   /poll-config/aggressive   -> aggressiveMode toggle convenience read
 *   GET   /review-queue             -> list unresolved review items
 *   POST  /review/:docId            -> {decision:'confirm'|'reject', edits?}
 *   GET   /sources/health           -> ingest_log aggregates per source
 *   GET   /subscriptions            -> admin list of subscriptions
 *
 * AUTH (documented stub):
 *   If env.ADMIN_TOKEN is set AND an Authorization header is present, we require
 *   `Authorization: Bearer <ADMIN_TOKEN>`. If no header is present we currently
 *   ALLOW the request (open admin surface) — TODO: flip to deny-by-default once
 *   the token is provisioned. ADMIN_TOKEN is referenced optionally and is NOT
 *   added to wrangler.toml / package.json by this module.
 */

import { Hono } from 'hono';
import type { Env, PollConfig, PollWindow, TxType } from '../shared/types';
import { all, get, run } from '../shared/db';
import { getConfig, setConfig } from '../shared/config';
import { uuid } from '../shared/ids';
import { listSubscriptions } from '../delivery/subscriptions';

// Optional secret; not declared on Env (frozen). Read defensively.
type EnvWithAdmin = Env & { ADMIN_TOKEN?: string };

/**
 * Admin auth stub. Returns true (allowed) unless a token is configured AND the
 * caller supplied a mismatched bearer. Missing header => allowed (TODO: enforce).
 */
function isAuthorized(env: EnvWithAdmin, authHeader: string | undefined): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return true; // no token configured -> open (stub)
  if (!authHeader) return true; // TODO: enforce -> change to `return false`
  return authHeader === `Bearer ${token}`;
}

/** Validate a PollWindow[] schedule shape. Returns an error string or null. */
function validateSchedule(schedule: unknown): string | null {
  if (!Array.isArray(schedule)) return 'schedule must be an array';
  if (schedule.length === 0) return 'schedule must have at least one window';
  for (const [i, w] of schedule.entries()) {
    if (typeof w !== 'object' || w === null) return `schedule[${i}] must be an object`;
    const win = w as Record<string, unknown>;
    if (
      !Array.isArray(win.daysOfWeek) ||
      !win.daysOfWeek.every((d) => typeof d === 'number' && d >= 0 && d <= 6)
    ) {
      return `schedule[${i}].daysOfWeek must be numbers in [0,6]`;
    }
    if (typeof win.startHourET !== 'number' || win.startHourET < 0 || win.startHourET > 24) {
      return `schedule[${i}].startHourET must be a number in [0,24]`;
    }
    if (typeof win.endHourET !== 'number' || win.endHourET < 0 || win.endHourET > 24) {
      return `schedule[${i}].endHourET must be a number in [0,24]`;
    }
    if (win.startHourET >= win.endHourET) {
      return `schedule[${i}].startHourET must be < endHourET`;
    }
    if (typeof win.intervalSec !== 'number' || win.intervalSec <= 0) {
      return `schedule[${i}].intervalSec must be a positive number`;
    }
  }
  return null;
}

interface ReviewRow {
  doc_id: string;
  reason: string | null;
  payload: string | null;
  created_at: string | null;
  resolved: number | null;
}

interface EditedTx {
  filerId?: string | null;
  txDate?: string | null;
  owner?: string | null;
  assetName?: string;
  ticker?: string | null;
  assetType?: string | null;
  txType?: TxType;
  amountMin?: number | null;
  amountMax?: number | null;
  isOption?: boolean;
  capGainsOver200?: boolean;
  rawText?: string;
  confidence?: number;
}

export function buildAdminRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // Auth gate (documented stub) applied to every admin route.
  r.use('*', async (c, next) => {
    const env = c.env as EnvWithAdmin;
    if (!isAuthorized(env, c.req.header('Authorization'))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // --- GET /poll-config ---------------------------------------------------
  r.get('/poll-config', async (c) => {
    const cfg = await getConfig(c.env);
    return c.json(cfg);
  });

  // --- PUT /poll-config ---------------------------------------------------
  // Accepts { schedule?: PollWindow[], aggressiveMode?: boolean }. Persists via
  // setConfig (D1 + KV cache); effective within ~60s (watcher reads getConfig).
  r.put('/poll-config', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const current = await getConfig(c.env);
    const next: PollConfig = {
      schedule: current.schedule,
      aggressiveMode: current.aggressiveMode,
      updatedAt: current.updatedAt,
    };

    if (body.schedule !== undefined) {
      const err = validateSchedule(body.schedule);
      if (err) return c.json({ error: err }, 400);
      next.schedule = body.schedule as PollWindow[];
    }
    if (body.aggressiveMode !== undefined) {
      if (typeof body.aggressiveMode !== 'boolean') {
        return c.json({ error: 'aggressiveMode must be a boolean' }, 400);
      }
      next.aggressiveMode = body.aggressiveMode;
    }

    const saved = await setConfig(c.env, next);
    return c.json(saved);
  });

  // --- GET /poll-config/aggressive ---------------------------------------
  r.get('/poll-config/aggressive', async (c) => {
    const cfg = await getConfig(c.env);
    return c.json({ aggressiveMode: cfg.aggressiveMode });
  });

  // --- GET /review-queue --------------------------------------------------
  r.get('/review-queue', async (c) => {
    const rows = await all<ReviewRow>(
      c.env.DB,
      'SELECT doc_id, reason, payload, created_at, resolved FROM review_queue WHERE resolved = 0 ORDER BY created_at ASC',
    );
    const items = rows.map((row) => ({
      docId: row.doc_id,
      reason: row.reason ?? '',
      payload: row.payload ? safeJson(row.payload) : null,
      createdAt: row.created_at ?? '',
      resolved: row.resolved === 1,
    }));
    return c.json({ items, count: items.length });
  });

  // --- POST /review/:docId ------------------------------------------------
  // Body: { decision: 'confirm'|'reject', edits?: EditedTx[] }
  //   confirm -> insert corrected transactions (source='primary'), mark review
  //              resolved, set filing persisted, enqueue delivery.dispatch each.
  //   reject  -> mark review resolved + filing status 'error'.
  r.post('/review/:docId', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const decision = body.decision;
    if (decision !== 'confirm' && decision !== 'reject') {
      return c.json({ error: "decision must be 'confirm' or 'reject'" }, 400);
    }

    const review = await get<ReviewRow>(
      c.env.DB,
      'SELECT doc_id, reason, payload, created_at, resolved FROM review_queue WHERE doc_id = ?',
      [docId],
    );
    if (!review) return c.json({ error: 'review item not found' }, 404);

    if (decision === 'reject') {
      await run(c.env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [docId]);
      await run(c.env.DB, 'UPDATE filings SET ingest_status = ? WHERE doc_id = ?', [
        'error',
        docId,
      ]);
      return c.json({ docId, decision: 'reject', resolved: true });
    }

    // confirm: insert the corrected transactions.
    const edits = Array.isArray(body.edits) ? (body.edits as EditedTx[]) : [];
    const filing = await get<{ filer_id: string | null }>(
      c.env.DB,
      'SELECT filer_id FROM filings WHERE doc_id = ?',
      [docId],
    );
    const filingFilerId = filing?.filer_id ?? null;

    const insertedIds: string[] = [];
    const nowIso = new Date().toISOString();
    for (const e of edits) {
      const id = uuid();
      // cursor_seq is DB-assigned by trg_transactions_cursor (insert with NULL).
      await run(
        c.env.DB,
        `INSERT INTO transactions (
           id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
           tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
           raw_text, confidence, source, created_at, cursor_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'primary', ?, NULL)`,
        [
          id,
          docId,
          e.filerId ?? filingFilerId,
          e.txDate ?? null,
          e.owner ?? null,
          e.assetName ?? '',
          e.ticker ?? null,
          e.assetType ?? null,
          (e.txType as TxType) ?? 'P',
          e.amountMin ?? null,
          e.amountMax ?? null,
          e.isOption ? 1 : 0,
          e.capGainsOver200 ? 1 : 0,
          e.rawText ?? '',
          e.confidence ?? 1,
          nowIso,
        ],
      );
      insertedIds.push(id);
    }

    // Mark review resolved + filing persisted.
    await run(c.env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [docId]);
    await run(c.env.DB, 'UPDATE filings SET ingest_status = ? WHERE doc_id = ?', [
      'persisted',
      docId,
    ]);

    // Enqueue delivery fan-out for each newly inserted transaction.
    for (const txId of insertedIds) {
      try {
        await c.env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId });
      } catch (err) {
        console.error('review confirm: enqueue failed', txId, (err as Error).message);
      }
    }

    return c.json({
      docId,
      decision: 'confirm',
      resolved: true,
      inserted: insertedIds.length,
      transactionIds: insertedIds,
    });
  });

  // --- GET /sources/health ------------------------------------------------
  // Recent ingest_log aggregates per source: last poll, last new filing, and the
  // observed average interval between polls (seconds).
  r.get('/sources/health', async (c) => {
    const rows = await all<{
      source: string;
      last_polled_at: string | null;
      poll_count: number;
      total_new: number;
      last_new_at: string | null;
    }>(
      c.env.DB,
      `SELECT source,
              MAX(polled_at)                              AS last_polled_at,
              COUNT(*)                                    AS poll_count,
              COALESCE(SUM(new_count), 0)                 AS total_new,
              MAX(CASE WHEN new_count > 0 THEN polled_at END) AS last_new_at
         FROM ingest_log
        GROUP BY source`,
    );

    const sources = [];
    for (const row of rows) {
      sources.push({
        source: row.source,
        lastPolledAt: row.last_polled_at,
        lastNewFilingAt: row.last_new_at,
        pollCount: row.poll_count,
        totalNew: row.total_new,
        avgIntervalSec: await observedAvgInterval(c.env, row.source),
      });
    }
    return c.json({ sources, count: sources.length });
  });

  // --- GET /subscriptions -------------------------------------------------
  r.get('/subscriptions', async (c) => {
    const activeOnly = c.req.query('active') === 'true';
    const subs = await listSubscriptions(c.env, activeOnly);
    return c.json({ subscriptions: subs, count: subs.length });
  });

  return r;
}

/** Observed average seconds between the most recent polls for a source. */
async function observedAvgInterval(env: Env, source: string): Promise<number | null> {
  const rows = await all<{ polled_at: string }>(
    env.DB,
    'SELECT polled_at FROM ingest_log WHERE source = ? ORDER BY polled_at DESC LIMIT 50',
    [source],
  );
  if (rows.length < 2) return null;
  // rows are DESC; compute deltas between consecutive timestamps.
  let total = 0;
  let n = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const newer = Date.parse(rows[i].polled_at);
    const older = Date.parse(rows[i + 1].polled_at);
    if (Number.isFinite(newer) && Number.isFinite(older) && newer > older) {
      total += (newer - older) / 1000;
      n++;
    }
  }
  return n > 0 ? Math.round(total / n) : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
