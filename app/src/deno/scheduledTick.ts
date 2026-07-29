/**
 * Shared Deno scheduled-tick body: watcher → outbox flush → durable queue drain
 * → daily jobs. Used by Deno.cron and by POST /api/admin/runtime-tick so Coolify
 * (or any external scheduler) can own background work and leave Deno Deploy as
 * an HTTP edge only.
 */

import type { Env } from '../shared/types.ts';
import { flushD1Budget } from '../shared/d1Budget.ts';
import { maybeRunDailyJobs } from '../jobs.ts';
import { runWatcher } from '../ingestion/watcher.ts';
import { runDisclosureLatencyProbe } from '../ingestion/tradeLatency.ts';
import { flushDeliveryOutbox } from '../delivery/outbox.ts';
import { flushParkedDeliveries } from '../delivery/targetCircuit.ts';
import { flushIngestionOutbox } from '../ingestion/outbox.ts';
import { maybeRunAgreementAutopublish } from '../extraction/agreement.ts';
import { maybeStartBacklogAutopilot } from '../extraction/autopilot.ts';
import { refreshSecrets } from '../secrets/infisical.ts';
import { flushUsageTelemetryFallback } from '../shared/thirdPartyTelemetry.ts';
import {
  drainDurableQueues,
  type DurableQueueHandlers,
} from './durableQueue.ts';
import type { DenoCostProfile } from './costProfile.ts';

export interface PendingWorkProbe {
  ingestQueue: boolean;
  deliveryQueue: boolean;
  ingestionOutbox: boolean;
  deliveryOutbox: boolean;
}

