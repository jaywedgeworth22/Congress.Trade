/**
 * Product APNs fan-out: new official trades (delivery_outbox) and review-needed
 * filings. Fail-soft. Tests inject a transport and never talk to Apple.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { deactivatePushDevice, listAllActiveApnsDevices } from '../client/pushDevices.ts';
import {
  apnsConfigured,
  loadApnsConfig,
  resolveApnsEnvironment,
  sendApnsPush,
  type ApnsConfig,
  type ApnsTransport,
} from '../shared/apns.ts';

export const APNS_FANOUT_LOOKBACK_MS = 2 * 60 * 60 * 1000;
export const APNS_FANOUT_PAGE = 40;
const STATE_ID = 'default';

export interface ApnsFanoutResult {
  skipped?: 'not_configured' | 'no_devices';
  trades: number;
  reviews: number;
  delivered: number;
  retired: number;
}

interface TradeRow {
  id: string;
  ticker: string | null;
  tx_type: string | null;
  asset_name: string | null;
  created_at: string;
  filer_name: string | null;
}

interface ReviewRow {
  doc_id: string;
  reason: string | null;
  created_at: string;
}

export interface ApnsFanoutState {
  lastTradeAt: string;
  lastReviewAt: string;
}

export interface ApnsFanoutDeps {
  transport?: ApnsTransport;
  now?: Date;
  loadConfig?: (env: Env) => ApnsConfig | null;
  readState?: (env: Env) => Promise<ApnsFanoutState>;
  writeState?: (env: Env, state: ApnsFanoutState) => Promise<void>;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

export async function readApnsFanoutState(env: Env): Promise<ApnsFanoutState> {
  try {
    const raw = await env.CONFIG_KV.get('apns:fanout');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ApnsFanoutState>;
      return {
        lastTradeAt: typeof parsed.lastTradeAt === 'string' ? parsed.lastTradeAt : EPOCH,
        lastReviewAt: typeof parsed.lastReviewAt === 'string' ? parsed.lastReviewAt : EPOCH,
      };
    }
  } catch {
    /* KV optional */
  }
  try {
    const row = await env.DB.prepare(
      `SELECT last_trade_at, last_review_at FROM apns_fanout_state WHERE id = ?`,
    )
      .bind(STATE_ID)
      .first<{ last_trade_at: string; last_review_at: string }>();
    if (row) {
      return { lastTradeAt: row.last_trade_at, lastReviewAt: row.last_review_at };
    }
  } catch {
    /* table may not exist yet */
  }
  return { lastTradeAt: EPOCH, lastReviewAt: EPOCH };
}

export async function writeApnsFanoutState(env: Env, state: ApnsFanoutState): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await env.CONFIG_KV.put('apns:fanout', JSON.stringify(state));
  } catch {
    /* KV optional */
  }
  try {
    await run(
      env.DB,
      `INSERT INTO apns_fanout_state (id, last_trade_at, last_review_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_trade_at = excluded.last_trade_at,
         last_review_at = excluded.last_review_at,
         updated_at = excluded.updated_at`,
      [STATE_ID, state.lastTradeAt, state.lastReviewAt, nowIso],
    );
  } catch {
    /* table may not exist yet */
  }
}

function lookbackFloor(now: Date): string {
  return new Date(now.getTime() - APNS_FANOUT_LOOKBACK_MS).toISOString();
}

function laterIso(a: string, b: string): string {
  return a > b ? a : b;
}

function tradeTitle(row: TradeRow): string {
  const member = row.filer_name?.trim() || 'Member';
  const side = (row.tx_type ?? '').toUpperCase() === 'S' ? 'sold' : 'bought';
  const symbol = row.ticker?.trim() || row.asset_name?.trim() || 'a holding';
  return `${member} ${side} ${symbol}`;
}

