/**
 * src/jobs.ts
 * OWNER: foundation
 *
 * Once-a-day background jobs, fired from the cron handler. Gated by a KV date
 * stamp so they run on the first cron tick of each UTC day (and not again that
 * day, even though the watcher cron fires every minute). Both jobs are budgeted
 * and key-gated, so this is a no-op without an FMP key beyond the free SEC pass.
 *
 * If FMP calls fail with key/plan errors (401/402/403/429) — i.e. the paid tier
 * stopped working — we email an admin alert (throttled). See alerts/notify.ts.
 */

import type { Env } from './shared/types.ts';
import { run, all } from './shared/db.ts';
import { runEnrichment, getDailyUsed, DEFAULT_DAILY_CAP } from './enrichment/service.ts';
import { runPriceRefresh } from './prices/service.ts';
import { hasFmpTierFailure } from './shared/fmpStatus.ts';
import { notifyAdmin } from './alerts/notify.ts';
import { shareWithPeer, type PeerShareInput } from './share/outbound.ts';
import { runFreshnessCheck } from './share/freshness.ts';
import { runPhotoEnrichment, runTickerBackfill } from './admin/routes.ts';
import { runBulkSnapshot } from './export/snapshot.ts';
import { resolveSecrets } from './secrets/infisical.ts';
import { recordMeasuredThirdPartyUsage } from './shared/thirdPartyTelemetry.ts';
import { isD1RowBudgetExceeded } from './shared/d1Budget.ts';
import { runR2UsageSummary } from './shared/r2Usage.ts';
// NOTE: runHouseReconciler (./ingestion/houseReconciler) is intentionally not
// imported here yet -- it is reserved for future scheduled-job wiring. Importing
// it unused would trip noUnusedLocals (enabled in this PR).

const DAILY_KEY = 'jobs:daily:lastdate';

/**
 * Per-lane KV date stamps (`jobs:daily:lastdate:<lane>`). Each daily lane
 * stamps itself BEFORE running so it fires once per UTC day even when it is
 * scheduled on an hourly cron. The legacy whole-chain stamp (DAILY_KEY) is
 * kept as a fast-path suppressor for the legacy combined entry point
 * (maybeRunDailyJobs) and for tests; dedicated lane crons ignore it.
 */
const LANE_KEY_PREFIX = 'jobs:daily:lastdate:';

export type DailyLaneStatus = 'ran' | 'stamped' | 'budget';

async function stampDaily(env: Env, key: string, day: string): Promise<boolean> {
  try {
    const last = await env.CONFIG_KV.get(key);
    if (last === day) return false;
    // Stamp BEFORE running so the next cron tick doesn't double-fire.
    await env.CONFIG_KV.put(key, day, { expirationTtl: 172800 });
    return true;
  } catch {
    return false; // no KV → skip rather than risk hammering providers
  }
}

async function dailyBudgetExceeded(env: Env, stage: string): Promise<boolean> {
  if (!(await isD1RowBudgetExceeded(env))) return false;
  console.warn(`daily jobs stopped before ${stage}: D1 row budget exceeded`);
  return true;
}

// --- Operational-table retention -------------------------------------------
// dead_letter_events / ingest_log / source_attempts are append-only telemetry
// tables with no pruning path, so they grow without bound (3,517 DLQ rows and
// counting in production). Each is deleted in bounded batches — an `id IN
// (SELECT ... LIMIT n)` subquery, because D1/SQLite has no `DELETE ... LIMIT`
// — capped per run so one daily pass can never blow the D1 write/time budget.
// A backlog larger than the per-run cap simply drains over successive days.

interface RetentionPolicy {
  table: string;
  /** ISO-8601 timestamp column the age cutoff compares against. */
  column: string;
  days: number;
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  { table: 'dead_letter_events', column: 'created_at', days: 30 },
  { table: 'ingest_log', column: 'polled_at', days: 90 },
  { table: 'source_attempts', column: 'attempted_at', days: 30 },
];

