/**
 * Bounded requeue for transient dead letters.  Poison payloads stay failed.
 *
 * Live 2026-08-14: 309 ingestion_outbox rows are `consumer retry budget
 * exhausted; received by ingest-dlq` (retryable).  Durable-queue poison
 * includes `invalid ingest queue message type: filing.local_wait_check`.
 */

import type { Env } from '../shared/types.ts';
import { all, run, type SqlParam } from '../shared/db.ts';
import type { DurableQueueName } from '../deno/durableQueue.ts';

export const TRANSIENT_DLQ_DEFAULT_LIMIT = 100;
export const TRANSIENT_DLQ_MAX_LIMIT = 500;

export interface TransientDlqRequeueResult {
  ok: true;
  dryRun: boolean;
  scanned: number;
  matchedTransient: number;
  requeued: number;
  skippedPoison: number;
  skippedOther: number;
}

export function clampTransientDlqLimit(raw: number | undefined): number {
  const value = Number(raw ?? TRANSIENT_DLQ_DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return TRANSIENT_DLQ_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), TRANSIENT_DLQ_MAX_LIMIT);
}

/** Permanent payload / config defects — do not replay. */
export function isPoisonDlqError(message: string | null | undefined): boolean {
  const m = (message ?? '').trim().toLowerCase();
  if (!m) return false;
  return (
    /invalid ingest queue message type/.test(m)
    || /invalid durable queue message/.test(m)
    || /invalid payload/.test(m)
    || /unknown message type/.test(m)
    || /malformed/.test(m)
    || /not valid json/.test(m)
    || /please enable r2/.test(m)
    || /sql read operations are forbidden/.test(m)
  );
}

/** Recoverable transport / rate-limit / session / circuit failures. */
export function isTransientDlqError(message: string | null | undefined): boolean {
  if (isPoisonDlqError(message)) return false;
  const m = (message ?? '').trim().toLowerCase();
  if (!m) return false;
  return (
    /retry budget exhausted/.test(m)
    || /received by ingest-dlq/.test(m)
    || /\b429\b/.test(m)
    || /too many requests/.test(m)
    || /rate[- ]?limit/.test(m)
    || /\b403\b/.test(m)
    || /unauthorized/.test(m)
    || /timed out/.test(m)
    || /timeout/.test(m)
    || /circuit is open/.test(m)
    || /circuit open/.test(m)
    || /network connection lost/.test(m)
    || /retry later/.test(m)
    || /ingest is busy/.test(m)
    || /sqlite_busy/.test(m)
    || /d1.?error/.test(m)
    || /overloaded/.test(m)
  );
}

function classifyScanned(lastError: string | null | undefined): 'transient' | 'poison' | 'other' {
  if (isPoisonDlqError(lastError)) return 'poison';
  if (isTransientDlqError(lastError)) return 'transient';
  return 'other';
}

function emptyResult(dryRun: boolean): TransientDlqRequeueResult {
  return {
    ok: true,
    dryRun,
    scanned: 0,
    matchedTransient: 0,
    requeued: 0,
    skippedPoison: 0,
    skippedOther: 0,
  };
}

function tallyClasses(errors: Array<string | null | undefined>, limit: number): {
  transient: number;
  poison: number;
  other: number;
  scanned: number;
} {
  let transient = 0;
  let poison = 0;
  let other = 0;
  for (const error of errors) {
    const cls = classifyScanned(error);
    if (cls === 'transient') {
      if (transient < limit) transient += 1;
    } else if (cls === 'poison') poison += 1;
    else other += 1;
  }
  return { transient, poison, other, scanned: errors.length };
}

