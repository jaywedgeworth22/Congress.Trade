/**
 * Quote prints around a latency race: when we first publish a trade, when a
 * competitor first publishes it, and 5 / 30 / 60 minutes after they publish.
 * The goal is to see whether their print moves the stock — an edge if we
 * already had the filing.
 *
 * Live quotes only.  If the due time is more than a few minutes in the past
 * we mark missed_window instead of writing a "now" price onto a stale event.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { resolveSecret } from '../secrets/infisical.ts';

export const LATENCY_PRICE_EVENTS = [
  'ct_publish',
  'provider_publish',
  'provider_plus_5m',
  'provider_plus_30m',
  'provider_plus_60m',
] as const;

export type LatencyPriceEvent = (typeof LATENCY_PRICE_EVENTS)[number];

const FOLLOW_MS: Record<Exclude<LatencyPriceEvent, 'ct_publish' | 'provider_publish'>, number> = {
  provider_plus_5m: 5 * 60_000,
  provider_plus_30m: 30 * 60_000,
  provider_plus_60m: 60 * 60_000,
};

/** Do not stamp a live quote onto an event that already aged out. */
export const SNAPSHOT_STALE_MS = 3 * 60_000;
const SCHEDULE_BATCH = 80;
const CAPTURE_BATCH = 20;

