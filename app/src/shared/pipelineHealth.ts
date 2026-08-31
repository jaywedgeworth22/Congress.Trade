/**
 * src/shared/pipelineHealth.ts
 * Deep health and data freshness inspection for congress.trade pipeline components.
 * Evaluates queue backlog age, provider failure rates, review queue accumulation,
 * autopilot halts, and transaction data freshness.
 */

import type { Env } from './types.ts';
import { all, get } from './db.ts';
import { getLastPollAt } from './config.ts';
import {
  countReviewQueueBuckets,
  formatReviewQueueHealthDetail,
  type ReviewQueueHealthCounts,
} from '../extraction/reviewQueueHealth.ts';
import { describeAutopilotHaltReason } from '../extraction/providerHealth.ts';
import { ogeWatchEnabled } from '../ingestion/ogeSource.ts';
import { readSenateRelayProbe } from '../ingestion/senateRelayHealth.ts';
import { expectedLatencyProviderIds } from '../ingestion/tradeLatency.ts';

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
  /** Disjoint unresolved review-queue buckets.  Absent when uncollected. */
  reviewQueue?: ReviewQueueHealthCounts | null;
}

export interface PipelineSignals {
  outboxPending: number | null;
  outboxOldestAt: string | null;
  outboxFailed: number | null;
  /** ALL unresolved review_queue rows (eligible + suppressed + terminal). */
  reviewBacklog: number | null;
  reviewEligible: number | null;
  reviewSuppressed: number | null;
  reviewTerminal: number | null;
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
  /**
   * Per-chamber polling liveness (owner directive 2026-08-10: polling can
   * never be silently off for any chamber). lastSuccessAt/lastAttemptAt come
   * from source_attempts (executive also max'd with the KV last_poll:oge
   * checkpoint so the check works for history recorded before executive
   * wrote source_attempts rows). configDisabled reflects the chamber's
   * enable gate (currently only executive has one: OGE_WATCH_ENABLED).
   */
  pollSources: Array<{
    source: 'house' | 'senate' | 'executive';
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    configDisabled: boolean;
  }> | null;
  /**
   * Latency-probe liveness (same directive): newest observation per provider
   * from trade_provider_observations. Empty array = probes have never
   * recorded anything (loud), null = uncollected.
   *
   * `expected` marks providers the current config intends to probe
   * (DISCLOSURE_LATENCY_PROVIDERS ∩ watch/FMP switches ∩ membership keys —
   * see expectedLatencyProviderIds). expected=false rows are retired: shown
   * in details, never paged. Absent = expected, so signal builders that
   * predate the flag keep the old always-page behavior. lastObservedAt null
   * = expected but never observed (just-enabled provider) — counts silent.
   */
  latencyProviders: Array<{ provider: string; lastObservedAt: string | null; expected?: boolean }> | null;
  /**
   * Named-tunnel Senate relay liveness (issue #1604).  configured reflects
   * SENATE_RELAY_URL; probe is the last GET /health written by the watcher
   * or GET /api/health/senate-relay.  Missing probe is unknown, not silent.
   */
  senateRelay: {
    configured: boolean;
    probe: {
      ok: boolean;
      status: number | null;
      checkedAt: string;
      host: string | null;
    } | null;
  } | null;
}

export interface PipelineThresholds {
  outboxAgeMinutes: number; // default 90
  /** Unused: any unresolved review item is unhealthy (Jay 2026-08-17). */
  reviewBacklogWarn: number;
  txAgeHours: number; // default 96 (weekend/recess slack)
  strandedFilingsWarn: number; // default 1 (any is worth a look; sweep clears them hourly)
  /** Max hours since last successful poll before a chamber is stalled. */
  pollSuccessMaxAgeHours: { house: number; senate: number; executive: number };
  /** Max hours since the newest provider latency observation, system-wide. */
  latencyObservationMaxAgeHours: number;
  /** Hours of silence before an individual recently-active provider is flagged. */
  latencyProviderSilenceHours: number;
  /** Max minutes since the last Senate-relay /health probe before the check goes stale. */
  senateRelayProbeMaxAgeMinutes: number;
}