/** Rows per DELETE statement — small enough to stay comfortably inside D1's
 *  per-query limits even with index maintenance. */
export const RETENTION_DELETE_BATCH = 500;
/** Batches per table per daily run: caps one pass at 10k rows/table. */
export const RETENTION_MAX_BATCHES_PER_TABLE = 20;

// --- Price-refresh budget floor vs enrichment ------------------------------
// runEnrichment and runPriceRefresh share one daily FMP call counter (see
// getDailyUsed/addDailyUsed in enrichment/service.ts). Enrichment runs FIRST
// each day, and `remainingBudget` has no ceiling of its own beyond the day's
// cap — so a large enrichment backlog (a long tail of newly-traded tickers
// missing sector/market-cap) can legitimately consume the ENTIRE remaining
// budget, leaving runPriceRefresh with 0. Prices then silently stop updating
// for the rest of the day while enrichment happily keeps backfilling company
// profiles. Reserving a floor here — by capping enrichment's own `max` opt —
// guarantees price refresh always gets at least a slice of today's budget.

/** Fraction of the day's FMP cap reserved for price refresh before enrichment
 *  is allowed to spend the rest. 20% is deliberately generous: on the
 *  configured paid-tier cap (FMP_DAILY_CALL_CAP, e.g. 5000) the reserved floor
 *  is far more than price refresh's typical daily need (one SPX call + a
 *  bounded backlog), while on the free-tier DEFAULT_DAILY_CAP fallback (230)
 *  it still leaves enrichment a workable ~184-call share. */
export const PRICE_REFRESH_BUDGET_FLOOR_FRACTION = 0.2;

/**
 * How many more FMP calls enrichment may spend this run, so at least
 * PRICE_REFRESH_BUDGET_FLOOR_FRACTION of today's remaining cap survives for
 * runPriceRefresh right after it. Returns `undefined` (no cap — prior
 * behavior) when no FMP key is configured: without a key, enrichment's
 * SEC-only pass and price refresh (if it even has a usable provider) don't
 * actually share the FMP budget, so there is no contention to guard against,
 * and capping it here would just needlessly shrink the free/keyless scan
 * limit (see runEnrichment's own `hasFmp ? fmpBudget : ... : 200` default).
 */
async function enrichmentBudgetFloorMax(
  env: Env,
  fmpApiKey: string | undefined,
  fmpDailyCallCap: string | undefined,
): Promise<number | undefined> {
  if (!fmpApiKey) return undefined;
  const cap = parseInt(fmpDailyCallCap || '', 10) || DEFAULT_DAILY_CAP;
  const usedBefore = await getDailyUsed(env);
  const remainingToday = Math.max(0, cap - usedBefore);
  const priceRefreshFloor = Math.min(remainingToday, Math.ceil(cap * PRICE_REFRESH_BUDGET_FLOOR_FRACTION));
  return Math.max(0, remainingToday - priceRefreshFloor);
}

/**
 * Delete expired rows from the operational tables above. Best-effort: a
 * failure on one table (e.g. table missing on a fresh preview DB) is logged
 * and does not stop the others. Returns rows deleted per table for tests and
 * log lines.
 */
export async function runRetentionSweep(env: Env, now = new Date()): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const policy of RETENTION_POLICIES) {
    const cutoff = new Date(now.getTime() - policy.days * 86_400_000).toISOString();
    let total = 0;
    try {
      for (let batch = 0; batch < RETENTION_MAX_BATCHES_PER_TABLE; batch++) {
        const res = await run(
          env.DB,
          `DELETE FROM ${policy.table} WHERE id IN (SELECT id FROM ${policy.table} WHERE ${policy.column} < ? LIMIT ?)`,
          [cutoff, RETENTION_DELETE_BATCH],
        );
        const changes = Number(res.meta?.changes ?? 0);
        total += changes;
        if (changes < RETENTION_DELETE_BATCH) break; // backlog drained
      }
    } catch (err) {
      console.warn(`retention sweep failed for ${policy.table}:`, (err as Error).message);
    }
    deleted[policy.table] = total;
  }
  return deleted;
}