export function parseFmpQuote(json: unknown): number | null {
  const row = Array.isArray(json) ? json[0] : json;
  if (!row || typeof row !== 'object') return null;
  const price = (row as { price?: unknown }).price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  return price;
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

interface MatchRow {
  trade_hash: string;
  ticker: string | null;
  provider: string;
  congress_first_seen_at: string;
  provider_first_seen_at: string | null;
  provider_published_at: string | null;
}

export function snapshotPlan(row: MatchRow): Array<{ event: LatencyPriceEvent; dueAt: string }> {
  const ticker = (row.ticker || '').trim().toUpperCase();
  if (!ticker || ticker.length > 8) return [];
  const out: Array<{ event: LatencyPriceEvent; dueAt: string }> = [];
  if (row.congress_first_seen_at) {
    out.push({ event: 'ct_publish', dueAt: row.congress_first_seen_at });
  }
  const providerAt = row.provider_published_at || row.provider_first_seen_at;
  if (providerAt) {
    out.push({ event: 'provider_publish', dueAt: providerAt });
    out.push({ event: 'provider_plus_5m', dueAt: addMs(providerAt, FOLLOW_MS.provider_plus_5m) });
    out.push({ event: 'provider_plus_30m', dueAt: addMs(providerAt, FOLLOW_MS.provider_plus_30m) });
    out.push({ event: 'provider_plus_60m', dueAt: addMs(providerAt, FOLLOW_MS.provider_plus_60m) });
  }
  return out;
}

export async function scheduleMissingLatencyPriceSnapshots(
  env: Env,
  now = new Date(),
): Promise<{ scheduled: number }> {
  const rows = await all<MatchRow>(
    env.DB,
    `SELECT c.trade_hash, c.ticker, c.provider, c.congress_first_seen_at,
            c.provider_first_seen_at, c.provider_published_at
       FROM trade_latency_candidates c
      WHERE c.status = 'matched'
        AND c.ticker IS NOT NULL
        AND TRIM(c.ticker) != ''
        AND NOT EXISTS (
          SELECT 1 FROM latency_price_snapshots s
           WHERE s.trade_hash = c.trade_hash AND s.provider = c.provider
        )
      ORDER BY c.updated_at DESC
      LIMIT ?`,
    [SCHEDULE_BATCH],
  ).catch(() => [] as MatchRow[]);

  let scheduled = 0;
  const createdAt = now.toISOString();
  for (const row of rows) {
    const ticker = (row.ticker || '').trim().toUpperCase();
    for (const plan of snapshotPlan(row)) {
      await run(
        env.DB,
        `INSERT OR IGNORE INTO latency_price_snapshots
           (trade_hash, ticker, provider, event, due_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.trade_hash, ticker, row.provider, plan.event, plan.dueAt, createdAt],
      ).catch(() => {});
      scheduled++;
    }
  }
  return { scheduled };
}

async function fmpQuoteKey(env: Env): Promise<string | undefined> {
  const a = await resolveSecret(env, 'FMP_LATENCY_API_KEY');
  if (a.value) return a.value;
  const b = await resolveSecret(env, 'FMP_API_KEY');
  return b.value;
}

export async function fetchLiveQuote(
  env: Env,
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ price: number; source: string } | null> {
  const key = await fmpQuoteKey(env);
  if (!key) return null;
  const base = (env.FMP_STABLE_BASE_URL || 'https://financialmodelingprep.com/stable').replace(/\/$/, '');
  const url = `${base}/quote?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(key)}`;
  const res = await trackedFetch(
    url,
    { headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' } },
    { service: 'market-prices', operation: 'latency-live-quote' },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`fmp_quote_http_${res.status}`);
  const price = parseFmpQuote(await res.json());
  if (price == null) throw new Error('fmp_quote_empty');
  return { price, source: 'fmp_quote' };
}

export async function captureDueLatencyPriceSnapshots(
  env: Env,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ captured: number; missed: number; errors: number }> {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const due = await all<{
    trade_hash: string;
    ticker: string;
    provider: string;
    event: string;
    due_at: string;
  }>(
    env.DB,
    `SELECT trade_hash, ticker, provider, event, due_at
       FROM latency_price_snapshots
      WHERE captured_at IS NULL
        AND (error IS NULL OR error = '')
        AND due_at <= ?
      ORDER BY due_at ASC
      LIMIT ?`,
    [nowIso, CAPTURE_BATCH],
  ).catch(() => []);

  let captured = 0;
  let missed = 0;
  let errors = 0;
  for (const row of due) {
    const dueMs = Date.parse(row.due_at);
    if (!Number.isFinite(dueMs) || nowMs - dueMs > SNAPSHOT_STALE_MS) {
      await run(
        env.DB,
        `UPDATE latency_price_snapshots
            SET error = 'missed_window', captured_at = ?
          WHERE trade_hash = ? AND provider = ? AND event = ?`,
        [nowIso, row.trade_hash, row.provider, row.event],
      ).catch(() => {});
      missed++;
      continue;
    }
    try {
      const quote = await fetchLiveQuote(env, row.ticker, fetchImpl);
      if (!quote) {
        await run(
          env.DB,
          `UPDATE latency_price_snapshots
              SET error = 'no_quote_key', captured_at = ?
            WHERE trade_hash = ? AND provider = ? AND event = ?`,
          [nowIso, row.trade_hash, row.provider, row.event],
        );
        errors++;
        continue;
      }
      await run(
        env.DB,
        `UPDATE latency_price_snapshots
            SET price = ?, source = ?, captured_at = ?, error = NULL
          WHERE trade_hash = ? AND provider = ? AND event = ?`,
        [quote.price, quote.source, nowIso, row.trade_hash, row.provider, row.event],
      );
      captured++;
    } catch (err) {
      await run(
        env.DB,
        `UPDATE latency_price_snapshots
            SET error = ?
          WHERE trade_hash = ? AND provider = ? AND event = ?`,
        [String((err as Error).message || err).slice(0, 200), row.trade_hash, row.provider, row.event],
      ).catch(() => {});
      errors++;
    }
  }
  return { captured, missed, errors };
}

export interface PriceEdgeBucket {
  event: LatencyPriceEvent;
  n: number;
  medianBps: number | null;
}

/** Median basis-point move from provider_publish to each follow-up print. */
export async function summarizeProviderPublishBump(env: Env): Promise<PriceEdgeBucket[]> {
  const rows = await all<{
    event: LatencyPriceEvent;
    bps: number;
  }>(
    env.DB,
    `SELECT later.event AS event,
            10000.0 * (later.price - pub.price) / pub.price AS bps
       FROM latency_price_snapshots pub
       JOIN latency_price_snapshots later
         ON later.trade_hash = pub.trade_hash
        AND later.provider = pub.provider
      WHERE pub.event = 'provider_publish'
        AND later.event IN ('provider_plus_5m', 'provider_plus_30m', 'provider_plus_60m')
        AND pub.price IS NOT NULL AND pub.price > 0
        AND later.price IS NOT NULL`,
  ).catch(() => []);

  const byEvent = new Map<LatencyPriceEvent, number[]>();
  for (const row of rows) {
    const list = byEvent.get(row.event) ?? [];
    list.push(row.bps);
    byEvent.set(row.event, list);
  }
  const out: PriceEdgeBucket[] = [];
  for (const event of ['provider_plus_5m', 'provider_plus_30m', 'provider_plus_60m'] as const) {
    const list = (byEvent.get(event) ?? []).slice().sort((a, b) => a - b);
    const mid = list.length ? list[Math.floor((list.length - 1) / 2)]! : null;
    out.push({ event, n: list.length, medianBps: mid });
  }
  return out;
}

export async function runLatencyPriceSnapshotTick(
  env: Env,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ scheduled: number; captured: number; missed: number; errors: number }> {
  const scheduled = await scheduleMissingLatencyPriceSnapshots(env, now);
  const captured = await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
  return { scheduled: scheduled.scheduled, ...captured };
}