export interface ScheduledTickResult {
  profile: DenoCostProfile['name'];
  skippedDrain: boolean;
  /** True when another live tick holds the singleton lock; no lanes ran. */
  skippedOverlap: boolean;
  /** True when the AbortSignal stopped the pipeline between lanes. */
  aborted: boolean;
  watcher: Awaited<ReturnType<typeof runWatcher>> | null;
  /** Per-tick agreement cron backstop (enqueue only). Null when disabled/errored. */
  agreementAutopublish: Awaited<ReturnType<typeof maybeRunAgreementAutopublish>> | null;
  /** Backlog autopilot gate (may start a run / report blocked). Null on error. */
  autopilot: Awaited<ReturnType<typeof maybeStartBacklogAutopilot>> | null;
  ingestionOutbox: { claimed: number; enqueued: number; failed: number } | null;
  deliveryOutbox: { claimed: number; enqueued: number; failed: number } | null;
  drained: {
    ingest: { claimed: number; completed: number; retried: number; failed: number };
    delivery: { claimed: number; completed: number; retried: number; failed: number };
  } | null;
  errors: string[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Cheap EXISTS-style probes so idle ticks avoid multi-statement outbox flushes
 * and empty claim loops. Fail-open: any probe error returns true (do the work).
 */
export async function probePendingWork(env: Env, now = new Date()): Promise<PendingWorkProbe> {
  const nowIso = now.toISOString();
  const staleEnqueuedBefore = new Date(now.getTime() - 15 * 60_000).toISOString();

  const exists = async (sql: string, args: unknown[] = []): Promise<boolean> => {
    try {
      const row = await env.DB.prepare(sql).bind(...args).first<{ ok: number }>();
      return row != null;
    } catch {
      return true;
    }
  };

  const [ingestQueue, deliveryQueue, ingestionOutbox, deliveryOutbox] = await Promise.all([
    exists(
      `SELECT 1 AS ok FROM deno_runtime_queue
        WHERE queue_name = 'ingest'
          AND (
            (status = 'pending' AND available_at <= ?)
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
          )
        LIMIT 1`,
      [nowIso, nowIso],
    ),
    exists(
      `SELECT 1 AS ok FROM deno_runtime_queue
        WHERE queue_name = 'delivery'
          AND (
            (status = 'pending' AND available_at <= ?)
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
          )
        LIMIT 1`,
      [nowIso, nowIso],
    ),
    exists(
      `SELECT 1 AS ok FROM (
         SELECT 1 AS ok FROM ingestion_outbox
          WHERE status IN ('pending', 'sending') AND available_at <= ?
         UNION ALL
         SELECT 1 AS ok FROM ingestion_outbox
          WHERE status = 'enqueued' AND updated_at <= ?
       ) LIMIT 1`,
      [nowIso, staleEnqueuedBefore],
    ),
    exists(
      `SELECT 1 AS ok FROM (
         SELECT 1 AS ok FROM delivery_outbox
          WHERE status IN ('pending', 'sending') AND available_at <= ?
         UNION ALL
         SELECT 1 AS ok FROM delivery_outbox
          WHERE status = 'enqueued' AND updated_at <= ?
       ) LIMIT 1`,
      [nowIso, staleEnqueuedBefore],
    ),
  ]);

  return { ingestQueue, deliveryQueue, ingestionOutbox, deliveryOutbox };
}

export function hasDrainableWork(probe: PendingWorkProbe): boolean {
  return probe.ingestQueue || probe.deliveryQueue
    || probe.ingestionOutbox || probe.deliveryOutbox;
}

export interface ScheduledTickOptions {
  /** Cancels the tick between lanes and stops the durable-queue drain. */
  signal?: AbortSignal;
  /** Singleton-lock TTL; bounds how long a crashed tick blocks successors. */
  lockTtlMs?: number;
}

interface TickSingletonLock {
  token: string;
  release(): Promise<void>;
}

const TICK_LOCK_NAMESPACE = 'locks';
const TICK_LOCK_KEY = 'scheduled-tick';
const TICK_LOCK_DEFAULT_TTL_MS = 2 * 60_000;

/**
 * DB-backed per-tick singleton over deno_runtime_kv so overlapping Deno.cron
 * invocations and POST /api/admin/runtime-tick calls (possibly in different
 * isolates) cannot run watcher/outbox/drain concurrently. The claim is one
 * atomic insert-or-replace-if-expired statement; release is token-guarded so a
 * slow tick never deletes its successor's lock.
 */
async function acquireTickSingleton(
  env: Env,
  now: Date,
  ttlMs: number,
): Promise<TickSingletonLock | null> {
  const token = crypto.randomUUID();
  const nowMs = now.getTime();
  const claimed = await env.DB.prepare(`
    INSERT INTO deno_runtime_kv (namespace, key, value, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE
      SET value = excluded.value, expires_at = excluded.expires_at
      WHERE deno_runtime_kv.expires_at IS NULL
         OR deno_runtime_kv.expires_at <= ?
  `).bind(TICK_LOCK_NAMESPACE, TICK_LOCK_KEY, token, nowMs + ttlMs, nowMs).run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return {
    token,
    release: async () => {
      await env.DB.prepare(`
        DELETE FROM deno_runtime_kv
        WHERE namespace = ? AND key = ? AND value = ?
      `).bind(TICK_LOCK_NAMESPACE, TICK_LOCK_KEY, token).run();
    },
  };
}

function tickAbortError(): Error {
  const error = new Error('scheduled tick aborted');
  error.name = 'AbortError';
  return error;
}

function isTickAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export type MaintenanceLane =
  | 'secrets_refresh'
  | 'watcher'
  | 'agreement_autopublish'
  | 'backlog_autopilot'
  | 'ingestion_outbox'
  | 'delivery_outbox'
  | 'durable_queue'
  | 'parked_deliveries'
  | 'usage_telemetry'
  | 'disclosure_latency'
  | 'daily_jobs'
  | 'd1_budget';

export interface MaintenancePipelineOptions {
  outboxLimit: number;
  /** When set, re-dispatch circuit-parked deliveries. */
  parkedDeliveryLimit?: number;
  /** When set, drain the usage-telemetry fallback outbox. */
  usageTelemetryLimit?: number;
  /** When true, run the disclosure-latency (missed-filing) probe. */
  disclosureLatency?: boolean;
  now?: Date;
  signal?: AbortSignal;
  /** Gate for the two outbox lanes (Deno idle short-circuit). Default: run. */
  beforeOutboxFlush?: () => Promise<boolean>;
  /** Runs right after the outbox lanes when they are not gated off (Deno drain). */
  afterOutboxFlush?: () => Promise<unknown>;
  /** Per-lane observability wrapper (Workers cron uses Sentry monitors). */
  observeLane?: (
    lane: MaintenanceLane,
    run: () => Promise<unknown>,
  ) => Promise<unknown>;
}

export interface MaintenancePipelineResult {
  skippedOutboxFlush: boolean;
  aborted: boolean;
  watcher: Awaited<ReturnType<typeof runWatcher>> | null;
  agreementAutopublish: Awaited<ReturnType<typeof maybeRunAgreementAutopublish>> | null;
  autopilot: Awaited<ReturnType<typeof maybeStartBacklogAutopilot>> | null;
  ingestionOutbox: { claimed: number; enqueued: number; failed: number } | null;
  deliveryOutbox: { claimed: number; enqueued: number; failed: number } | null;
  errors: string[];
}

/**
 * The single maintenance-lane orchestration shared by the Workers scheduled()
 * handler (index.ts) and the Deno scheduled tick. Lane order and per-lane
 * error isolation live here so the two cron paths cannot drift — they already
 * did once, when the Workers path silently dropped the agreement/autopilot
 * lanes after the Deno migration. Runtime-specific lanes are parameterized
 * (limits, opt-in lanes, hooks), not forked.
 */
export async function runMaintenancePipeline(
  env: Env,
  options: MaintenancePipelineOptions,
): Promise<MaintenancePipelineResult> {
  const now = options.now ?? new Date();
  const errors: string[] = [];
  const result: MaintenancePipelineResult = {
    skippedOutboxFlush: false,
    aborted: false,
    watcher: null,
    agreementAutopublish: null,
    autopilot: null,
    ingestionOutbox: null,
    deliveryOutbox: null,
    errors,
  };
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw tickAbortError();
  };
  const runLane = async <T>(
    lane: MaintenanceLane,
    run: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      throwIfAborted();
      const observed = options.observeLane ? options.observeLane(lane, run) : run();
      return (await observed) as T;
    } catch (err) {
      if (isTickAbort(err)) throw err;
      errors.push(`${lane}: ${errorText(err)}`);
      console.error(`maintenance lane ${lane} failed:`, err);
      return null;
    }
  };

