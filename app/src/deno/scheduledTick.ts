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
  watcher: Awaited<ReturnType<typeof runWatcher>> | null;
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

export async function runScheduledTick(
  env: Env,
  handlers: DurableQueueHandlers,
  profile: DenoCostProfile,
  now = new Date(),
): Promise<ScheduledTickResult> {
  const errors: string[] = [];
  const result: ScheduledTickResult = {
    profile: profile.name,
    skippedDrain: false,
    watcher: null,
    ingestionOutbox: null,
    deliveryOutbox: null,
    drained: null,
    errors,
  };

  try {
    result.watcher = await runWatcher(env, now);
  } catch (err) {
    errors.push(`watcher: ${errorText(err)}`);
    console.error('Deno watcher tick failed:', err);
  }

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
      result.ingestionOutbox = await flushIngestionOutbox(env, {
        limit: profile.outboxLimit,
        now,
      });
    } catch (err) {
      errors.push(`ingestion_outbox: ${errorText(err)}`);
      console.error('Deno ingestion outbox flush failed:', err);
    }
    try {
      result.deliveryOutbox = await flushDeliveryOutbox(env, {
        limit: profile.outboxLimit,
        now,
      });
    } catch (err) {
      errors.push(`delivery_outbox: ${errorText(err)}`);
      console.error('Deno delivery outbox flush failed:', err);
    }
    try {
      result.drained = await drainDurableQueues(env, handlers, {
        limit: profile.drainLimit,
        claimSize: profile.drainClaimSize,
      });
      const drained = result.drained;
      if (drained.ingest.claimed > 0 || drained.delivery.claimed > 0) {
        console.log('Deno durable queues drained', drained);
      }
    } catch (err) {
      errors.push(`durable_queue: ${errorText(err)}`);
      console.error('Deno durable queue drain failed:', err);
    }
  }

  try {
    await maybeRunDailyJobs(env, now);
  } catch (err) {
    errors.push(`daily_jobs: ${errorText(err)}`);
    console.error('Deno daily jobs failed:', err);
  }

  try {
    await flushD1Budget(env, now);
  } catch (err) {
    errors.push(`d1_budget: ${errorText(err)}`);
  }

  return result;
}
