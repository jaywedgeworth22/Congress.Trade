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

const DAILY_KEY = 'jobs:daily:lastdate';

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

  const errors: string[] = [];
  let hadFmpKey = false;
  const share: PeerShareInput = {};
  // Paid FMP tiers are rate-limited per MINUTE (Starter ~300/min), not per day —
  // so pace calls to use that headroom without tripping 429s. Configurable via
  // FMP_MAX_PER_MINUTE; unset = no pacing (prior behavior). The per-day ceiling
  // is FMP_DAILY_CALL_CAP (raise it on a paid plan so enrichment isn't throttled).
  const maxPerMinute =
    parseInt((env as { FMP_MAX_PER_MINUTE?: string }).FMP_MAX_PER_MINUTE || '', 10) || undefined;

  try {
    const r = await runEnrichment(env, { maxPerMinute });
    hadFmpKey = hadFmpKey || r.hasFmpKey;
    errors.push(...r.errors);
    share.refs = r.shareRefs;
  } catch (err) {
    console.warn('daily enrichment failed:', (err as Error).message);
    errors.push('enrichment: ' + (err as Error).message);
  }
  try {
    const r = await runPriceRefresh(env, { maxPerMinute });
    hadFmpKey = hadFmpKey || r.hasFmpKey;
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
}
