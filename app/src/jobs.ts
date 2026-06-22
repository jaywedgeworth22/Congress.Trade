/**
 * src/jobs.ts
 * OWNER: foundation
 *
 * Once-a-day background jobs, fired from the cron handler. Gated by a KV date
 * stamp so they run on the first cron tick of each UTC day (and not again that
 * day, even though the watcher cron fires every minute). Both jobs are budgeted
 * and key-gated, so this is a no-op without an FMP key beyond the free SEC pass.
 */

import type { Env } from './shared/types';
import { runEnrichment } from './enrichment/service';
import { runPriceRefresh } from './prices/service';

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
  try {
    await runEnrichment(env, {});
  } catch (err) {
    console.warn('daily enrichment failed:', (err as Error).message);
  }
  try {
    await runPriceRefresh(env, {});
  } catch (err) {
    console.warn('daily price refresh failed:', (err as Error).message);
  }
}
