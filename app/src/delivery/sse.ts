/**
 * src/delivery/sse.ts
 * OWNER: delivery agent
 *
 * Server-Sent Events streaming for 'sse' subscriptions. Holds an open Response
 * stream and pushes new transactions (filtered per subscription) as they are
 * persisted, resuming from a client-supplied cursor (?since= or the standard
 * EventSource Last-Event-ID header; see resolveResumeCursor in rest.ts). Native
 * browser EventSource cannot send Authorization headers, so public clients pass
 * the per-subscription stream token in the query string and should reconnect
 * with a fresh URL when the server emits `event: reconnect`.
 *
 * BACKLOG / GAP-FREE RESUME:
 *   The catch-up replay reads straight from the `transactions` table (which is
 *   the durable system of record), so the available backlog is the full feed
 *   history — not a bounded in-memory window. A client that reconnects with the
 *   last cursor it saw (via Last-Event-ID) gets every row it missed, in order,
 *   before the live tail attaches. Each emitted trade carries `id:<cursorSeq>`,
 *   so EventSource tracks the resume point automatically across reconnects.
 *
 * APPROACH (Workers-friendly poll loop):
 *   We back the Response with a ReadableStream. On open we replay the catch-up
 *   backlog (cursor_seq > since) immediately, then enter an async poll loop that
 *   queries D1 every POLL_INTERVAL_MS for rows with cursor_seq beyond the last
 *   one we emitted, advancing an in-memory high-water cursor. Heartbeats
 *   (`event: ping`) are emitted on each idle tick so proxies/clients keep the
 *   connection alive and can detect a dead stream.
 *
 *   We use a plain `await new Promise(setTimeout)` between polls — there is no
 *   Workers `scheduler` primitive needed; the runtime keeps the streaming
 *   response alive while the loop awaits. The loop exits cleanly when the client
 *   disconnects (the stream `cancel()` fires, flipping `closed`) or when the
 *   self-imposed MAX_STREAM_MS budget is hit.
 *
 * MAX-DURATION CAVEAT:
 *   Cloudflare Workers cap wall-clock / streaming duration (and a long-lived SSE
 *   connection consumes a request's lifetime). We therefore bound each stream to
 *   MAX_STREAM_MS (~25 min) and emit a terminal `event: reconnect` with the last
 *   cursor so the client reconnects with `?since=<lastCursor>` and resumes
 *   exactly where it left off (no gaps, the catch-up replay covers the seam).
 *   This is a deliberate at-least-once, resumable design rather than a truly
 *   infinite socket. For sub-second push semantics, prefer a webhook subscription.
 */

import type { Env, Subscription, Transaction } from '../shared/types';
import { all, get } from '../shared/db';
import { mapSubscription, mapFeedTransaction, type SubscriptionRow, type FeedTransactionRow } from './rows';
import { matchesFiltersWithContext } from './subscriptions';
import { constantTimeEqual } from '../auth/tokens';

/** How often to poll D1 for new rows. */
const POLL_INTERVAL_MS = 5_000;
/** Max lifetime of a single SSE connection before asking the client to reconnect. */
const MAX_STREAM_MS = 25 * 60 * 1_000;
/** Page size when draining the catch-up / live backlog. */
const PAGE_SIZE = 200;

/**
 * Open an SSE stream for a subscription, replaying from `since` then live.
 * Returns a `text/event-stream` Response. If the subscription is missing or not
 * an SSE subscription, returns a 404/409 JSON error instead.
 */
export let LATEST_CURSOR_SEQ: number | null = null;

export async function refreshLatestCursorSeq(db: D1Database): Promise<number> {
  const row = await get<{ max_seq: number | null }>(
    db,
    'SELECT MAX(cursor_seq) AS max_seq FROM transactions'
  );
  const maxSeq = row?.max_seq ?? 0;
  LATEST_CURSOR_SEQ = maxSeq;
  return maxSeq;
}

export function updateLatestCursorSeq(seq: number) {
  if (LATEST_CURSOR_SEQ === null || seq > LATEST_CURSOR_SEQ) {
    LATEST_CURSOR_SEQ = seq;
  }
}