/**
 * Delete filings, transactions, and corresponding R2 PDFs that are older than 5 years.
 * We rely on 'filed_date' from filings table.
 *
 * Rows with a NULL filed_date would never satisfy `filed_date < ?` (NULL
 * comparisons are not true), so they accumulated forever; the sweep now falls
 * back to the ingestion date (`first_seen_at`) for those rows — a filing we
 * ingested more than 5 years ago whose source never yielded a filed_date is
 * safe to prune. Delivery bookkeeping rows (deliveries / delivery_outbox) that
 * reference the batch's transactions are deleted alongside them so the sweep
 * does not orphan delivery rows pointing at removed transactions.
 */
export async function runFilingRetentionSweep(env: Env, now = new Date()): Promise<number> {
  const fiveYearsAgo = new Date(now.getTime() - 5 * 365 * 86_400_000);
  const cutoff = fiveYearsAgo.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  
  let totalDeleted = 0;
  try {
    for (let batch = 0; batch < RETENTION_MAX_BATCHES_PER_TABLE; batch++) {
      const rows = await all<{ doc_id: string; raw_object_key: string | null }>(
        env.DB,
        `SELECT doc_id, raw_object_key FROM filings
          WHERE COALESCE(filed_date, substr(first_seen_at, 1, 10)) < ? LIMIT ?`,
        [cutoff, RETENTION_DELETE_BATCH]
      );
      
      if (rows.length === 0) break;
      
      for (const row of rows) {
        if (row.raw_object_key) {
          try {
            await env.RAW_FILES.delete(row.raw_object_key);
          } catch (e) {
            console.warn(`Failed to delete raw file ${row.raw_object_key} from R2`, e);
          }
        }
      }
      
      const docIds = rows.map(r => r.doc_id);
      const placeholders = docIds.map(() => '?').join(',');
      
      // Delivery bookkeeping first: deliveries/delivery_outbox reference
      // transactions by tx_id and must not be orphaned when the batch's
      // transactions are removed below.
      await run(
        env.DB,
        `DELETE FROM deliveries WHERE tx_id IN (SELECT id FROM transactions WHERE doc_id IN (${placeholders}))`,
        docIds
      );

      await run(
        env.DB,
        `DELETE FROM delivery_outbox WHERE tx_id IN (SELECT id FROM transactions WHERE doc_id IN (${placeholders}))`,
        docIds
      );

      await run(
        env.DB,
        `DELETE FROM tx_cursor_seq WHERE tx_id IN (SELECT id FROM transactions WHERE doc_id IN (${placeholders}))`,
        docIds
      );
      
      await run(
        env.DB,
        `DELETE FROM transactions WHERE doc_id IN (${placeholders})`,
        docIds
      );
      
      await run(
        env.DB,
        `DELETE FROM filings WHERE doc_id IN (${placeholders})`,
        docIds
      );
      
      totalDeleted += rows.length;
    }
  } catch (err) {
    console.warn('filing retention sweep failed:', (err as Error).message);
  }
  return totalDeleted;
}

/**
 * Daily lane 1 — market data: a TIME-SLICED enrichment pass (so a deep
 * backlog can never starve the rest of the lane), then price refresh, peer
 * share, usage telemetry, FMP-tier alert, and the cross-app freshness
 * watchdog. Runs on its own daily cron window (see deno/cronLanes.ts) with a
 * multi-minute deadline, NOT inside the 45s 15-minute tick. Own KV date
 * stamp; once per UTC day. The remaining enrichment backlog drains through
 * the day via the hourly `hourly-enrichment` lane.
 */