  try {
    await runLane('secrets_refresh', () => refreshSecrets(env));
    result.watcher = await runLane('watcher', () => runWatcher(env, now));
    // Autonomy lanes run before the outbox gate so newly enqueued
    // agreement.check / autopilot.tick messages are visible to the gate probe.
    result.agreementAutopublish = await runLane(
      'agreement_autopublish',
      () => maybeRunAgreementAutopublish(env),
    );
    result.autopilot = await runLane(
      'backlog_autopilot',
      () => maybeStartBacklogAutopilot(env, now),
    );

    throwIfAborted();
    const flushOutboxes = options.beforeOutboxFlush
      ? await options.beforeOutboxFlush()
      : true;
    if (!flushOutboxes) result.skippedOutboxFlush = true;

    if (flushOutboxes) {
      result.ingestionOutbox = await runLane(
        'ingestion_outbox',
        () => flushIngestionOutbox(env, { limit: options.outboxLimit, now }),
      );
      result.deliveryOutbox = await runLane(
        'delivery_outbox',
        () => flushDeliveryOutbox(env, { limit: options.outboxLimit, now }),
      );
      if (options.afterOutboxFlush) {
        await runLane('durable_queue', options.afterOutboxFlush);
      }
    }
    if (options.parkedDeliveryLimit !== undefined) {
      const limit = options.parkedDeliveryLimit;
      await runLane('parked_deliveries', () => flushParkedDeliveries(env, { limit }));
    }
    if (options.usageTelemetryLimit !== undefined) {
      const limit = options.usageTelemetryLimit;
      await runLane(
        'usage_telemetry',
        () => flushUsageTelemetryFallback(env, { limit }),
      );
    }
    if (options.disclosureLatency) {
      await runLane('disclosure_latency', () => runDisclosureLatencyProbe(env));
    }
    await runLane('daily_jobs', () => maybeRunDailyJobs(env, now));
    await runLane('d1_budget', () => flushD1Budget(env, now));
  } catch (err) {
    if (!isTickAbort(err)) throw err;
    result.aborted = true;
    errors.push('tick: aborted');
  }
  return result;
}

