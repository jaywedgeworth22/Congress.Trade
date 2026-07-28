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
import { flushDeliveryOutbox } from '../delivery/outbox.ts';
import { flushIngestionOutbox } from '../ingestion/outbox.ts';
import { maybeRunAgreementAutopublish } from '../extraction/agreement.ts';
import { maybeStartBacklogAutopilot } from '../extraction/autopilot.ts';
import { refreshSecrets } from '../secrets/infisical.ts';
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
  // Refresh Infisical before gated lanes so flag flips (e.g. AGREEMENT_AUTOPUBLISH)
  // take effect without waiting for the cache TTL.
  try {
    throwIfAborted();
    await refreshSecrets(env);
  } catch (err) {
    if (isTickAbort(err)) throw err;
    errors.push(`secrets_refresh: ${errorText(err)}`);
    console.error('Deno secrets refresh failed:', err);
  }

  try {
    throwIfAborted();
    result.watcher = await runWatcher(env, now);
  } catch (err) {
    if (isTickAbort(err)) throw err;
    errors.push(`watcher: ${errorText(err)}`);
    console.error('Deno watcher tick failed:', err);
  }

  // Agreement / autopilot MUST run on Deno Deploy. The Workers scheduled handler
  // used to own these lanes; omitting them here silently parked the entire
  // review-queue autonomous publish path after the Deno migration.
  // Run BEFORE the idle short-circuit so newly enqueued agreement.check /
  // autopilot.tick messages are visible to the subsequent drain probe.
  try {
    throwIfAborted();
    result.agreementAutopublish = await maybeRunAgreementAutopublish(env);
  } catch (err) {
    if (isTickAbort(err)) throw err;
    errors.push(`agreement_autopublish: ${errorText(err)}`);
    console.error('Deno agreement autopublish tick failed:', err);
  }
  try {
    throwIfAborted();
    result.autopilot = await maybeStartBacklogAutopilot(env, now);
  } catch (err) {
    if (isTickAbort(err)) throw err;
    errors.push(`backlog_autopilot: ${errorText(err)}`);
    console.error('Deno backlog autopilot tick failed:', err);
  }

  throwIfAborted();
  let shouldDrain = true;
  if (profile.idleShortCircuit) {
    const probe = await probePendingWork(env, now);
    shouldDrain = hasDrainableWork(probe);
    if (!shouldDrain) {
      result.skippedDrain = true;
    }
  }

  if (shouldDrain) {
    try {
      throwIfAborted();
      result.ingestionOutbox = await flushIngestionOutbox(env, {
        limit: profile.outboxLimit,
        now,
      });
    } catch (err) {
      if (isTickAbort(err)) throw err;
      errors.push(`ingestion_outbox: ${errorText(err)}`);
      console.error('Deno ingestion outbox flush failed:', err);
    }
    try {
      throwIfAborted();
      result.deliveryOutbox = await flushDeliveryOutbox(env, {
        limit: profile.outboxLimit,
        now,
      });
    } catch (err) {
      if (isTickAbort(err)) throw err;
      errors.push(`delivery_outbox: ${errorText(err)}`);
      console.error('Deno delivery outbox flush failed:', err);
    }
    try {
      throwIfAborted();
      result.drained = await drainDurableQueues(env, handlers, {
        limit: profile.drainLimit,
        claimSize: profile.drainClaimSize,
        signal,
      });
      const drained = result.drained;
      if (drained.ingest.claimed > 0 || drained.delivery.claimed > 0) {
        console.log('Deno durable queues drained', drained);
      }
    } catch (err) {
      if (isTickAbort(err)) throw err;
      errors.push(`durable_queue: ${errorText(err)}`);
      console.error('Deno durable queue drain failed:', err);
    }
  }

  try {
    throwIfAborted();
    await maybeRunDailyJobs(env, now);
  } catch (err) {
    if (isTickAbort(err)) throw err;
    errors.push(`daily_jobs: ${errorText(err)}`);
    console.error('Deno daily jobs failed:', err);
  }

  try {
    await flushD1Budget(env, now);
  } catch (err) {
    errors.push(`d1_budget: ${errorText(err)}`);
  }

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