export async function maybeRunDailyMarketDataJobs(
  env: Env,
  now = new Date(),
  opts: { signal?: AbortSignal; enrichmentDeadlineMs?: number } = {},
): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);
  if (!(await stampDaily(env, LANE_KEY_PREFIX + 'market-data', day))) return 'stamped';

  // Opt-in D1 spend guard (D1_ROW_BUDGET_ENFORCE): if today's metered D1 rows
  // already exceeded the budget, skip this discretionary daily batch — its big
  // enrichment/price/backfill upserts are the main controllable D1 write spend.
  // Default OFF (alert-only). The date stamp above stays set, so we don't
  // re-check every minute; a fresh budget frees the jobs next UTC day.
  if (await dailyBudgetExceeded(env, 'enrichment')) {
    return 'budget';
  }

  const errors: string[] = [];
  let hadFmpKey = false;
  let fmpDailyCap: number | null = null;
  let enrichmentFmpCalls = 0;
  let priceProviderCalls = 0;
  const share: PeerShareInput = {};
  // Resolve provider-pacing + usage-monitor telemetry vars together (Infisical-backed,
  // falling back to the wrangler.toml env var whenever a name isn't set in Infisical)
  // so the whole daily run only pays for one resolveSecrets round trip.
  const secrets = await resolveSecrets(env, [
    'FMP_MAX_PER_MINUTE',
    'EDGAR_MAX_PER_MINUTE',
    'USAGE_MONITOR_ENABLED',
    'USAGE_MONITOR_INGEST_URL',
    'USAGE_MONITOR_INGEST_TOKEN',
    'USAGE_MONITOR_ENVIRONMENT',
    'PRICE_PROVIDER',
    'FMP_API_KEY',
    'FMP_DAILY_CALL_CAP',
    // R2 usage summary + Pushover delivery — folded into this one round trip.
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_R2_ANALYTICS_TOKEN',
    'PUSHOVER_APP_TOKEN',
    'PUSHOVER_USER_KEY',
  ]);
  // Paid FMP tiers are rate-limited per MINUTE (Starter ~300/min), not per day —
  // so pace calls to use that headroom without tripping 429s. Configurable via
  // FMP_MAX_PER_MINUTE; unset = no pacing (prior behavior). The per-day ceiling
  // is FMP_DAILY_CALL_CAP (raise it on a paid plan so enrichment isn't throttled).
  const maxPerMinute = parseInt(secrets.FMP_MAX_PER_MINUTE || '', 10) || undefined;
  // SEC EDGAR has its own, separate fair-access pacer (not the FMP budget above)
  // — configurable via EDGAR_MAX_PER_MINUTE, unset = no pacing.
  const edgarMaxPerMinute = parseInt(secrets.EDGAR_MAX_PER_MINUTE || '', 10) || undefined;
  // Reserve a slice of today's shared FMP budget for price refresh before
  // enrichment (which runs first) is allowed to spend the rest — see
  // enrichmentBudgetFloorMax above.
  const enrichmentMax = await enrichmentBudgetFloorMax(env, secrets.FMP_API_KEY, secrets.FMP_DAILY_CALL_CAP);

  try {
    // Time-sliced: stop picking up new candidates after enrichmentDeadlineMs
    // (default 4 min) so price refresh + share + freshness ALWAYS run today;
    // the hourly-enrichment lane keeps draining the backlog afterwards.
    const r = await runEnrichment(env, {
      maxPerMinute,
      edgarMaxPerMinute,
      max: enrichmentMax,
      signal: opts.signal,
      deadlineMs: opts.enrichmentDeadlineMs ?? 4 * 60_000,
    });
    hadFmpKey = hadFmpKey || r.hasFmpKey;
    fmpDailyCap = r.dailyCap;
    enrichmentFmpCalls = r.fmpCalls;
    errors.push(...r.errors);
    share.refs = r.shareRefs;
  } catch (err) {
    console.warn('daily enrichment failed:', (err as Error).message);
    errors.push('enrichment: ' + (err as Error).message);
  }
  if (await dailyBudgetExceeded(env, 'price refresh')) return 'budget';
  try {
    const r = await runPriceRefresh(env, { maxPerMinute });
    hadFmpKey = hadFmpKey || r.hasFmpKey;
    priceProviderCalls = r.fmpCalls;
    errors.push(...r.errors);
    share.prices = r.sharePrices;
    share.spx = r.shareSpx;
  } catch (err) {
    console.warn('daily price refresh failed:', (err as Error).message);
    errors.push('prices: ' + (err as Error).message);
  }

  // Return half of the cross-app share: push what WE fetched this run to App B
  // (no-op unless APP_B_IMPORT_URL + APP_B_INGEST_TOKEN are set). Our delta only,
  // so data App B sent us is never echoed back.
  try {
    const res = await shareWithPeer(env, share);
    if (res.sent) console.log('shared to peer:', JSON.stringify(res.counts));
    else if (res.reason && !/not configured|nothing to share/.test(res.reason)) {
      console.warn('peer share failed:', res.reason);
    }
  } catch (err) {
    console.warn('peer share error:', (err as Error).message);
  }

  // Individual FMP attempts are emitted by trackedFetch. Only report the plan
  // ceiling here; emitting the cumulative daily counter again would double-count
  // calls in Usage Monitor.
  if (fmpDailyCap != null) {
    await recordMeasuredThirdPartyUsage(env, {
      provider: 'fmp',
      service: 'market-data',
      operation: 'daily-call-limit',
      metricType: 'limit',
      quantity: fmpDailyCap,
      unit: 'call',
      billingMode: 'actual',
      confidence: 'actual',
      metadata: {
        job: 'daily-refresh',
        fmpCallsThisRun: enrichmentFmpCalls + priceProviderCalls,
        priceProvider: (secrets.PRICE_PROVIDER || 'fmp').toLowerCase(),
        errors: errors.length,
      },
    });
  }

  // Only alert when a key is configured (so we don't email about an intentional
  // free/SEC-only setup) and the failures are key/plan-level, not "no data".
  if (hadFmpKey && hasFmpTierFailure(errors)) {
    const sample = errors.filter((e) => /FMP_HTTP_/.test(e)).slice(0, 5).join('\n');
    await notifyAdmin(env, {
      dedupeKey: 'fmp-tier-failure',
      subject: 'Congress.Trade ⚠️ FMP data refresh is failing',
      text:
        "Today's FMP enrichment / price refresh hit key/plan errors (401/402/403/429).\n" +
        'This usually means the FMP API key is invalid, the paid plan lapsed, or you are being\n' +
        'rate-limited (effectively back on the free tier). Sector / market-cap / price data will\n' +
        'stop updating until it is fixed.\n\n' +
        'Sample errors:\n' +
        sample +
        '\n\nCheck your FMP plan + the FMP_API_KEY secret. The job retries automatically each day;\n' +
        "you'll get at most one of these alerts every 12 hours.",
    });
  }

  // Cross-app freshness watchdog: alert if a donated market-data stream (S&P /
  // prices / fundamentals) has gone stale — i.e. the partner's push or our own
  // refresh quietly stopped. Throttled + best-effort; never blocks the cron.
  try {
    await runFreshnessCheck(env, now);
  } catch (err) {
    console.warn('freshness check failed:', (err as Error).message);
  }
  return 'ran';
}

