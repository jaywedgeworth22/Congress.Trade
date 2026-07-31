/**
 * Staggered daily lane crons (Deno runtime).
 *
 * Background: the once-a-day job chain (FMP enrichment, price refresh, bulk
 * R2 snapshot, photo enrichment, ticker backfill, retention sweeps) used to
 * run inside the 15-minute scheduled tick, which carries a 45s deadline left
 * over from Deno Deploy free-tier constraints. Provider-paced network lanes
 * routinely blew that deadline, and because the whole chain shared one KV
 * date stamp, every lane after the abort silently never ran that day — most
 * visibly photo enrichment (bioguide/photo fill) and the bulk R2 snapshot.
 *
 * On the Oracle container there is no 45s platform limit, so each daily lane
 * now gets its OWN hourly cron window (first run of the UTC day wins; the
 * lane's KV date stamp makes later same-day firings cheap no-ops) and its own
 * multi-minute deadline. Windows are staggered so lanes never compete, and
 * ordered so the snapshot lane runs after the market-data lane it snapshots.
 * Minutes avoid :00/:30 per fleet scheduling policy.
 */

import type { Env } from '../shared/types.ts';
import {
  maybeRunDailyMarketDataJobs,
  maybeRunDailySnapshotJob,
  maybeRunDailyFilerJobs,
  maybeRunDailyRetentionJobs,
  type DailyLaneStatus,
} from '../jobs.ts';
import { acquireDenoCronSingleton, type TickSingletonLock } from './scheduledTick.ts';

export interface DailyLaneCron {
  /** Lane identifier; also the singleton-lock key suffix and log tag. */
  name: string;
  /** Crontab expression (UTC). Hourly; the lane's KV stamp gates once/day. */
  schedule: string;
  run: (env: Env, now: Date) => Promise<DailyLaneStatus>;
}

export const DAILY_LANE_CRONS: readonly DailyLaneCron[] = [
  // Market data first: enrichment + price refresh write the day's fresh rows.
  { name: 'daily-market-data', schedule: '7 * * * *', run: maybeRunDailyMarketDataJobs },
  // Snapshot after market data so it captures today's freshest data.
  { name: 'daily-snapshot', schedule: '22 * * * *', run: maybeRunDailySnapshotJob },
  // Filer data (photos/bioguide + ticker backfill).
  { name: 'daily-filer', schedule: '37 * * * *', run: maybeRunDailyFilerJobs },
  // Retention sweeps last, clear of every write-heavy lane.
  { name: 'daily-retention', schedule: '53 * * * *', run: maybeRunDailyRetentionJobs },
];

/** Per-lane deadline. The tick's 45s was a Deno Deploy free-tier constraint;
 *  on the Oracle container a lane may take minutes (provider pacing). */
export const DAILY_LANE_DEFAULT_DEADLINE_MS = 10 * 60_000;

function parseDeadlineMs(raw: string | undefined): number {
  const n = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n < 10_000) return DAILY_LANE_DEFAULT_DEADLINE_MS;
  return Math.min(n, 30 * 60_000);
}

/** Env override (CT_ prefix; Deno Deploy forbade DENO_* names). */
export function resolveDailyLaneDeadlineMs(
  env: Record<string, string | undefined> | { get?: (k: string) => string | undefined } = {},
): number {
  const read = (key: string): string | undefined =>
    typeof (env as { get?: (k: string) => string | undefined }).get === 'function'
      ? (env as { get: (k: string) => string | undefined }).get(key) ?? undefined
      : (env as Record<string, string | undefined>)[key];
  return parseDeadlineMs(read('CT_DAILY_LANE_DEADLINE_MS') ?? read('DENO_DAILY_LANE_DEADLINE_MS'));
}

export interface DailyLaneRunResult {
  status: DailyLaneStatus | 'error' | 'skipped-overlap' | 'aborted';
  durationMs: number;
}

/**
 * Run one daily lane with overlap guard, DB-backed cross-isolate singleton,
 * and an abort deadline. Exported for tests; the cron closures below delegate
 * here. Fail-open on lock-table errors (a KV problem must not park daily work).
 */
export async function runDailyLane(
  lane: DailyLaneCron,
  env: Env,
  now = new Date(),
  deadlineMs = DAILY_LANE_DEFAULT_DEADLINE_MS,
): Promise<DailyLaneRunResult> {
  const started = Date.now();
  let lock: TickSingletonLock | null = null;
  let lockUnavailable = false;
  try {
    lock = await acquireDenoCronSingleton(env, lane.name, now, deadlineMs + 30_000);
  } catch (err) {
    lockUnavailable = true;
    console.warn(`daily lane ${lane.name}: singleton lock unavailable; running unguarded:`, (err as Error).message);
  }
  if (!lock && !lockUnavailable) {
    return { status: 'skipped-overlap', durationMs: Date.now() - started };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`daily lane ${lane.name} exceeded ${deadlineMs}ms deadline`)), deadlineMs);
  try {
    const status = await Promise.race([
      lane.run(env, now),
      new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason));
      }),
    ]);
    return { status, durationMs: Date.now() - started };
  } catch (err) {
    if (abort.signal.aborted) {
      console.warn(`daily lane ${lane.name} aborted at deadline:`, (err as Error).message);
      return { status: 'aborted', durationMs: Date.now() - started };
    }
    console.error(`daily lane ${lane.name} caught error:`, err);
    return { status: 'error', durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    if (lock) {
      try {
        await lock.release();
      } catch (err) {
        console.warn(`daily lane ${lane.name}: singleton release failed:`, (err as Error).message);
      }
    }
  }
}

/**
 * Register every daily lane as its own Deno.cron entry. In-isolate in-flight
 * guards cover Deno.cron not waiting for slow previous invocations; the
 * DB singleton inside runDailyLane covers any cross-isolate overlap.
 */
export function registerDailyLaneCrons(
  buildEnv: () => Env,
  deadlineMs = DAILY_LANE_DEFAULT_DEADLINE_MS,
): void {
  const inFlight = new Set<string>();
  for (const lane of DAILY_LANE_CRONS) {
    // Deno.cron names allow only alphanumerics, whitespace, hyphens, underscores.
    Deno.cron(`daily-lane ${lane.name}`, lane.schedule, async () => {
      if (inFlight.has(lane.name)) {
        console.warn(`daily lane ${lane.name} skipped: previous run still in flight`);
        return;
      }
      inFlight.add(lane.name);
      try {
        const result = await runDailyLane(lane, buildEnv(), new Date(), deadlineMs);
        if (result.status !== 'stamped') {
          console.log(`daily lane ${lane.name} ${result.status} in ${result.durationMs}ms`);
        }
      } finally {
        inFlight.delete(lane.name);
      }
    });
  }
  console.log(
    `Daily lane crons registered: ${DAILY_LANE_CRONS.map((l) => `${l.name}="${l.schedule}"`).join(' ')} deadlineMs=${deadlineMs}`,
  );
}