export async function requeueTransientFailedIngestionOutbox(
  env: Env,
  opts: { limit?: number; dryRun?: boolean; now?: Date } = {},
): Promise<TransientDlqRequeueResult> {
  const limit = clampTransientDlqLimit(opts.limit);
  const dryRun = opts.dryRun === true;
  const nowIso = (opts.now ?? new Date()).toISOString();
  const scanLimit = Math.min(limit * 4, TRANSIENT_DLQ_MAX_LIMIT * 4);
  const rows = await all<{ doc_id: string; last_error: string | null }>(
    env.DB,
    `SELECT doc_id, last_error FROM ingestion_outbox
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT ?`,
    [scanLimit],
  );
  const counts = tallyClasses(rows.map((row) => row.last_error), limit);
  const ids: string[] = [];
  for (const row of rows) {
    if (!isTransientDlqError(row.last_error)) continue;
    ids.push(row.doc_id);
    if (ids.length >= limit) break;
  }
  if (dryRun || ids.length === 0) {
    return {
      ...emptyResult(dryRun),
      scanned: counts.scanned,
      matchedTransient: ids.length,
      skippedPoison: counts.poison,
      skippedOther: counts.other,
    };
  }
  const placeholders = ids.map(() => '?').join(', ');
  const params: SqlParam[] = [nowIso, nowIso, ...ids];
  const updated = await run(
    env.DB,
    `UPDATE ingestion_outbox
        SET status = 'pending', attempts = 0, dead_letter_cycles = 0,
            available_at = ?, updated_at = ?
      WHERE status = 'failed' AND doc_id IN (${placeholders})`,
    params,
  );
  return {
    ok: true,
    dryRun: false,
    scanned: counts.scanned,
    matchedTransient: ids.length,
    requeued: updated.meta?.changes ?? 0,
    skippedPoison: counts.poison,
    skippedOther: counts.other,
  };
}

export async function requeueTransientFailedDurableJobs(
  env: Env,
  opts: { queue?: DurableQueueName; limit?: number; dryRun?: boolean; now?: Date } = {},
): Promise<TransientDlqRequeueResult & { queue: DurableQueueName }> {
  const queue = opts.queue ?? 'ingest';
  const limit = clampTransientDlqLimit(opts.limit);
  const dryRun = opts.dryRun === true;
  const nowIso = (opts.now ?? new Date()).toISOString();
  const scanLimit = Math.min(limit * 4, TRANSIENT_DLQ_MAX_LIMIT * 4);
  const rows = await all<{
    id: number;
    last_error: string | null;
    dedupe_key: string | null;
  }>(
    env.DB,
    `SELECT id, last_error, dedupe_key FROM deno_runtime_queue
      WHERE queue_name = ? AND status = 'failed'
      ORDER BY id DESC
      LIMIT ?`,
    [queue, scanLimit],
  );
  const counts = tallyClasses(rows.map((row) => row.last_error), Number.POSITIVE_INFINITY);
  const chosen: number[] = [];
  const seenDedupe = new Set<string>();
  for (const row of rows) {
    if (!isTransientDlqError(row.last_error)) continue;
    if (row.dedupe_key) {
      if (seenDedupe.has(row.dedupe_key)) continue;
      seenDedupe.add(row.dedupe_key);
    }
    chosen.push(Number(row.id));
    if (chosen.length >= limit) break;
  }
  if (dryRun || chosen.length === 0) {
    return {
      ...emptyResult(dryRun),
      queue,
      scanned: counts.scanned,
      matchedTransient: chosen.length,
      skippedPoison: counts.poison,
      skippedOther: counts.other,
    };
  }
  const placeholders = chosen.map(() => '?').join(', ');
  const updated = await run(
    env.DB,
    `UPDATE deno_runtime_queue
        SET status = 'pending', attempts = 0, last_error = NULL,
            lease_until = NULL, lease_token = NULL, dead_letter_pending = 0,
            dead_letter_cycles = 0, available_at = ?, updated_at = ?
      WHERE status = 'failed'
        AND id IN (${placeholders})
        AND (
          dedupe_key IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM deno_runtime_queue a
             WHERE a.queue_name = deno_runtime_queue.queue_name
               AND a.dedupe_key = deno_runtime_queue.dedupe_key
               AND a.status IN ('pending', 'processing')
          )
        )`,
    [nowIso, nowIso, ...chosen],
  );
  const requeued = updated.meta?.changes ?? 0;
  return {
    ok: true,
    dryRun: false,
    queue,
    scanned: counts.scanned,
    matchedTransient: chosen.length,
    requeued,
    skippedPoison: counts.poison,
    skippedOther: counts.other + Math.max(0, chosen.length - requeued),
  };
}
