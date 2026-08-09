/**
 * src/shared/pipelineHealth.ts
 * Deep health and data freshness inspection for congress.trade pipeline components.
 * Evaluates queue backlog age, provider failure rates, review queue accumulation,
 * autopilot halts, and transaction data freshness.
 */

import type { Env } from './types.ts';
import { get } from './db.ts';
import { countEligibleBacklog } from '../extraction/autopilot.ts';

export type PipelineStatus = 'ok' | 'degraded' | 'stalled' | 'unknown';

export interface PipelineCheck {
  id: string;
  status: PipelineStatus;
  detail: string;
  value?: number | null;
}

export interface PipelineHealth {
  status: PipelineStatus;
  checks: PipelineCheck[];
}

export interface PipelineSignals {
  outboxPending: number | null;
  outboxOldestAt: string | null;
  outboxFailed: number | null;
  reviewBacklog: number | null;
  extractionAttempts24h: number | null;
  extractionOk24h: number | null;
  lastExtractionSuccessAt: string | null;
  autopilotHaltReason: string | null;
  latestTxCreatedAt: string | null;
  /**
   * review_queue rows with resolved=1 but no recorded resolution_kind (the
   * 2026-08-09 production bug: 738 filings resolved with zero live
   * transactions and no reason recorded anywhere on the row). See migration
   * 0082 and autopilot.ts resolveEmptyDoc.
   */
  dishonestResolutionCount: number | null;
  /**
   * filings.ingest_status='needs_review' with no open (resolved=0)
   * review_queue row — the queue/filing desync that made the review UI
   * report "all done" while filings sat unreviewed (180 filings in the same
   * production incident).
   */
  orphanedNeedsReviewCount: number | null;
  /**
   * Filings sitting in a non-terminal ingest_status well past every
   * stage-specific retry window (autonomySweeps.ts's stranded-sweep
   * threshold), i.e. rows the periodic sweep is *about* to terminalize on
   * its next run but hasn't yet. Never null when collected — a query error
   * fails open to 0 rather than surfacing as 'unknown', since an operator
   * would otherwise see a permanent 'unknown' between hourly sweeps.
   * Excludes provider-missing-% placeholder rows (working as designed) and
   * anything already review-resolved.
   */
  strandedFilings: number | null;
}

export interface PipelineThresholds {
  outboxAgeMinutes: number; // default 90
  reviewBacklogWarn: number; // default 25
  txAgeHours: number; // default 96 (weekend/recess slack)
  strandedFilingsWarn: number; // default 1 (any is worth a look; sweep clears them hourly)
}

export const DEFAULT_PIPELINE_THRESHOLDS: PipelineThresholds = {
  outboxAgeMinutes: 90,
  reviewBacklogWarn: 25,
  txAgeHours: 96,
  strandedFilingsWarn: 1,
};

const STATUS_WEIGHT: Record<PipelineStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  stalled: 3,
};

function worstStatus(a: PipelineStatus, b: PipelineStatus): PipelineStatus {
  return STATUS_WEIGHT[a] >= STATUS_WEIGHT[b] ? a : b;
}

/**
 * Pure, clock-injected evaluator for pipeline signals.
 */