export const DEFAULT_PIPELINE_THRESHOLDS: PipelineThresholds = {
  outboxAgeMinutes: 90,
  reviewBacklogWarn: 25,
  txAgeHours: 96,
  strandedFilingsWarn: 1,
  // House/Senate poll on the minutely watcher cadence, so 6h of no success was
  // already generous — ~240 consecutive failed cycles. The 2026-08-11 Senate
  // outage showed 6h is still too slow for a source that publishes daily: the
  // owner learned of it from a phone alert a day in. 3h is ~120 failed cycles,
  // still far past any transient blip, and halves the worst-case blind window.
  // Safe against quiet days: liveness records a *poll* success, not a filing —
  // a poll that returns zero rows still counts (see recordProbeOutcome, where
  // kind:'success' is independent of fetchedRows).
  // Executive follows the same adaptive probeSchedule as House/Senate
  // (weekday coverage floor 15 min; weekend hourly). last_poll advances on
  // empty success, so a working poller never looks stale. The 26h window is
  // slack for a disabled/broken executive path, not the poll interval.
  pollSuccessMaxAgeHours: { house: 3, senate: 3, executive: 26 },
  latencyObservationMaxAgeHours: 24,
  latencyProviderSilenceHours: 48,
  senateRelayProbeMaxAgeMinutes: 20,
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
    const halted = Boolean(s.autopilotHaltReason);
    const backlog = s.reviewBacklog ?? 0;
    if (halted || backlog > 0) {
      checks.push({
        id: 'extraction_provider',
        status: 'stalled',
        detail: halted
          ? `No extraction attempts in 24h while autopilot is halted (${s.autopilotHaltReason})`
          : `No extraction attempts in 24h while review backlog is ${backlog}`,
        value: 0,
      });
    } else {
      checks.push({ id: 'extraction_provider', status: 'ok', detail: 'No extraction attempts in 24h', value: 0 });
    }
  }

  // 4. Review queue backlog — ANY unresolved human-review item is unhealthy.
  if (s.reviewBacklog === null) {
    checks.push({ id: 'extraction_backlog', status: 'unknown', detail: 'Review backlog uncollected', value: null });
  } else if (s.reviewBacklog > 0) {
    const counts: ReviewQueueHealthCounts = {
      unresolved: s.reviewBacklog,
      eligible: s.reviewEligible ?? 0,
      suppressed: s.reviewSuppressed ?? 0,
      terminal: s.reviewTerminal ?? 0,
    };
    const eligible = s.reviewEligible ?? 0;
    checks.push({
      id: 'extraction_backlog',
      status: eligible > 0 ? 'stalled' : 'degraded',
      detail: formatReviewQueueHealthDetail(counts),
      value: s.reviewBacklog,
    });
  } else {
    checks.push({
      id: 'extraction_backlog',
      status: 'ok',
      detail: 'No unresolved human-review items',
      value: 0,
    });
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

  // 9-11. Per-chamber polling liveness (owner directive 2026-08-10: polling
  // must NEVER be silently off for any chamber). Born from two real silent
  // outages found the same night: OGE_WATCH_ENABLED sat unset for 5 days
  // (executive polling dead, nothing said so anywhere) and the senate poll
  // 403'd on every cron tick for days behind a console.warn nobody reads.
  // Three distinct loud states per chamber:
  //   - config-disabled  -> stalled ("disabled by config" — a deliberate
  //     gate is still an outage until someone turns it back on)
  //   - attempts fresh but successes stale -> stalled ("polling FAILING" —
  //     the senate-403 class: the watcher runs, the source never lands)
  //   - attempts stale/absent -> stalled ("polling NOT RUNNING" — cron dead,
  //     gate stuck, or the source was never wired to record attempts)
  if (s.pollSources === null) {
    checks.push({ id: 'polling_liveness', status: 'unknown', detail: 'Poll liveness uncollected', value: null });
  } else {
    for (const src of ['house', 'senate', 'executive'] as const) {
      const id = `polling_${src}`;
      const st = s.pollSources.find((p) => p.source === src);
      const maxAgeH = t.pollSuccessMaxAgeHours[src];
      if (!st) {
        checks.push({ id, status: 'stalled', detail: `${src} polling NOT RUNNING — no liveness record at all`, value: null });
        continue;
      }
      if (st.configDisabled) {
        checks.push({
          id,
          status: 'stalled',
          detail: `${src} polling DISABLED by config — must never be silent; re-enable or acknowledge loudly`,
          value: null,
        });
        continue;
      }
      const successMs = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : NaN;
      const attemptMs = st.lastAttemptAt ? Date.parse(st.lastAttemptAt) : NaN;
      const successAgeH = Number.isFinite(successMs) ? (nowMs - successMs) / 3_600_000 : Infinity;
      const attemptAgeH = Number.isFinite(attemptMs) ? (nowMs - attemptMs) / 3_600_000 : Infinity;
      if (successAgeH <= maxAgeH) {
        checks.push({
          id,
          status: 'ok',
          detail: `${src} polling live: last success ${successAgeH < 1 ? Math.round(successAgeH * 60) + 'm' : Math.round(successAgeH) + 'h'} ago`,
          value: Math.round(successAgeH * 10) / 10,
        });
      } else if (attemptAgeH <= maxAgeH) {
        checks.push({
          id,
          status: 'stalled',
          detail: `${src} polling FAILING: attempts are running (last ${Math.round(attemptAgeH)}h ago) but no success in `
            + `${successAgeH === Infinity ? 'ever' : Math.round(successAgeH) + 'h'} (threshold ${maxAgeH}h)`,
          value: successAgeH === Infinity ? null : Math.round(successAgeH),
        });
      } else {
        checks.push({
          id,
          status: 'stalled',
          detail: `${src} polling NOT RUNNING: no attempt in `
            + `${attemptAgeH === Infinity ? 'ever' : Math.round(attemptAgeH) + 'h'} (threshold ${maxAgeH}h)`,
          value: attemptAgeH === Infinity ? null : Math.round(attemptAgeH),
        });
      }
    }
  }

  // 12. Latency-monitoring liveness (same owner directive): the provider
  // latency probes (Quiver/UW/FMP observations that feed the latency
  // scorecard) must never go silently dark. Whole-system silence is stalled;
  // an expected provider gone quiet past the silence threshold is degraded
  // with the provider named. Providers retired in config (expected=false —
  // dropped subscription, DISCLOSURE_LATENCY_PROVIDERS filter, switch off)
  // are listed for context but never page: age alone kept paging retired
  // Quiver/UW for 17 days of UptimeRobot DOWN (2026-08).
  if (s.latencyProviders === null) {
    checks.push({ id: 'latency_probes', status: 'unknown', detail: 'Latency-probe liveness uncollected', value: null });
  } else {
    const expected = s.latencyProviders.filter((p) => p.expected !== false);
    const retired = s.latencyProviders.filter((p) => p.expected === false);
    const retiredNote = retired.length
      ? `; retired in config (not paged): ${retired.map((p) => p.provider).join(', ')}`
      : '';
    if (expected.length === 0) {
      checks.push({
        id: 'latency_probes',
        status: 'stalled',
        detail: s.latencyProviders.length === 0
          ? 'Latency monitoring NOT RUNNING — zero provider observations recorded, ever'
          : `Latency monitoring NOT RUNNING — no provider is enabled in config${retiredNote}`,
        value: null,
      });
    } else {
      let newestMs = -Infinity;
      const silent: string[] = [];
      for (const p of expected) {
        const ms = p.lastObservedAt === null ? NaN : Date.parse(p.lastObservedAt);
        if (!Number.isFinite(ms)) {
          silent.push(`${p.provider} (never observed)`);
          continue;
        }
        if (ms > newestMs) newestMs = ms;
        if ((nowMs - ms) / 3_600_000 > t.latencyProviderSilenceHours) {
          silent.push(`${p.provider} (${Math.round((nowMs - ms) / 3_600_000)}h)`);
        }
      }
      const newestAgeH = newestMs === -Infinity ? Infinity : (nowMs - newestMs) / 3_600_000;
      if (newestAgeH > t.latencyObservationMaxAgeHours) {
        checks.push({
          id: 'latency_probes',
          status: 'stalled',
          detail: `Latency monitoring SILENT: newest expected-provider observation is `
            + `${newestAgeH === Infinity ? 'missing' : Math.round(newestAgeH) + 'h'} old (threshold ${t.latencyObservationMaxAgeHours}h)${retiredNote}`,
          value: newestAgeH === Infinity ? null : Math.round(newestAgeH),
        });
      } else if (silent.length > 0) {
        checks.push({
          id: 'latency_probes',
          status: 'degraded',
          detail: `Latency provider(s) gone quiet: ${silent.join(', ')} (silence threshold ${t.latencyProviderSilenceHours}h)${retiredNote}`,
          value: silent.length,
        });
      } else {
        checks.push({
          id: 'latency_probes',
          status: 'ok',
          detail: `Latency probes live: newest observation ${newestAgeH < 1 ? Math.round(newestAgeH * 60) + 'm' : Math.round(newestAgeH) + 'h'} ago across ${expected.length} provider(s)${retiredNote}`,
          value: expected.length,
        });
      }
    }
  }

  // 13. Senate residential relay (issue #1604).  The named tunnel hostname
  // is permanent; the Mac origin is not.  A dead origin must be loud even
  // when polling_senate stays ok via the direct eFD fallback.
  if (s.senateRelay == null) {
    checks.push({ id: 'senate_relay', status: 'unknown', detail: 'Senate relay liveness uncollected', value: null });
  } else if (!s.senateRelay.configured) {
    checks.push({
      id: 'senate_relay',
      status: 'degraded',
      detail:
        'SENATE_RELAY_URL unset — Senate search/docs use the box egress.  Imperva has 403\'d that datacenter path before; keep a residential always-on host if it returns.',
      value: null,
    });
  } else if (!s.senateRelay.probe) {
    checks.push({
      id: 'senate_relay',
      status: 'unknown',
      detail: 'Senate relay configured but not yet probed',
      value: null,
    });
  } else {
    const probe = s.senateRelay.probe;
    const checkedMs = Date.parse(probe.checkedAt);
    const ageMin = Number.isFinite(checkedMs) ? (nowMs - checkedMs) / 60_000 : Infinity;
    const host = probe.host ?? 'senate-relay';
    if (!probe.ok) {
      checks.push({
        id: 'senate_relay',
        status: 'stalled',
        detail: `Senate relay DOWN at ${host}`
          + `${probe.status != null ? ` (HTTP ${probe.status})` : ''}`
          + ` — Mac origin / named tunnel is unreachable.  Search/docs fall back to direct eFD.`,
        value: probe.status,
      });
    } else if (ageMin > t.senateRelayProbeMaxAgeMinutes) {
      checks.push({
        id: 'senate_relay',
        status: 'degraded',
        detail: `Senate relay probe stale: last ok ${Math.round(ageMin)}m ago at ${host} (threshold ${t.senateRelayProbeMaxAgeMinutes}m)`,
        value: Math.round(ageMin),
      });
    } else {
      checks.push({
        id: 'senate_relay',
        status: 'ok',
        detail: `Senate relay live at ${host}: probed ${ageMin < 1 ? Math.round(ageMin * 60) + 's' : Math.round(ageMin) + 'm'} ago`,
        value: Math.round(ageMin * 10) / 10,
      });
    }
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
  let reviewEligible: number | null = null;
  let reviewSuppressed: number | null = null;
  let reviewTerminal: number | null = null;
  let reviewQueue: ReviewQueueHealthCounts | null = null;
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
    reviewQueue = await countReviewQueueBuckets(env);
    if (reviewQueue) {
      reviewBacklog = reviewQueue.unresolved;
      reviewEligible = reviewQueue.eligible;
      reviewSuppressed = reviewQueue.suppressed;
      reviewTerminal = reviewQueue.terminal;
    }
  } catch {}

  try {
    const res = await get<{ halt_reason: string; sample_errors: string | null }>(
      env.DB,
      "SELECT halt_reason, sample_errors FROM autopilot_runs WHERE status = 'halted' ORDER BY started_at DESC LIMIT 1",
    );
    autopilotHaltReason = describeAutopilotHaltReason(
      res?.halt_reason ?? null,
      res?.sample_errors ?? null,
    );
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

  // Poll liveness: last attempt/success per chamber from source_attempts.
  // Executive additionally max'es with the KV last_poll:oge checkpoint
  // (pollExecutive's own success marker, populated long before executive
  // started writing source_attempts rows) and reads its enable gate — a
  // disabled chamber must be LOUD, never a silent skip.
  let pollSources: PipelineSignals['pollSources'] = null;
  try {
    const rows = await all<{ source: string; last_success: string | null; last_attempt: string | null }>(
      env.DB,
      `SELECT source,
              MAX(CASE WHEN outcome = 'success' THEN attempted_at END) AS last_success,
              MAX(attempted_at) AS last_attempt
         FROM source_attempts
        WHERE source IN ('house', 'senate', 'executive')
        GROUP BY source`,
    );
    const bySource = new Map(rows.map((r) => [r.source, r]));
    let ogeDisabled = false;
    let ogeLastPollIso: string | null = null;
    try {
      ogeDisabled = !(await ogeWatchEnabled(env));
    } catch {}
    try {
      const d = await getLastPollAt(env, 'oge');
      ogeLastPollIso = d ? d.toISOString() : null;
    } catch {}
    pollSources = (['house', 'senate', 'executive'] as const).map((source) => {
      const row = bySource.get(source);
      let lastSuccessAt = row?.last_success ?? null;
      let lastAttemptAt = row?.last_attempt ?? null;
      if (source === 'executive' && ogeLastPollIso) {
        if (!lastSuccessAt || ogeLastPollIso > lastSuccessAt) lastSuccessAt = ogeLastPollIso;
        if (!lastAttemptAt || ogeLastPollIso > lastAttemptAt) lastAttemptAt = ogeLastPollIso;
      }
      return {
        source,
        lastSuccessAt,
        lastAttemptAt,
        configDisabled: source === 'executive' ? ogeDisabled : false,
      };
    });
  } catch {}

  let latencyProviders: PipelineSignals['latencyProviders'] = null;
  try {
    const rows = await all<{ provider: string; last_observed: string }>(
      env.DB,
      'SELECT provider, MAX(last_observed_at) AS last_observed FROM trade_provider_observations GROUP BY provider',
    );
    // Config-expected set; null when the resolver itself fails, which leaves
    // every observed row expected (fails open to the old always-page shape).
    let expectedIds: Set<string> | null = null;
    try {
      expectedIds = await expectedLatencyProviderIds(env);
    } catch {}
    const collected: NonNullable<PipelineSignals['latencyProviders']> = rows
      .filter((r) => r.provider && r.last_observed)
      .map((r) => ({
        provider: r.provider,
        lastObservedAt: r.last_observed,
        expected: expectedIds === null ? true : expectedIds.has(r.provider),
      }));
    if (expectedIds) {
      for (const id of expectedIds) {
        if (!collected.some((p) => p.provider === id)) {
          collected.push({ provider: id, lastObservedAt: null, expected: true });
        }
      }
    }
    latencyProviders = collected;
  } catch {}

  let senateRelay: PipelineSignals['senateRelay'] = {
    configured: Boolean(env.SENATE_RELAY_URL?.trim()),
    probe: null,
  };
  try {
    senateRelay = {
      configured: Boolean(env.SENATE_RELAY_URL?.trim()),
      probe: await readSenateRelayProbe(env),
    };
  } catch {
    senateRelay = null;
  }

  const signals: PipelineSignals = {
    outboxPending,
    outboxOldestAt,
    outboxFailed,
    reviewBacklog,
    reviewEligible,
    reviewSuppressed,
    reviewTerminal,
    extractionAttempts24h,
    extractionOk24h,
    lastExtractionSuccessAt,
    autopilotHaltReason,
    latestTxCreatedAt,
    dishonestResolutionCount,
    orphanedNeedsReviewCount,
    strandedFilings,
    pollSources,
    latencyProviders,
    senateRelay,
  };

  const evaluated = evaluatePipelineSignals(signals, nowMs);
  return { ...evaluated, reviewQueue };
}