/**
 * Hourly lane — enrichment drain. Time-sliced FMP/SEC enrichment with NO
 * daily date stamp: the daily FMP call cap and the un-enriched candidate
 * predicates self-limit total spend, so firing hourly simply drains the
 * backlog in ~8-minute slices instead of one midnight marathon that can
 * starve everything behind it. Once the day's market-data lane has run
 * (price refresh done), the 20% price-refresh budget floor no longer applies.
 * Each run's freshly enriched refs are shared to the peer (delta only).
 */
export const HOURLY_ENRICHMENT_SLICE_MAX = 1200;
export const HOURLY_ENRICHMENT_SLICE_DEADLINE_MS = 8 * 60_000;

export interface HourlyEnrichmentResult {
  scanned: number;
  enriched: number;
  fmpCalls: number;
  budgetRemaining: number;
  remainingBacklog: boolean;
}

export async function runHourlyEnrichmentSlice(
  env: Env,
  now = new Date(),
  opts: { signal?: AbortSignal; deadlineMs?: number; max?: number } = {},
): Promise<HourlyEnrichmentResult> {
  const day = now.toISOString().slice(0, 10);
  const secrets = await resolveSecrets(env, [
    'FMP_MAX_PER_MINUTE',
    'EDGAR_MAX_PER_MINUTE',
    'FMP_API_KEY',
    'FMP_DAILY_CALL_CAP',
  ]);
  const maxPerMinute = parseInt(secrets.FMP_MAX_PER_MINUTE || '', 10) || undefined;
  const edgarMaxPerMinute = parseInt(secrets.EDGAR_MAX_PER_MINUTE || '', 10) || undefined;
  // The 20% floor protects the daily price refresh only until it has run;
  // afterwards the full remaining budget is available to the drain.
  let priceRefreshDone = false;
  try {
    priceRefreshDone =
      (await env.CONFIG_KV.get(LANE_KEY_PREFIX + 'market-data')) === day;
  } catch {
    priceRefreshDone = false;
  }
  const floorMax = priceRefreshDone
    ? undefined
    : await enrichmentBudgetFloorMax(env, secrets.FMP_API_KEY, secrets.FMP_DAILY_CALL_CAP);
  const max = Math.max(
    0,
    Math.min(floorMax ?? Number.MAX_SAFE_INTEGER, opts.max ?? HOURLY_ENRICHMENT_SLICE_MAX),
  );
  const empty: HourlyEnrichmentResult = {
    scanned: 0, enriched: 0, fmpCalls: 0, budgetRemaining: 0, remainingBacklog: false,
  };
  if (max <= 0) return empty;

  const r = await runEnrichment(env, {
    maxPerMinute,
    edgarMaxPerMinute,
    max,
    signal: opts.signal,
    deadlineMs: opts.deadlineMs ?? HOURLY_ENRICHMENT_SLICE_DEADLINE_MS,
  });
  // Share this slice's delta (never echoes back what the peer sent us).
  if (r.shareRefs.length > 0) {
    try {
      await shareWithPeer(env, { refs: r.shareRefs });
    } catch (err) {
      console.warn('hourly enrichment peer share failed:', (err as Error).message);
    }
  }
  return {
    scanned: r.scanned,
    enriched: r.enriched,
    fmpCalls: r.fmpCalls,
    budgetRemaining: r.budgetRemaining,
    // Heuristic for observability: a slice that hit its caps probably left
    // backlog for the next hourly window.
    remainingBacklog: r.scanned >= max || r.budgetRemaining <= 0,
  };
}