export function evaluatePipelineSignals(
  s: PipelineSignals,
  nowMs: number,
  t = DEFAULT_PIPELINE_THRESHOLDS,
): PipelineHealth {
  const checks: PipelineCheck[] = [];
  let overall: PipelineStatus = 'ok';

  // 1. Ingestion backlog age
  if (s.outboxPending === null) {
    checks.push({ id: 'ingestion_backlog', status: 'unknown', detail: 'Outbox pending status uncollected', value: null });
  } else if (s.outboxPending > 0) {
    if (s.outboxOldestAt === null) {
      checks.push({ id: 'ingestion_backlog', status: 'unknown', detail: 'Outbox pending timestamp uncollected', value: s.outboxPending });
    } else {
      const oldestMs = Date.parse(s.outboxOldestAt);
      const ageMinutes = !isNaN(oldestMs) ? (nowMs - oldestMs) / (60 * 1000) : 0;
      if (ageMinutes > t.outboxAgeMinutes) {
        checks.push({
          id: 'ingestion_backlog',
          status: 'stalled',
          detail: `${s.outboxPending} outbox items pending, oldest ${Math.round(ageMinutes)}m old (limit ${t.outboxAgeMinutes}m)`,
          value: s.outboxPending,
        });
      } else {
        checks.push({
          id: 'ingestion_backlog',
          status: 'ok',
          detail: `${s.outboxPending} outbox items pending (${Math.round(ageMinutes)}m old)`,
          value: s.outboxPending,
        });
      }
    }
  } else {
    checks.push({ id: 'ingestion_backlog', status: 'ok', detail: 'Outbox backlog clear', value: 0 });
  }

  // 2. Ingestion dead letter
  if (s.outboxFailed === null) {
    checks.push({ id: 'ingestion_dead_letter', status: 'unknown', detail: 'Outbox failure count uncollected', value: null });
  } else if (s.outboxFailed > 0) {
    checks.push({
      id: 'ingestion_dead_letter',
      status: 'degraded',
      detail: `${s.outboxFailed} failed outbox item(s) in dead letter state`,
      value: s.outboxFailed,
    });
  } else {
    checks.push({ id: 'ingestion_dead_letter', status: 'ok', detail: 'No failed outbox items', value: 0 });
  }

  // 3. Extraction provider success rate
  if (s.extractionAttempts24h === null || s.extractionOk24h === null) {
    checks.push({ id: 'extraction_provider', status: 'unknown', detail: 'Extraction run telemetry uncollected', value: null });
  } else if (s.extractionAttempts24h > 0) {
    const okRate = s.extractionOk24h / s.extractionAttempts24h;
    if (s.extractionOk24h === 0) {
      checks.push({
        id: 'extraction_provider',
        status: 'stalled',
        detail: `0/${s.extractionAttempts24h} extraction attempts succeeded in last 24h`,
        value: s.extractionAttempts24h,
      });
    } else if (okRate < 0.5) {
      checks.push({
        id: 'extraction_provider',
        status: 'degraded',
        detail: `Low extraction success rate: ${s.extractionOk24h}/${s.extractionAttempts24h} (${Math.round(okRate * 100)}%) in 24h`,
        value: s.extractionAttempts24h,
      });
    } else {
      checks.push({
        id: 'extraction_provider',
        status: 'ok',
        detail: `Extraction success rate ${s.extractionOk24h}/${s.extractionAttempts24h} in 24h`,
        value: s.extractionAttempts24h,
      });
    }
  } else {
    checks.push({ id: 'extraction_provider', status: 'ok', detail: 'No extraction attempts in 24h', value: 0 });
  }

  // 4. Review queue backlog
  if (s.reviewBacklog === null) {
    checks.push({ id: 'extraction_backlog', status: 'unknown', detail: 'Review backlog uncollected', value: null });
  } else if (s.reviewBacklog > t.reviewBacklogWarn) {
    if (s.extractionAttempts24h === 0) {
      checks.push({
        id: 'extraction_backlog',
        status: 'stalled',
        detail: `Review backlog ${s.reviewBacklog} items unserved with zero 24h extraction attempts`,
        value: s.reviewBacklog,
      });
    } else {
      checks.push({
        id: 'extraction_backlog',
        status: 'degraded',
        detail: `Elevated review backlog: ${s.reviewBacklog} items (warn threshold ${t.reviewBacklogWarn})`,
        value: s.reviewBacklog,
      });
    }
  } else {
    checks.push({ id: 'extraction_backlog', status: 'ok', detail: `Review backlog normal (${s.reviewBacklog} items)`, value: s.reviewBacklog });
  }

  // 5. Autopilot halt
  if (s.autopilotHaltReason !== null) {
    checks.push({
      id: 'autopilot_halt',
      status: 'stalled',
      detail: `Autopilot runs halted: ${s.autopilotHaltReason}`,
      value: 1,
    });
  } else {
    checks.push({ id: 'autopilot_halt', status: 'ok', detail: 'Autopilot unhalted', value: 0 });
  }

  // 6. Data freshness
  if (s.latestTxCreatedAt === null) {
    checks.push({ id: 'data_freshness', status: 'unknown', detail: 'Latest transaction timestamp uncollected', value: null });
  } else {
    const latestMs = Date.parse(s.latestTxCreatedAt);
    const ageHours = !isNaN(latestMs) ? (nowMs - latestMs) / (3600 * 1000) : 0;
    if (ageHours > t.txAgeHours) {
      checks.push({
        id: 'data_freshness',
        status: 'degraded',
        detail: `Latest transaction is ${Math.round(ageHours)}h old (threshold ${t.txAgeHours}h)`,
        value: Math.round(ageHours),
      });
    } else {
      checks.push({
        id: 'data_freshness',
        status: 'ok',
        detail: `Data fresh: latest transaction ${Math.round(ageHours)}h ago`,
        value: Math.round(ageHours),
      });
    }
  }

  // 7. Review-queue resolution honesty (queue/filing consistency). Catches
  // both directions of the 2026-08-09 production bug: resolved=1 rows with
  // no recorded resolution reason (silently "done" with nothing to show for
  // it), and needs_review filings with no open queue row (the review UI
  // reporting "all done" while filings sat unreviewed). See migration 0082.
  if (s.dishonestResolutionCount === null || s.orphanedNeedsReviewCount === null) {
    checks.push({
      id: 'review_resolution_integrity',
      status: 'unknown',
      detail: 'Review-queue resolution integrity uncollected',
      value: null,
    });
  } else if (s.dishonestResolutionCount > 0 || s.orphanedNeedsReviewCount > 0) {
    checks.push({
      id: 'review_resolution_integrity',
      status: 'degraded',
      detail: `${s.dishonestResolutionCount} review item(s) resolved with no recorded resolution reason; `
        + `${s.orphanedNeedsReviewCount} filing(s) marked needs_review with no open review-queue row`,
      value: s.dishonestResolutionCount + s.orphanedNeedsReviewCount,
    });
  } else {
    checks.push({
      id: 'review_resolution_integrity',
      status: 'ok',
      detail: 'Review-queue resolutions and filing status are consistent',
      value: 0,
    });
  }

  // 8. Stranded filings (autonomy sweep backstop visibility). A count here
  // means the hourly autonomy-sweeps lane (cronLanes.ts) has, at most, one
  // more hour to run before terminalizing these rows itself — this check
  // exists so an operator (or an alert) sees the backlog immediately rather
  // than only after the sweep already fired, and so a sweep that is itself
  // failing (e.g. a bug, or the lane silently not registered) is caught
  // before rows go stale for days.
  if (s.strandedFilings === null) {
    checks.push({ id: 'stranded_filings', status: 'unknown', detail: 'Stranded-filing count uncollected', value: null });
  } else if (s.strandedFilings >= t.strandedFilingsWarn) {
    checks.push({
      id: 'stranded_filings',
      status: 'degraded',
      detail: `${s.strandedFilings} filing(s) stranded mid-pipeline past the autonomy sweep's retry window`,
      value: s.strandedFilings,
    });
  } else {
    checks.push({ id: 'stranded_filings', status: 'ok', detail: 'No stranded filings', value: 0 });
  }

  for (const c of checks) {
    overall = worstStatus(overall, c.status);
  }

  return { status: overall, checks };
}