export async function openSseStream(
  env: Env,
  subscriptionId: string,
  since?: number,
  streamToken?: string,
): Promise<Response> {
  if (LATEST_CURSOR_SEQ === null) {
    try {
      await refreshLatestCursorSeq(env.DB);
    } catch (err) {
      console.warn('sse: failed to fetch initial LATEST_CURSOR_SEQ', (err as Error).message);
    }
  }

  const subRow = await get<SubscriptionRow>(
    env.DB,
    'SELECT id, client_id, delivery, target_url, secret, filters, cursor, active, created_at FROM subscriptions WHERE id = ?',
    [subscriptionId],
  );
  if (!subRow) {
    return new Response(JSON.stringify({ error: 'subscription not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const sub = mapSubscription(subRow);
  if (!sub.active) {
    return new Response(JSON.stringify({ error: 'subscription inactive' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (sub.delivery !== 'sse') {
    return new Response(JSON.stringify({ error: 'subscription is not an SSE subscription' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!sub.secret || !streamToken || !(await constantTimeEqual(streamToken, sub.secret))) {
    return new Response(JSON.stringify({ error: 'subscription stream token required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  let cursor = Number.isFinite(since) ? Number(since) : 0;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // Opening comment + initial cursor so clients know the resume point.
      send(`: connected\n`);
      send(`event: cursor\ndata: ${cursor}\n\n`);

      const startedAt = Date.now();

      try {
        // 1) Catch-up replay (drain everything newer than `since`).
        if (LATEST_CURSOR_SEQ === null || cursor < LATEST_CURSOR_SEQ) {
          cursor = await drain(env, sub, cursor, send);
        }

        // 2) Live poll loop.
        while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
          await sleep(POLL_INTERVAL_MS);
          if (closed) break;
          const before = cursor;
          if (LATEST_CURSOR_SEQ !== null && cursor >= LATEST_CURSOR_SEQ) {
            send(`event: ping\ndata: ${Date.now()}\n\n`);
          } else {
            cursor = await drain(env, sub, cursor, send);
            if (cursor === before) {
              // Idle tick — heartbeat so intermediaries keep the socket open.
              send(`event: ping\ndata: ${Date.now()}\n\n`);
            }
          }
        }

        if (!closed) {
          // Hit the duration budget — ask the client to reconnect and resume.
          send(`event: reconnect\ndata: ${JSON.stringify({ since: cursor })}\n\n`);
        }
      } catch (err) {
        send(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Emit every matching transaction with cursor_seq > `cursor`, paging through the
 * backlog. Returns the new high-water cursor (max cursor_seq seen, matched or
 * not, so we never re-scan rows that were merely filtered out).
 */
async function drain(
  env: Env,
  sub: Subscription,
  cursor: number,
  send: (chunk: string) => void,
): Promise<number> {
  let hwm = cursor;
  // Loop pages until a short page (fewer than PAGE_SIZE rows) is returned.
  for (;;) {
    const rows = await all<
      FeedTransactionRow & { __chamber: string | null; __sector: string | null; __bucket: string | null }
    >(
      env.DB,
      `SELECT t.*, f.chamber AS __chamber,
              sr.sector AS __sector, sr.market_cap_bucket AS __bucket,
              fl.full_name AS filer_full_name, fl.state AS filer_state,
              fl.photo_url AS filer_photo_url
         FROM transactions t
         LEFT JOIN filings f ON f.doc_id = t.doc_id
         LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
         LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id
        WHERE t.cursor_seq > ? AND t.deprecated_at IS NULL
        ORDER BY t.cursor_seq ASC
        LIMIT ?`,
      [hwm, PAGE_SIZE],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const tx: Transaction = mapFeedTransaction(row);
      const ctx = {
        chamber: row.__chamber ?? null,
        sector: row.__sector ?? null,
        marketCapBucket: row.__bucket ?? null,
      };
      hwm = Math.max(hwm, tx.cursorSeq);
      if (!matchesFiltersWithContext(tx, sub.filters, ctx)) continue;
      send(`id: ${tx.cursorSeq}\nevent: trade.new\ndata: ${JSON.stringify(tx)}\n\n`);
    }

    if (rows.length < PAGE_SIZE) break;
  }
  return hwm;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