/**
 * Daily lane 2 — bulk market-data snapshot to R2 (prices, S&P, securities
 * reference, fundamentals, analyst consensus) for App B to pull. Scheduled
 * AFTER the market-data lane's window so it captures the freshest data
 * written today. Best-effort + bounded; never blocks the cron.
 */
export async function maybeRunDailySnapshotJob(env: Env, now = new Date()): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);
  if (!(await stampDaily(env, LANE_KEY_PREFIX + 'snapshot', day))) return 'stamped';
  if (await dailyBudgetExceeded(env, 'bulk snapshot')) return 'budget';

  try {
    const manifest = await runBulkSnapshot(env, day, now);
    const rows = Object.values(manifest.tables).reduce((s, t: any) => s + t.rowCount, 0);
    console.log('bulk snapshot written:', day, rows, 'rows');
  } catch (err) {
    console.warn('bulk snapshot failed:', (err as Error).message);
  }
  return 'ran';
}

/**
 * Daily lane 3 — filer data: politician headshots + party/state/district from
 * congress-legislators (also fills resolved_bioguide_id), then ticker
 * resolution backfill for name-but-no-ticker rows. Both COALESCE-preserving,
 * bounded, and best-effort.
 */
export async function maybeRunDailyFilerJobs(env: Env, now = new Date()): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);
  if (!(await stampDaily(env, LANE_KEY_PREFIX + 'filer', day))) return 'stamped';
  if (await dailyBudgetExceeded(env, 'photo enrichment')) return 'budget';

  try {
    await runPhotoEnrichment(env);
  } catch (err) {
    console.warn('photo enrichment failed:', (err as Error).message);
  }

  if (await dailyBudgetExceeded(env, 'ticker backfill')) return 'budget';

  try {
    await runTickerBackfill(env, 5000);
  } catch (err) {
    console.warn('ticker backfill failed:', (err as Error).message);
  }
  return 'ran';
}