/**
 * Collect signals from DB and evaluate health.
 */
export async function checkPipelineHealth(env: Env, now = new Date()): Promise<PipelineHealth> {
  const nowMs = now.getTime();
  const iso24hAgo = new Date(nowMs - 24 * 3600 * 1000).toISOString();

  let outboxPending: number | null = null;
  let outboxOldestAt: string | null = null;
  let outboxFailed: number | null = null;
  let reviewBacklog: number | null = null;
  let extractionAttempts24h: number | null = null;
  let extractionOk24h: number | null = null;
  let lastExtractionSuccessAt: string | null = null;
  let autopilotHaltReason: string | null = null;
  let latestTxCreatedAt: string | null = null;
  let dishonestResolutionCount: number | null = null;
  let orphanedNeedsReviewCount: number | null = null;
  let strandedFilings: number | null = null;

  try {
    const res = await get<{ n: number; oldest: string | null }>(
      env.DB,
      "SELECT COUNT(*) AS n, MIN(available_at) AS oldest FROM ingestion_outbox WHERE status IN ('pending', 'sending')",
    );
    if (res) {
      outboxPending = Number(res.n ?? 0);
      outboxOldestAt = res.oldest ?? null;
    }
  } catch {}

  try {
    const res = await get<{ n: number }>(
      env.DB,
      "SELECT COUNT(*) AS n FROM ingestion_outbox WHERE status = 'failed'",
    );
    if (res) outboxFailed = Number(res.n ?? 0);
  } catch {}

  try {
    const res = await get<{ attempts: number; ok_count: number; last_success: string | null }>(
      env.DB,
      'SELECT COUNT(*) AS attempts, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count, MAX(CASE WHEN ok = 1 THEN created_at END) AS last_success FROM extraction_runs WHERE created_at >= ?',
      [iso24hAgo],
    );
    if (res) {
      extractionAttempts24h = Number(res.attempts ?? 0);
      extractionOk24h = Number(res.ok_count ?? 0);
      lastExtractionSuccessAt = res.last_success ?? null;
    }
  } catch {}

  try {
    reviewBacklog = await countEligibleBacklog(env);
  } catch {}

  try {
    const res = await get<{ halt_reason: string }>(
      env.DB,
      "SELECT halt_reason FROM autopilot_runs WHERE status = 'halted' ORDER BY started_at DESC LIMIT 1",
    );
    autopilotHaltReason = res?.halt_reason ?? null;
  } catch {}

  try {
    const res = await get<{ created_at: string }>(
      env.DB,
      'SELECT created_at FROM transactions WHERE cursor_seq = (SELECT MAX(cursor_seq) FROM transactions)',
    );
    latestTxCreatedAt = res?.created_at ?? null;
  } catch {}

  try {
    const res = await get<{ n: number }>(
      env.DB,
      "SELECT COUNT(*) AS n FROM review_queue WHERE resolved = 1 AND resolution_kind IS NULL",
    );
    if (res) dishonestResolutionCount = Number(res.n ?? 0);
  } catch {}

  try {
    const res = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n
         FROM filings f
        WHERE f.ingest_status = 'needs_review'
          AND f.doc_id NOT LIKE 'provider-missing-%'
          AND NOT EXISTS (
            SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 0
          )`,
    );
    if (res) orphanedNeedsReviewCount = Number(res.n ?? 0);
  } catch {}

  try {
    // Mirrors autonomySweeps.ts's own eligibility windows (24h ceiling for
    // extraction_pending_local, 10d ceiling for any other mid-pipeline
    // status) — a non-zero count here means the hourly autonomy-sweeps lane
    // has work queued for its next pass. Excludes provider-missing-%
    // placeholders. Review-resolved rows are counted SEPARATELY below
    // (resolvedStatusDesync) rather than excluded outright: excluding them here
    // is what hid the 562-row production desync from this very check.
    const ceilingCutoff = new Date(nowMs - 24 * 3600_000).toISOString();
    const strandedCutoff = new Date(nowMs - 10 * 86_400_000).toISOString();
    const res = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM filings f
        WHERE f.doc_id NOT LIKE 'provider-missing-%'
          AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)
          AND (
            (f.ingest_status = 'extraction_pending_local' AND f.local_wait_expires_at IS NOT NULL AND f.local_wait_expires_at < ?)
            OR (f.ingest_status IN ('new', 'fetched', 'classified', 'extraction_pending_local') AND f.first_seen_at IS NOT NULL AND f.first_seen_at < ?)
          )`,
      [ceilingCutoff, strandedCutoff],
    );
    strandedFilings = Number(res?.n ?? 0);

    // The blind-spot counterpart: filings whose review is resolved but whose
    // ingest_status never got its terminal stamp. These are excluded from
    // every sweep's WHERE clause by design, so without this they are invisible
    // (production had 562 such rows while this check reported healthy).
    const desync = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n FROM filings f
        WHERE f.ingest_status IN ('new','fetched','classified','extraction_pending_local','needs_review')
          AND f.doc_id NOT LIKE 'provider-missing-%'
          AND EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)`,
    );
    strandedFilings += Number(desync?.n ?? 0);
  } catch {}

  const signals: PipelineSignals = {
    outboxPending,
    outboxOldestAt,
    outboxFailed,
    reviewBacklog,
    extractionAttempts24h,
    extractionOk24h,
    lastExtractionSuccessAt,
    autopilotHaltReason,
    latestTxCreatedAt,
    dishonestResolutionCount,
    orphanedNeedsReviewCount,
    strandedFilings,
  };

  return evaluatePipelineSignals(signals, nowMs);
}