function tradeBody(row: TradeRow): string {
  const asset = row.asset_name?.trim();
  if (asset && row.ticker && asset.toUpperCase() !== row.ticker.toUpperCase()) {
    return `New official trade: ${asset} (${row.ticker}).`;
  }
  return 'New official trade is on the Congress.Trade feed.';
}

export async function fanOutApnsProductEvents(
  env: Env,
  deps: ApnsFanoutDeps = {},
): Promise<ApnsFanoutResult> {
  const now = deps.now ?? new Date();
  const config = (deps.loadConfig ?? ((e: Env) => loadApnsConfig(e as unknown as Record<string, string | undefined>)))(
    env,
  );
  if (!apnsConfigured(config)) return { skipped: 'not_configured', trades: 0, reviews: 0, delivered: 0, retired: 0 };

  const devices = await listAllActiveApnsDevices(env);
  if (devices.length === 0) return { skipped: 'no_devices', trades: 0, reviews: 0, delivered: 0, retired: 0 };

  const stored = await (deps.readState ?? readApnsFanoutState)(env);
  const floor = lookbackFloor(now);
  const tradeSince = laterIso(stored.lastTradeAt, floor);
  const reviewSince = laterIso(stored.lastReviewAt, floor);

  const trades = await all<TradeRow>(
    env.DB,
    `SELECT t.id, t.ticker, t.tx_type, t.asset_name, t.created_at,
            COALESCE(f.display_name, f.full_name) AS filer_name
       FROM delivery_outbox o
       JOIN transactions t ON t.id = o.tx_id
       LEFT JOIN filers f ON f.id = t.filer_id
      WHERE t.deprecated_at IS NULL
        AND t.created_at > ?
      ORDER BY t.created_at ASC
      LIMIT ${APNS_FANOUT_PAGE}`,
    [tradeSince],
  );

  const reviews = await all<ReviewRow>(
    env.DB,
    `SELECT doc_id, reason, created_at
       FROM review_queue
      WHERE resolved = 0
        AND created_at > ?
      ORDER BY created_at ASC
      LIMIT ${APNS_FANOUT_PAGE}`,
    [reviewSince],
  );

  let delivered = 0;
  let retired = 0;
  let lastTradeAt = stored.lastTradeAt;
  let lastReviewAt = stored.lastReviewAt;

  const sendAll = async (alert: {
    title: string;
    body: string;
    collapseId: string;
    data: Record<string, unknown>;
  }) => {
    for (const device of devices) {
      const result = await sendApnsPush(
        {
          deviceToken: device.token,
          environment: resolveApnsEnvironment(device.env),
          title: alert.title,
          body: alert.body,
          collapseId: alert.collapseId,
          data: alert.data,
        },
        { config, transport: deps.transport },
      );
      if (result.ok) {
        delivered += 1;
        continue;
      }
      if (result.disposition === 'token_dead') {
        retired += 1;
        await deactivatePushDevice(env, { userId: device.userId, token: device.token, platform: 'apns' });
      }
    }
  };

  for (const trade of trades) {
    await sendAll({
      title: tradeTitle(trade),
      body: tradeBody(trade),
      collapseId: `trade-${trade.id}`.slice(0, 64),
      data: { kind: 'official_trade', txId: trade.id, ticker: trade.ticker },
    });
    if (trade.created_at > lastTradeAt) lastTradeAt = trade.created_at;
  }

  for (const review of reviews) {
    await sendAll({
      title: 'Review needed',
      body: review.reason?.trim() || `Filing ${review.doc_id} needs review.`,
      collapseId: `review-${review.doc_id}`.slice(0, 64),
      data: { kind: 'review_needed', docId: review.doc_id },
    });
    if (review.created_at > lastReviewAt) lastReviewAt = review.created_at;
  }

  await (deps.writeState ?? writeApnsFanoutState)(env, { lastTradeAt, lastReviewAt });
  return { trades: trades.length, reviews: reviews.length, delivered, retired };
}