export async function runScheduledTick(
  env: Env,
  handlers: DurableQueueHandlers,
  profile: DenoCostProfile,
  now = new Date(),
  options: ScheduledTickOptions = {},
): Promise<ScheduledTickResult> {
  const errors: string[] = [];
  const result: ScheduledTickResult = {
    profile: profile.name,
    skippedDrain: false,
    skippedOverlap: false,
    aborted: false,
    watcher: null,
    agreementAutopublish: null,
    autopilot: null,
    ingestionOutbox: null,
    deliveryOutbox: null,
    drained: null,
    errors,
  };

  // Singleton guard: a second tick (cron overlap or admin runtime-tick) exits
  // immediately instead of racing watcher/outbox writes. Fail-open when the
  // lock statement itself errors so a KV-table problem cannot park all
  // background work.
  let lock: TickSingletonLock | null = null;
  try {
    lock = await acquireTickSingleton(
      env,
      now,
      Math.max(1_000, options.lockTtlMs ?? TICK_LOCK_DEFAULT_TTL_MS),
    );
  } catch (err) {
    errors.push(`tick_singleton_unavailable: ${errorText(err)}`);
    console.error('Deno tick singleton lock unavailable; running unguarded:', err);
  }
  if (!lock && !errors.some((entry) => entry.startsWith('tick_singleton_unavailable'))) {
    result.skippedOverlap = true;
    return result;
  }

  const signal = options.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) throw tickAbortError();
  };

  try {
    const pipeline = await runMaintenancePipeline(env, {
      outboxLimit: profile.outboxLimit,
      // Re-dispatch deliveries parked behind per-target circuit breakers,
      // drain the usage-telemetry fallback outbox, and run the
      // missed-filing disclosure-latency probe. These lanes were previously
      // only enabled on the legacy Workers cron path; Deno Deploy is prod.
      parkedDeliveryLimit: 50,
      usageTelemetryLimit: 25,
      disclosureLatency: true,
      now,
      signal,
      // Idle short-circuit: skip multi-statement outbox flushes and the empty
      // claim loop when nothing is drainable. Runs after the autonomy lanes
      // so their enqueues are visible to the probe.
      beforeOutboxFlush: async () => {
        if (!profile.idleShortCircuit) return true;
        const probe = await probePendingWork(env, now);
        return hasDrainableWork(probe);
      },
      afterOutboxFlush: async () => {
        const drained = await drainDurableQueues(env, handlers, {
          limit: profile.drainLimit,
          claimSize: profile.drainClaimSize,
          signal,
        });
        result.drained = drained;
        if (drained.ingest.claimed > 0 || drained.delivery.claimed > 0) {
          console.log('Deno durable queues drained', drained);
        }
      },
    });
    errors.push(...pipeline.errors);
    result.watcher = pipeline.watcher;
    result.agreementAutopublish = pipeline.agreementAutopublish;
    result.autopilot = pipeline.autopilot;
    result.ingestionOutbox = pipeline.ingestionOutbox;
    result.deliveryOutbox = pipeline.deliveryOutbox;
    result.skippedDrain = pipeline.skippedOutboxFlush;
    result.aborted = pipeline.aborted;
    return result;
  } catch (err) {
    if (!isTickAbort(err)) throw err;
    result.aborted = true;
    errors.push('tick: aborted');
    return result;
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch (err) {
        errors.push(`tick_singleton_release: ${errorText(err)}`);
        console.error('Deno tick singleton lock release failed:', err);
      }
    }
  }
}
