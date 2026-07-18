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

import type { Env } from './shared/types';
import { runEnrichment } from './enrichment/service';
import { runPriceRefresh } from './prices/service';
import { hasFmpTierFailure } from './shared/fmpStatus';
import { notifyAdmin } from './alerts/notify';
import { shareWithPeer, type PeerShareInput } from './share/outbound';
import { runFreshnessCheck } from './share/freshness';
import { runPhotoEnrichment, runTickerBackfill } from './admin/routes';
import { runBulkSnapshot } from './export/snapshot';
import { resolveSecrets } from './secrets/infisical';
import { recordMeasuredThirdPartyUsage } from './shared/thirdPartyTelemetry';
import { isD1RowBudgetExceeded } from './shared/d1Budget';
// NOTE: runHouseReconciler (./ingestion/houseReconciler) is intentionally not
// imported here yet -- it is reserved for future scheduled-job wiring. Importing
// it unused would trip noUnusedLocals (enabled in this PR).

const DAILY_KEY = 'jobs:daily:lastdate';

async function dailyBudgetExceeded(env: Env, stage: string): Promise<boolean> {
  if (!(await isD1RowBudgetExceeded(env))) return false;
  console.warn(`daily jobs stopped before ${stage}: D1 row budget exceeded`);
  return true;
}

export async function maybeRunDailyJobs(env: Env, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  try {
    const last = await env.CONFIG_KV.get(DAILY_KEY);
    if (last === day) return;
    // Stamp BEFORE running so the next minute's cron tick doesn't double-fire.
    await env.CONFIG_KV.put(DAILY_KEY, day, { expirationTtl: 172800 });
  } catch {
    return; // no KV → skip rather than risk hammering providers every minute
  }

  // Opt-in D1 spend guard (D1_ROW_BUDGET_ENFORCE): if today's metered D1 rows
  // already exceeded the budget, skip this discretionary daily batch — its big
  // enrichment/price/backfill upserts are the main controllable D1 write spend.
  // Default OFF (alert-only). The date stamp above stays set, so we don't
  // re-check every minute; a fresh budget frees the jobs next UTC day.
  if (await dailyBudgetExceeded(env, 'enrichment')) {
    return;
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
  ]);
  // Paid FMP tiers are rate-limited per MINUTE (Starter ~300/min), not per day —
  // so pace calls to use that headroom without tripping 429s. Configurable via
  // FMP_MAX_PER_MINUTE; unset = no pacing (prior behavior). The per-day ceiling
  // is FMP_DAILY_CALL_CAP (raise it on a paid plan so enrichment isn't throttled).
  const maxPerMinute = parseInt(secrets.FMP_MAX_PER_MINUTE || '', 10) || undefined;
  // SEC EDGAR has its own, separate fair-access pacer (not the FMP budget above)
  // — configurable via EDGAR_MAX_PER_MINUTE, unset = no pacing.
  const edgarMaxPerMinute = parseInt(secrets.EDGAR_MAX_PER_MINUTE || '', 10) || undefined;

  try {
    const r = await runEnrichment(env, { maxPerMinute, edgarMaxPerMinute });
    hadFmpKey = hadFmpKey || r.hasFmpKey;
    fmpDailyCap = r.dailyCap;
    enrichmentFmpCalls = r.fmpCalls;
    errors.push(...r.errors);
    share.refs = r.shareRefs;
  } catch (err) {
    console.warn('daily enrichment failed:', (err as Error).message);
    errors.push('enrichment: ' + (err as Error).message);
  }
  if (await dailyBudgetExceeded(env, 'price refresh')) return;
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

  if (await dailyBudgetExceeded(env, 'bulk snapshot')) return;

  // Write the daily bulk market-data snapshot to R2 (prices, S&P, securities
  // reference, fundamentals, analyst consensus) for App B to pull. Runs AFTER
  // the enrichment + price refresh above so it captures the freshest data
  // written today. Best-effort + bounded; never blocks the cron.
  try {
    const manifest = await runBulkSnapshot(env, day, now);
    const rows = Object.values(manifest.tables).reduce((s, t) => s + t.rowCount, 0);
    console.log('bulk snapshot written:', day, rows, 'rows');
  } catch (err) {
    console.warn('bulk snapshot failed:', (err as Error).message);
  }

  if (await dailyBudgetExceeded(env, 'photo enrichment')) return;

  // Fill politician headshots + party/state/district from congress-legislators.
  // Best-effort, COALESCE-preserving, so new filers get a photo/party without a
  // manual POST /enrich-photos. Never blocks the cron.
  try {
    await runPhotoEnrichment(env);
  } catch (err) {
    console.warn('photo enrichment failed:', (err as Error).message);
  }

  if (await dailyBudgetExceeded(env, 'ticker backfill')) return;

  // Backfill ticker resolution for name-but-no-ticker rows (seed/historic), so
  // they become visible to the leaderboards. Bounded + best-effort.
  try {
    await runTickerBackfill(env, 5000);
  } catch (err) {
    console.warn('ticker backfill failed:', (err as Error).message);
  }
}