/**
 * Daily lane 4 — retention: prune unbounded operational tables
 * (dead_letter_events / ingest_log / source_attempts) in bounded batches,
 * then the 5-year filing retention sweep (filings + transactions + R2 PDFs).
 */
export async function maybeRunDailyRetentionJobs(env: Env, now = new Date()): Promise<DailyLaneStatus> {
  const day = now.toISOString().slice(0, 10);
  if (!(await stampDaily(env, LANE_KEY_PREFIX + 'retention', day))) return 'stamped';

  // Daily R2 free-tier usage summary → Pushover. Two HTTP calls and zero DB
  // writes, so it deliberately runs BEFORE the dailyBudgetExceeded gate: an
  // over-budget day is exactly when this report must still go out. No-ops
  // when the Cloudflare analytics token or Pushover creds are unconfigured.
  try {
    const r2Secrets = await resolveSecrets(env, [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_R2_ANALYTICS_TOKEN',
      'PUSHOVER_APP_TOKEN',
      'PUSHOVER_USER_KEY',
    ]);
    const r2 = await runR2UsageSummary(env, now, r2Secrets);
    if (!r2.sent && r2.reason && !/not configured/.test(r2.reason)) {
      console.warn('r2 usage summary not sent:', r2.reason);
    }
  } catch (err) {
    console.warn('r2 usage summary failed:', (err as Error).message);
  }

  if (await dailyBudgetExceeded(env, 'retention sweep')) return 'budget';

  // Prune unbounded operational tables (dead_letter_events / ingest_log /
  // source_attempts). Bounded batches + per-run cap; never blocks the cron.
  try {
    const swept = await runRetentionSweep(env, now);
    const total = Object.values(swept).reduce((s, n) => s + n, 0);
    if (total > 0) console.log('retention sweep deleted rows:', JSON.stringify(swept));
  } catch (err) {
    console.warn('retention sweep failed:', (err as Error).message);
  }

  // 5-Year Data Retention Sweep
  try {
    const deletedFilings = await runFilingRetentionSweep(env, now);
    if (deletedFilings > 0) {
      console.log('5-year filing retention sweep deleted old filings:', deletedFilings);
    }
  } catch (err) {
    console.warn('5-year filing retention sweep failed:', (err as Error).message);
  }
  return 'ran';
}

/**
 * Legacy combined entry point (Workers scheduled path, POST runtime-tick when
 * the internal cron is disabled, and tests). Runs all four daily lanes in
 * chain order, preserving the original semantics: one DAILY_KEY stamp
 * suppresses repeat calls same-day, and a D1-budget trip in any lane ends
 * the whole pass. Dedicated lane crons (deno/cronLanes.ts) call the lane
 * functions directly and ignore DAILY_KEY.
 */
export async function maybeRunDailyJobs(env: Env, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (!(await stampDaily(env, DAILY_KEY, day))) return;
  const lanes = [
    maybeRunDailyMarketDataJobs,
    maybeRunDailySnapshotJob,
    maybeRunDailyFilerJobs,
    maybeRunDailyRetentionJobs,
  ];
  for (const lane of lanes) {
    if ((await lane(env, now)) === 'budget') return;
  }
}
