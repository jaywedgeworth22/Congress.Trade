/**
 * src/extraction/autopilot.ts
 *
 * BACKLOG AUTOPILOT — the app-native replacement for the operator-driven
 * review-backlog drain. A cron gate (maybeStartBacklogAutopilot, invoked from
 * the per-minute scheduled handler) decides when a run is due — the first
 * tick of each UTC day, or sooner when the unresolved backlog exceeds
 * AUTOPILOT_BACKLOG_THRESHOLD — and starts a durable run row plus an
 * 'autopilot.tick' queue message. The queue consumer (handleAutopilotTick)
 * then drains docs a few at a time, re-enqueueing itself until the run ends,
 * because long model work must live in the queue (generous per-message
 * duration), never in the cron's cancellable waitUntil.
 *
 * Each selected doc runs through the EXACT same cascade/agreement machinery
 * as the per-minute cron (handleAgreementCheck): same leases, same attempt
 * caps, same daily LLM read budget, same unanimity/majority publish rules,
 * same hard-fail flags. The autopilot changes WHO initiates work — never
 * what publishes.
 *
 * OWNER POLICY (baked in, not optional):
 *  - Pilot-sized runs: AUTOPILOT_MAX_DOCS_PER_RUN (default 50) caps a run;
 *    first runs are pilots, never the whole backlog.
 *  - No retry burn: at most one attempt per model per doc per run — the
 *    cascade reads each configured model once per tier, a failed call is
 *    recorded and NEVER immediately retried or failed-over within the run.
 *  - Error-class kill-switch: when the same error class (billing / auth /
 *    quota / parse / timeout) occurs AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD
 *    times (default 2) in a run, the ENTIRE run halts immediately.
 *  - Halts require acknowledgment: a halted run persists a full receipt
 *    (per-class counts, bounded sample error text, per-doc outcomes, spend so
 *    far) surfaced via GET /api/admin/autopilot/status, and the cron will NOT
 *    start another run until POST /api/admin/autopilot/acknowledge. Errors
 *    are for seeing and understanding, not spending through.
 *
 * SPEND METER: every doc reserves a rate-card estimate against the shared
 * per-UTC-day autopilot_budget (AUTOPILOT_DAILY_USD_BUDGET, default $5.00,
 * integer micro-USD) BEFORE any model call, then settles to the priced actual
 * usage from extraction_runs afterwards. Reservation fails closed: a missing
 * budget table halts the run rather than spending unmetered.
 *
 * BATCH PRE-SEEDING (AUTOPILOT_BATCH_PRESEED, default off): when a chamber's
 * agreement trio includes direct batch-capable providers (openai / anthropic
 * / mistral / xai), eligible docs are submitted through the ~50%-cheaper
 * provider batch APIs first; completed batch reads land in extraction_runs,
 * where the cascade's read cache reuses them on a later run. All-OpenRouter
 * trios (the current production lineup) have no batch transport, so this is
 * a no-op there — hence "where supported".
 */

import type { Env } from '../shared/types.ts';
import { all, get, run } from '../shared/db.ts';
import { uuid } from '../shared/ids.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import {
  AGREEMENT_CLAIM_LEASE_MS,
  handleAgreementCheck,
  maxAttempts,
  resolveAgreementEnv,
  resolveModelsWithC,
  type AgreementDocResult,
  type AgreementModelsC,
} from './agreement.ts';
import { classifyProviderErrorClass, type ProviderErrorClass } from './providerHealth.ts';
import { estimateNominalReadCostUsd, priceBenchmarkUsage } from './benchmarkMetrics.ts';
import { meanConfidence, persistExtractionRun, type CandidateDocResult, type Provider } from './bakeoff.ts';
import { arbitrationRowKey } from '../extractors/types.ts';
import { pollBatch, submitBatch, type BatchChamber, type BatchDoc, type BatchProvider } from './batchExtract.ts';
import { ensureDocClass, DOC_CLASS_ORDER_SQL, type DocClass } from './docClassifier.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { allProvidersThrottled } from '../shared/monitorBudgetGate.ts';

const MICRO = 1_000_000;
/** Docs processed per queue-consumer invocation (each doc = 2-3 model reads). */
const DOCS_PER_TICK = 3;
/** A 'running' run whose consumer stopped updating for this long is stalled. */
const STALLED_RUN_MS = 30 * 60 * 1000;
/** Conservative planning cost for a model read the rate card cannot price. */
const UNPRICEABLE_READ_COST_USD = 0.05;
/** Outstanding pre-seed batch jobs polled per tick (bounded work). */
const PRESEED_POLL_LIMIT = 3;
const AUTOPILOT_BATCH_ID_PREFIX = 'autopilot-';
const PRESEED_SUBMISSION_UNKNOWN_AFTER_MS = 15 * 60 * 1000;

const KILL_SWITCH_CLASSES: readonly ProviderErrorClass[] = [
  'billing', 'auth', 'quota', 'parse', 'timeout',
];
const DIRECT_BATCH_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'mistral', 'xai'];

const KV_LAST_DAY = 'autopilot:lastday';
const KV_LAST_RUN_AT = 'autopilot:lastrun';

export interface AutopilotKnobs {
  enabled: boolean;
  backlogThreshold: number;
  dailyBudgetMicroUsd: number;
  maxDocsPerRun: number;
  errorClassHaltThreshold: number;
  minIntervalMinutes: number;
  preseedEnabled: boolean;
  /** Fraction of doc_class='empty' docs left in review for a human spot-check. */
  emptySpotcheckRate: number;
  /**
   * Default-off. When true, a tick with no normally-eligible doc (attempts <
   * cap) falls back to ONE doc that already exhausted its attempt cap under
   * `reason='agreement_cascade_unresolved'` (a genuine model disagreement,
   * never a hard-fail/corrupt/suppressed doc) and has never been legacy-
   * replayed. See selectLegacyReplayDoc for the exactly-once reset guard.
   */
  legacyReplayEnabled: boolean;
}

interface AutopilotSecretEnv {
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  AUTOPILOT_ENABLED?: string;
  AUTOPILOT_BACKLOG_THRESHOLD?: string;
  AUTOPILOT_DAILY_USD_BUDGET?: string;
  AUTOPILOT_MAX_DOCS_PER_RUN?: string;
  AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD?: string;
  AUTOPILOT_MIN_INTERVAL_MINUTES?: string;
  AUTOPILOT_BATCH_PRESEED?: string;
  DOC_CLASS_EMPTY_SPOTCHECK_RATE?: string;
  AUTOPILOT_LEGACY_REPLAY_ENABLED?: string;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Live-tunable knobs (Infisical-first, env fallback). The autopilot inherits
 * the cascade's master switch: it runs only where AGREEMENT_AUTOPUBLISH is
 * already on, and can be independently disabled with AUTOPILOT_ENABLED=false.
 */
export async function resolveAutopilotKnobs(env: Env): Promise<AutopilotKnobs> {
  let secrets: AutopilotSecretEnv = {};
  try {
    secrets = (await resolveSecrets(env, [
      'AGREEMENT_AUTOPUBLISH_ENABLED',
      'AUTOPILOT_ENABLED',
      'AUTOPILOT_BACKLOG_THRESHOLD',
      'AUTOPILOT_DAILY_USD_BUDGET',
      'AUTOPILOT_MAX_DOCS_PER_RUN',
      'AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD',
      'AUTOPILOT_MIN_INTERVAL_MINUTES',
      'AUTOPILOT_BATCH_PRESEED',
      'DOC_CLASS_EMPTY_SPOTCHECK_RATE',
      'AUTOPILOT_LEGACY_REPLAY_ENABLED',
    ])) as AutopilotSecretEnv;
  } catch {
    // Resolver outage: fail closed (disabled) rather than run unconfigured.
    return {
      enabled: false,
      backlogThreshold: 150,
      dailyBudgetMicroUsd: 5 * MICRO,
      maxDocsPerRun: 50,
      errorClassHaltThreshold: 2,
      minIntervalMinutes: 60,
      preseedEnabled: false,
      emptySpotcheckRate: 0.1,
      legacyReplayEnabled: false,
    };
  }
  return {
    enabled: secrets.AGREEMENT_AUTOPUBLISH_ENABLED === 'true'
      && secrets.AUTOPILOT_ENABLED !== 'false',
    backlogThreshold: Math.round(positiveNumber(secrets.AUTOPILOT_BACKLOG_THRESHOLD, 150)),
    dailyBudgetMicroUsd: Math.round(positiveNumber(secrets.AUTOPILOT_DAILY_USD_BUDGET, 5) * MICRO),
    maxDocsPerRun: Math.round(positiveNumber(secrets.AUTOPILOT_MAX_DOCS_PER_RUN, 50)),
    errorClassHaltThreshold: Math.round(
      positiveNumber(secrets.AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD, 2),
    ),
    minIntervalMinutes: positiveNumber(secrets.AUTOPILOT_MIN_INTERVAL_MINUTES, 60),
    preseedEnabled: secrets.AUTOPILOT_BATCH_PRESEED === 'true',
    emptySpotcheckRate: Math.min(positiveNumber(secrets.DOC_CLASS_EMPTY_SPOTCHECK_RATE, 0.1), 1),
    legacyReplayEnabled: secrets.AUTOPILOT_LEGACY_REPLAY_ENABLED === 'true',
  };
}

/**
 * "Current era first": congressional terms begin January of odd years, so the
 * current era starts Jan 1 of the most recent odd year. Era docs drain before
 * older filings; within an era, oldest review item first.
 */
export function currentEraStart(now = new Date()): string {
  const year = now.getUTCFullYear();
  return `${year - ((year - 1) % 2)}-01-01`;
}

function budgetDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Durable run state
// ---------------------------------------------------------------------------

export interface AutopilotOutcome {
  docId: string;
  outcome: string;
  reason?: string;
  spendUsd?: number;
  /** Receipt/attribution dimension from the pre-extraction classifier. */
  docClass?: DocClass | null;
}

interface AutopilotRunRow {
  id: string;
  status: string;
  /** 'trigger' is a SQLite reserved keyword; the column is run_trigger. */
  run_trigger: string;
  revision: number;
  backlog_before: number | null;
  docs_attempted: number;
  docs_published: number;
  docs_deferred: number;
  spend_microusd: number;
  budget_microusd: number;
  error_class_counts: string | null;
  sample_errors: string | null;
  outcomes: string | null;
  skip_reasons: string | null;
  halt_reason: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RunState {
  docsAttempted: number;
  docsPublished: number;
  docsDeferred: number;
  spendMicro: number;
  errorClassCounts: Partial<Record<ProviderErrorClass, number>>;
  sampleErrors: Partial<Record<ProviderErrorClass, string>>;
  outcomes: AutopilotOutcome[];
  skipReasons: Record<string, number>;
}

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseRunState(row: AutopilotRunRow): RunState {
  return {
    docsAttempted: row.docs_attempted ?? 0,
    docsPublished: row.docs_published ?? 0,
    docsDeferred: row.docs_deferred ?? 0,
    spendMicro: row.spend_microusd ?? 0,
    errorClassCounts: parseJsonOr(row.error_class_counts, {}),
    sampleErrors: parseJsonOr(row.sample_errors, {}),
    outcomes: parseJsonOr(row.outcomes, []),
    skipReasons: parseJsonOr(row.skip_reasons, {}),
  };
}

/**
 * CAS-persist the run state (revision fence) so a redelivered tick that lost
 * ownership can never clobber the live consumer's receipt. Returns the new
 * revision on success, null when ownership was lost.
 */
async function persistRunState(
  env: Env,
  runId: string,
  expectedRevision: number,
  state: RunState,
  final?: { status: 'completed' | 'halted'; haltReason: string | null },
): Promise<number | null> {
  const nowIso = new Date().toISOString();
  const result = await run(
    env.DB,
    `UPDATE autopilot_runs
        SET revision = revision + 1,
            docs_attempted = ?, docs_published = ?, docs_deferred = ?,
            spend_microusd = ?, error_class_counts = ?, sample_errors = ?,
            outcomes = ?, skip_reasons = ?, updated_at = ?,
            status = COALESCE(?, status),
            halt_reason = COALESCE(?, halt_reason),
            finished_at = COALESCE(?, finished_at)
      WHERE id = ? AND status = 'running' AND revision = ?`,
    [
      state.docsAttempted, state.docsPublished, state.docsDeferred,
      state.spendMicro, JSON.stringify(state.errorClassCounts),
      JSON.stringify(state.sampleErrors), JSON.stringify(state.outcomes),
      JSON.stringify(state.skipReasons), nowIso,
      final?.status ?? null,
      final?.haltReason ?? null,
      final ? nowIso : null,
      runId, expectedRevision,
    ],
  );
  return (result.meta?.changes ?? 0) > 0 ? expectedRevision + 1 : null;
}

/** Terminal halt without the revision fence (DLQ / stalled-run recovery). */
export async function markAutopilotRunHalted(
  env: Env,
  runId: string,
  reason: string,
): Promise<boolean> {
  try {
    const nowIso = new Date().toISOString();
    const result = await run(
      env.DB,
      `UPDATE autopilot_runs
          SET status = 'halted', halt_reason = ?, finished_at = ?, updated_at = ?,
              revision = revision + 1
        WHERE id = ? AND status = 'running'`,
      [reason, nowIso, nowIso, runId],
    );
    return (result.meta?.changes ?? 0) > 0;
  } catch (err) {
    console.warn('autopilot: halt mark failed:', runId, (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daily USD spend meter (integer micro-USD, guarded like reserveLlmBudget but
// failing CLOSED: unmetered spend is worse than a paused autopilot)
// ---------------------------------------------------------------------------

async function reserveAutopilotBudget(
  env: Env,
  day: string,
  amountMicro: number,
  capMicro: number,
): Promise<boolean> {
  await run(env.DB, 'INSERT OR IGNORE INTO autopilot_budget (day, spend_microusd) VALUES (?, 0)', [day]);
  const result = await run(
    env.DB,
    'UPDATE autopilot_budget SET spend_microusd = spend_microusd + ? WHERE day = ? AND spend_microusd + ? <= ?',
    [amountMicro, day, amountMicro, capMicro],
  );
  return (result.meta?.changes ?? 0) > 0;
}

async function settleAutopilotBudget(env: Env, day: string, deltaMicro: number): Promise<void> {
  if (deltaMicro === 0) return;
  try {
    await run(
      env.DB,
      'UPDATE autopilot_budget SET spend_microusd = MAX(spend_microusd + ?, 0) WHERE day = ?',
      [deltaMicro, day],
    );
  } catch (err) {
    console.warn('autopilot: budget settle failed:', (err as Error).message);
  }
}

async function todaysSpendMicro(env: Env, day: string): Promise<number> {
  try {
    const row = await get<{ spend_microusd: number }>(
      env.DB,
      'SELECT spend_microusd FROM autopilot_budget WHERE day = ?',
      [day],
    );
    return row?.spend_microusd ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Cost estimation + settlement
// ---------------------------------------------------------------------------

function estimateDocCostMicro(trio: AgreementModelsC | null, pageCount: number | null): number {
  if (!trio) return 0; // missing lineup config: the cascade flags it without model spend
  let totalUsd = 0;
  for (const model of [trio.a, trio.b, trio.c]) {
    totalUsd += estimateNominalReadCostUsd(model.provider, model.model, { pageCount })
      ?? UNPRICEABLE_READ_COST_USD;
  }
  return Math.ceil(totalUsd * MICRO);
}

interface DocReadRow {
  provider: string;
  model: string;
  ok: number;
  error: string | null;
  usage_json: string | null;
}

async function loadDocReads(env: Env, docId: string, sinceIso: string): Promise<DocReadRow[]> {
  try {
    return await all<DocReadRow>(
      env.DB,
      `SELECT provider, model, ok, error, usage_json FROM extraction_runs
        WHERE doc_id = ? AND kind = 'agreement' AND created_at >= ?`,
      [docId, sinceIso],
    );
  } catch {
    return [];
  }
}

/** Price the doc's observed reads: measured usage first, nominal fallback. */
function priceDocReadsMicro(reads: DocReadRow[], pageCount: number | null): number {
  let totalUsd = 0;
  for (const read of reads) {
    const usage = parseJsonOr<Record<string, number> | null>(read.usage_json, null);
    const priced = usage
      ? priceBenchmarkUsage({
          provider: read.provider,
          model: read.model,
          invoked: true,
          usage,
        }).costUsd
      : null;
    totalUsd += priced
      ?? estimateNominalReadCostUsd(read.provider, read.model, { pageCount })
      ?? UNPRICEABLE_READ_COST_USD;
  }
  return Math.ceil(totalUsd * MICRO);
}

// ---------------------------------------------------------------------------
// Doc selection (era-priority: current congressional era first, oldest first)
// ---------------------------------------------------------------------------

interface EligibleDoc {
  doc_id: string;
  raw_object_key: string | null;
  chamber: string | null;
  page_count: number | null;
  doc_class: string | null;
}

const ELIGIBLE_PREDICATES = `
       rq.resolved = 0
   AND rq.agreement_suppressed_at IS NULL
   AND COALESCE(rq.agreement_attempts, 0) < ?
   AND (rq.agreement_next_attempt_at IS NULL OR rq.agreement_next_attempt_at <= ?)
   AND (rq.agreement_claim_token IS NULL OR rq.agreement_claimed_at IS NULL OR rq.agreement_claimed_at <= ?)
   AND f.raw_object_key IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.doc_id = rq.doc_id AND t.source IN ('primary', 'manual')
        AND t.deprecated_at IS NULL
   )`;

/**
 * Predicates for a doc that already exhausted its normal attempt cap via a
 * genuine model disagreement (never a hard-fail/corrupt/quarantine reason,
 * never suppressed) and has not yet been given its one-time legacy-replay
 * reset. `reason = 'agreement_cascade_unresolved'` is the exact terminal
 * label leaveInReviewHighPriority writes on a cascade that ran out of
 * attempts without reaching unanimity/majority — the only reason this path
 * targets, so a doc flagged for a different, more deliberate cause (e.g. a
 * future hard-fail classification) is never swept in here.
 */
const LEGACY_REPLAY_PREDICATES = `
       rq.resolved = 0
   AND rq.agreement_suppressed_at IS NULL
   AND rq.agreement_legacy_replay_at IS NULL
   AND COALESCE(rq.agreement_attempts, 0) >= ?
   AND rq.reason = 'agreement_cascade_unresolved'
   AND (rq.agreement_claim_token IS NULL OR rq.agreement_claimed_at IS NULL OR rq.agreement_claimed_at <= ?)
   AND f.raw_object_key IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.doc_id = rq.doc_id AND t.source IN ('primary', 'manual')
        AND t.deprecated_at IS NULL
   )`;

/**
 * Atomically reset ONE exhausted, not-yet-replayed doc back to a fresh
 * attempt budget (attempts=0, tier cleared, any stale schedule/lease
 * cleared) and stamp `agreement_legacy_replay_at` in the SAME guarded
 * UPDATE, so a concurrent selector can never grant a second grace reset to
 * the same doc (the WHERE clause re-checks `agreement_legacy_replay_at IS
 * NULL`, matching the CAS pattern acquireAgreementLease/reserveLlmBudget
 * use elsewhere in this cascade). Returns the doc once the reset lands; the
 * caller then runs it through the EXACT same handleAgreementCheck cascade
 * (leases, attempt cap, daily LLM budget, publish rules) as any other doc —
 * this function only ever grants ONE extra full attempt budget, never
 * bypasses the cascade's own governance.
 */
async function selectLegacyReplayDoc(
  env: Env,
  attemptCap: number,
  excludeDocIds: string[],
  now: Date,
): Promise<EligibleDoc | null> {
  const nowIso = now.toISOString();
  const leaseExpired = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  const candidate = await get<EligibleDoc>(
    env.DB,
    `SELECT f.doc_id, f.raw_object_key, f.chamber, f.page_count, f.doc_class
       FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
      WHERE ${LEGACY_REPLAY_PREDICATES}
        AND rq.doc_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY rq.created_at ASC
      LIMIT 1`,
    [attemptCap, leaseExpired, JSON.stringify(excludeDocIds)],
  );
  if (!candidate) return null;
  const reset = await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_attempts = 0, agreement_tier = NULL, agreement_next_attempt_at = NULL,
            agreement_legacy_replay_at = ?, review_revision = review_revision + 1
      WHERE doc_id = ? AND resolved = 0 AND agreement_legacy_replay_at IS NULL`,
    [nowIso, candidate.doc_id],
  );
  // Lost the race (another selector reset it first, or it resolved meanwhile):
  // do not return a doc whose reset didn't actually land.
  return (reset.meta?.changes ?? 0) > 0 ? candidate : null;
}

async function selectNextDoc(
  env: Env,
  attemptCap: number,
  excludeDocIds: string[],
  eraStart: string,
  now: Date,
  legacyReplayEnabled = false,
): Promise<EligibleDoc | null> {
  const nowIso = now.toISOString();
  const leaseExpired = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  // Ordering: doc_class first (typed/clean/empty are the cheapest to resolve,
  // hard scans and quarantine candidates last), then current-era-first, then
  // oldest review item. Cheapest wins.
  const primary = await get<EligibleDoc>(
    env.DB,
    `SELECT f.doc_id, f.raw_object_key, f.chamber, f.page_count, f.doc_class
       FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
      WHERE ${ELIGIBLE_PREDICATES}
        AND rq.doc_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY ${DOC_CLASS_ORDER_SQL},
               CASE WHEN COALESCE(f.filed_date, '') >= ? THEN 0 ELSE 1 END,
               rq.created_at ASC
      LIMIT 1`,
    [attemptCap, nowIso, leaseExpired, JSON.stringify(excludeDocIds), eraStart],
  );
  if (primary) return primary;
  // Only reached once the normal (attempts < cap) pool is empty, and only
  // when the operator opted in — this never displaces a normally-eligible
  // doc, it only fills an otherwise-idle tick slot.
  if (!legacyReplayEnabled) return null;
  return selectLegacyReplayDoc(env, attemptCap, excludeDocIds, now);
}

/**
 * Unresolved-with-raw-bytes backlog size (trigger + status reporting).
 * Mirrors ELIGIBLE_PREDICATES' resolvability gate (suppressed/raw-bytes) but
 * deliberately does NOT filter on `agreement_attempts < cap`: a doc that
 * exhausted its cap is still real, unprocessed backlog (it will get a
 * legacy-replay grace shot when that's enabled, or stay a visible terminal
 * count when it's not) — undercounting it here is what previously made every
 * autopilot run report a stable `backlog_before` while `docs_attempted`
 * stayed 0 and every run "completed" as `backlog_drained`, silently masking
 * a permanently-stuck backlog instead of surfacing it honestly.
 */
export async function countEligibleBacklog(env: Env): Promise<number | null> {
  try {
    const row = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0
          AND rq.agreement_suppressed_at IS NULL
          AND f.raw_object_key IS NOT NULL`,
    );
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cron gate — decide whether a run is due, create it, enqueue the first tick
// ---------------------------------------------------------------------------

export interface AutopilotStartResult {
  started?: { runId: string; trigger: 'daily' | 'backlog' };
  blocked?: 'unacknowledged_halt' | 'run_in_progress' | 'stalled_run_halted' | 'not_due';
}

export async function maybeStartBacklogAutopilot(
  env: Env,
  now = new Date(),
): Promise<AutopilotStartResult | null> {
  const knobs = await resolveAutopilotKnobs(env);
  if (!knobs.enabled) return null;

  // Halt/ack + single-run gates. A halted run must be acknowledged by a human
  // (POST /api/admin/autopilot/acknowledge) before any new run may start.
  let open: Array<{ id: string; status: string; updated_at: string }>;
  try {
    open = await all<{ id: string; status: string; updated_at: string }>(
      env.DB,
      `SELECT id, status, updated_at FROM autopilot_runs
        WHERE status IN ('running', 'halted')
        ORDER BY started_at DESC LIMIT 10`,
    );
  } catch {
    return null; // autopilot_runs not migrated yet — do nothing, never throw
  }
  if (open.some((row) => row.status === 'halted')) {
    return { blocked: 'unacknowledged_halt' };
  }
  const runningRow = open.find((row) => row.status === 'running');
  if (runningRow) {
    const updatedAt = Date.parse(runningRow.updated_at);
    if (Number.isFinite(updatedAt) && now.getTime() - updatedAt >= STALLED_RUN_MS) {
      // Consumer died mid-run: surface it as a halt that requires human ack.
      await markAutopilotRunHalted(env, runningRow.id, 'stalled');
      return { blocked: 'stalled_run_halted' };
    }
    return { blocked: 'run_in_progress' };
  }

  // Trigger: first tick of a UTC day, or a big backlog (rate-limited by
  // AUTOPILOT_MIN_INTERVAL_MINUTES so the per-minute cron can't storm).
  const day = budgetDay(now);
  let trigger: 'daily' | 'backlog' | null = null;
  let backlog: number | null = null;
  try {
    const lastDay = await env.CONFIG_KV.get(KV_LAST_DAY);
    if (lastDay !== day) {
      trigger = 'daily';
    } else {
      backlog = await countEligibleBacklog(env);
      if (backlog != null && backlog > knobs.backlogThreshold) {
        const lastRunRaw = await env.CONFIG_KV.get(KV_LAST_RUN_AT);
        const lastRunAt = lastRunRaw ? Date.parse(lastRunRaw) : Number.NaN;
        if (!Number.isFinite(lastRunAt)
          || now.getTime() - lastRunAt >= knobs.minIntervalMinutes * 60 * 1000) {
          trigger = 'backlog';
        }
      }
    }
  } catch {
    return null; // no KV → skip rather than risk a run storm every minute
  }
  if (!trigger) return { blocked: 'not_due' };
  if (backlog == null) backlog = await countEligibleBacklog(env);

  // Stamp BEFORE starting so the next cron tick can't double-start.
  try {
    await env.CONFIG_KV.put(KV_LAST_DAY, day, { expirationTtl: 172800 });
    await env.CONFIG_KV.put(KV_LAST_RUN_AT, now.toISOString(), { expirationTtl: 7 * 86400 });
  } catch {
    return null;
  }

  const runId = uuid();
  const nowIso = now.toISOString();
  try {
    await run(
      env.DB,
      `INSERT INTO autopilot_runs
         (id, status, run_trigger, backlog_before, budget_microusd, started_at, updated_at)
       VALUES (?, 'running', ?, ?, ?, ?, ?)`,
      [runId, trigger, backlog, knobs.dailyBudgetMicroUsd, nowIso, nowIso],
    );
  } catch (err) {
    console.warn('autopilot: run insert failed:', (err as Error).message);
    return null;
  }
  try {
    await env.INGEST_QUEUE.send({ type: 'autopilot.tick', runId });
  } catch (err) {
    console.warn('autopilot: tick enqueue failed:', runId, (err as Error).message);
    await markAutopilotRunHalted(env, runId, 'tick_enqueue_failed');
    return { blocked: 'stalled_run_halted' };
  }
  console.log(`autopilot: run ${runId} started (trigger=${trigger}, backlog=${backlog ?? 'unknown'})`);
  return { started: { runId, trigger } };
}

// ---------------------------------------------------------------------------
// Queue consumer — process a slice of the run, then re-enqueue or finalize
// ---------------------------------------------------------------------------

export interface AutopilotTickDeps {
  /** Injectable for tests; defaults to the real cascade entry point. */
  check?: typeof handleAgreementCheck;
  /** Injectable for tests; defaults to R2-bytes + ensureDocClass. */
  classify?: (
    env: Env,
    docId: string,
    rawObjectKey: string,
    signal?: AbortSignal,
  ) => Promise<DocClass | null>;
  /** Injectable for tests; defaults to Math.random (empty spot-check sampling). */
  random?: () => number;
  /** Abort work immediately when the owning durable queue lease is lost. */
  signal?: AbortSignal;
}

/** Default classification path: load raw bytes and run the two-tier classifier. */
async function classifyFromR2(
  env: Env,
  docId: string,
  rawObjectKey: string,
  signal?: AbortSignal,
): Promise<DocClass | null> {
  try {
    signal?.throwIfAborted();
    const obj = await env.RAW_FILES.get(rawObjectKey);
    if (!obj) return null;
    const bytes = await obj.arrayBuffer();
    signal?.throwIfAborted();
    const result = signal
      ? await ensureDocClass(env, docId, bytes, undefined, { signal })
      : await ensureDocClass(env, docId, bytes);
    signal?.throwIfAborted();
    return result.docClass;
  } catch (err) {
    signal?.throwIfAborted();
    console.warn('autopilot: doc classification failed:', docId, (err as Error).message);
    return null;
  }
}

/** Quarantine a corrupt doc: suppress the cascade, keep it in human review. */
async function quarantineCorruptDoc(env: Env, docId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const result = await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_suppressed_at = ?, agreement_suppression_reason = 'doc_class_corrupt',
            review_revision = review_revision + 1
      WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL`,
    [nowIso, docId],
  );
  if ((result.meta?.changes ?? 0) === 0) return false;
  await recordIngestionDecision(env.DB, {
    docId,
    action: 'doc_quarantined',
    source: 'pipeline',
    reason: 'doc_class_corrupt',
    payload: { resolvedBy: 'backlog-autopilot', docClass: 'corrupt' },
  });
  return true;
}

/**
 * Auto-resolve an empty doc as no-transactions. Lease-respecting guarded
 * UPDATE — a claimed/suppressed/resolved row is never touched.
 */
async function resolveEmptyDoc(env: Env, docId: string, now: Date): Promise<boolean> {
  const leaseExpired = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  const result = await run(
    env.DB,
    `UPDATE review_queue
        SET resolved = 1, agreement_next_attempt_at = NULL,
            agreement_claim_token = NULL, agreement_claimed_at = NULL,
            review_revision = review_revision + 1
      WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
        AND (agreement_claim_token IS NULL OR agreement_claimed_at IS NULL OR agreement_claimed_at <= ?)`,
    [docId, leaseExpired],
  );
  if ((result.meta?.changes ?? 0) === 0) return false;
  await recordIngestionDecision(env.DB, {
    docId,
    action: 'auto_resolved_empty',
    source: 'pipeline',
    reason: 'doc_class_empty_no_transactions',
    payload: { resolvedBy: 'backlog-autopilot', docClass: 'empty' },
  });
  return true;
}

export async function handleAutopilotTick(
  env: Env,
  runId: string,
  deps: AutopilotTickDeps = {},
  now = new Date(),
): Promise<void> {
  deps.signal?.throwIfAborted();
  const check = deps.check ?? handleAgreementCheck;
  const classify = deps.classify ?? classifyFromR2;
  const random = deps.random ?? Math.random;
  const knobs = await resolveAutopilotKnobs(env);
  let row: AutopilotRunRow | null;
  try {
    row = await get<AutopilotRunRow>(env.DB, 'SELECT * FROM autopilot_runs WHERE id = ?', [runId]);
  } catch {
    deps.signal?.throwIfAborted();
    return;
  }
  if (!row || row.status !== 'running') return; // stale/duplicate tick
  let revision = row.revision;
  const state = parseRunState(row);
  const seenDocIds = state.outcomes.map((outcome) => outcome.docId);
  const day = budgetDay(now);
  const eraStart = currentEraStart(now);

  // Reconcile stale submission intents even when operators disable new
  // pre-seeding. Provider polling remains gated by the live feature flag.
  await pollAutopilotPreseedBatches(
    env,
    day,
    deps.signal,
    () => new Date(),
    knobs.preseedEnabled,
  ).catch((err) => {
    deps.signal?.throwIfAborted();
    console.warn('autopilot: preseed reconciliation failed:', (err as Error).message);
  });

  const agreementEnv = await resolveAgreementEnv(env);
  const attemptCap = maxAttempts(agreementEnv);
  const preseedQueue = new Map<string, Array<{ docId: string; rawObjectKey: string }>>();

  const noteError = (cls: ProviderErrorClass, text: string | null | undefined): void => {
    state.errorClassCounts[cls] = (state.errorClassCounts[cls] ?? 0) + 1;
    if (!state.sampleErrors[cls] && text) state.sampleErrors[cls] = text.slice(0, 240);
  };
  const finalize = async (
    status: 'completed' | 'halted',
    reason: string,
  ): Promise<void> => {
    const next = await persistRunState(env, runId, revision, state, { status, haltReason: reason });
    if (next != null) revision = next;
    console.log(`autopilot: run ${runId} ${status} (${reason}); `
      + `attempted=${state.docsAttempted} published=${state.docsPublished} `
      + `deferred=${state.docsDeferred} spend=$${(state.spendMicro / MICRO).toFixed(4)}`);
  };

  let finished = false;
  let haltedByErrors = false;

  for (let slot = 0; slot < DOCS_PER_TICK && !finished; slot++) {
    if (seenDocIds.length >= knobs.maxDocsPerRun) {
      await finalize('completed', 'max_docs_reached');
      finished = true;
      break;
    }

    let doc: EligibleDoc | null;
    try {
      doc = await selectNextDoc(env, attemptCap, seenDocIds, eraStart, new Date(), knobs.legacyReplayEnabled);
    } catch (err) {
      console.warn('autopilot: doc selection failed:', (err as Error).message);
      await finalize('halted', 'selector_failed');
      finished = true;
      break;
    }
    if (!doc) {
      await finalize('completed', 'backlog_drained');
      finished = true;
      break;
    }
    seenDocIds.push(doc.doc_id);
    const chamber = doc.chamber
      || (doc.doc_id.startsWith('E-') ? 'executive' : doc.doc_id.startsWith('S-') ? 'senate' : 'house');

    // Pre-extraction classification (persisted from selection or computed now;
    // deterministic-first, one ~free model call only for ambiguous scans).
    let docClass = doc.doc_class && (['typed', 'clean_scan', 'hard_scan', 'empty', 'corrupt'] as const)
      .includes(doc.doc_class as DocClass) ? doc.doc_class as DocClass : null;
    if (!docClass && doc.raw_object_key) {
      docClass = deps.signal
        ? await classify(env, doc.doc_id, doc.raw_object_key, deps.signal)
        : await classify(env, doc.doc_id, doc.raw_object_key);
      deps.signal?.throwIfAborted();
    }

    // corrupt → quarantine immediately: suppress the cascade so no model
    // spend ever lands on an unreadable document; humans keep the review item.
    if (docClass === 'corrupt') {
      const quarantined = await quarantineCorruptDoc(env, doc.doc_id).catch(() => {
        deps.signal?.throwIfAborted();
        return false;
      });
      state.docsDeferred += 1;
      state.outcomes.push({
        docId: doc.doc_id,
        outcome: quarantined ? 'quarantined' : 'deferred',
        reason: quarantined ? 'doc_class_corrupt' : 'quarantine_conflict',
        docClass,
      });
      state.skipReasons.doc_class_corrupt = (state.skipReasons.doc_class_corrupt ?? 0) + 1;
      const next = await persistRunState(env, runId, revision, state);
      if (next == null) return;
      revision = next;
      continue;
    }

    // empty → auto-resolve as no-transactions, keeping a sampled fraction in
    // review as a human spot-check on the classifier itself.
    if (docClass === 'empty') {
      if (random() < knobs.emptySpotcheckRate) {
        state.docsDeferred += 1;
        state.outcomes.push({
          docId: doc.doc_id, outcome: 'deferred', reason: 'empty_spot_check', docClass,
        });
        state.skipReasons.empty_spot_check = (state.skipReasons.empty_spot_check ?? 0) + 1;
      } else {
        const resolved = await resolveEmptyDoc(env, doc.doc_id, new Date()).catch(() => {
          deps.signal?.throwIfAborted();
          return false;
        });
        if (resolved) {
          state.docsAttempted += 1;
          state.outcomes.push({
            docId: doc.doc_id, outcome: 'resolved_empty', reason: 'no_transactions', docClass,
          });
        } else {
          state.docsDeferred += 1;
          state.outcomes.push({
            docId: doc.doc_id, outcome: 'deferred', reason: 'empty_resolve_conflict', docClass,
          });
          state.skipReasons.empty_resolve_conflict
            = (state.skipReasons.empty_resolve_conflict ?? 0) + 1;
        }
      }
      const next = await persistRunState(env, runId, revision, state);
      if (next == null) return;
      revision = next;
      continue;
    }

    const trio = resolveModelsWithC(agreementEnv, chamber);

    // Monitor-informed advisory backoff (early, non-blocking — composes
    // UNDER the hard per-run/per-day $ budget reserved below): when the API
    // Usage Monitor's cross-app budget-status reports EVERY provider this
    // doc's trio would call as already at/over its monthly budget, defer the
    // doc instead of spending on providers with no budget headroom anyway.
    // Fails open (never defers) when the monitor is disabled/unreachable —
    // see shared/monitorBudgetGate.ts.
    if (trio) {
      const throttle = await allProvidersThrottled(env, [trio.a.provider, trio.b.provider, trio.c.provider]);
      if (throttle.throttled) {
        state.docsDeferred += 1;
        state.outcomes.push({
          docId: doc.doc_id,
          outcome: 'deferred',
          reason: 'provider_budget_throttled',
          docClass,
        });
        state.skipReasons.provider_budget_throttled = (state.skipReasons.provider_budget_throttled ?? 0) + 1;
        console.log(`autopilot: deferring doc ${doc.doc_id} (${throttle.decision?.reason ?? 'provider budget throttled'})`);
        const next = await persistRunState(env, runId, revision, state);
        if (next == null) return; // lost ownership to a concurrent consumer
        revision = next;
        continue;
      }
    }

    // Batch pre-seeding: defer this doc onto the cheaper batch transport when
    // its trio has direct batch-capable models with no cached read yet.
    if (knobs.preseedEnabled && trio && doc.raw_object_key) {
      const missing = await missingDirectBatchReads(env, doc.doc_id, trio);
      if (missing.length) {
        for (const model of missing) {
          const key = `${model.provider}:${model.model}`;
          const queue = preseedQueue.get(key) ?? [];
          queue.push({ docId: doc.doc_id, rawObjectKey: doc.raw_object_key });
          preseedQueue.set(key, queue);
        }
        state.docsDeferred += 1;
        state.outcomes.push({ docId: doc.doc_id, outcome: 'deferred', reason: 'batch_preseed' });
        state.skipReasons.batch_preseed = (state.skipReasons.batch_preseed ?? 0) + 1;
        const next = await persistRunState(env, runId, revision, state);
        if (next == null) return; // lost ownership to a concurrent consumer
        revision = next;
        continue;
      }
    }

    // Reserve the rate-card estimate BEFORE any model call. Fails closed.
    const estimateMicro = estimateDocCostMicro(trio, doc.page_count);
    let reserved: boolean;
    try {
      reserved = await reserveAutopilotBudget(env, day, estimateMicro, knobs.dailyBudgetMicroUsd);
    } catch (err) {
      deps.signal?.throwIfAborted();
      console.warn('autopilot: budget reserve failed (failing closed):', (err as Error).message);
      await finalize('halted', 'budget_unavailable');
      finished = true;
      break;
    }
    if (!reserved) {
      await finalize('completed', 'budget_exhausted');
      finished = true;
      break;
    }

    // Run the SAME cascade machinery the per-minute cron uses — same leases,
    // attempt caps, LLM read budget, and publish safety. One attempt per
    // model per doc within this run; failures are recorded, never retried.
    const docStartIso = new Date().toISOString();
    let res: AgreementDocResult | null = null;
    let thrown: string | null = null;
    try {
      deps.signal?.throwIfAborted();
      res = deps.signal
        ? await check(
            env,
            doc.doc_id,
            doc.raw_object_key,
            undefined,
            undefined,
            deps.signal,
          )
        : await check(env, doc.doc_id, doc.raw_object_key);
      deps.signal?.throwIfAborted();
    } catch (err) {
      deps.signal?.throwIfAborted();
      thrown = (err as Error).message ?? String(err);
    }

    // Settle the reservation to priced actual usage, then classify failures.
    const reads = await loadDocReads(env, doc.doc_id, docStartIso);
    const actualMicro = priceDocReadsMicro(reads, doc.page_count);
    await settleAutopilotBudget(env, day, actualMicro - estimateMicro);
    state.spendMicro += actualMicro;
    for (const read of reads) {
      if (read.ok) continue;
      noteError(classifyProviderErrorClass(read.error) ?? 'other', read.error);
    }
    if (thrown) noteError(classifyProviderErrorClass(thrown) ?? 'other', thrown);

    state.docsAttempted += 1;
    const outcome = thrown ? 'error' : res?.outcome ?? 'skipped';
    if (outcome === 'published') state.docsPublished += 1;
    else state.docsDeferred += 1;
    const reason = thrown ? thrown.slice(0, 160) : res?.reason;
    state.outcomes.push({
      docId: doc.doc_id,
      outcome,
      ...(reason ? { reason } : {}),
      spendUsd: Math.round((actualMicro / MICRO) * 10_000) / 10_000,
      docClass,
    });
    if (outcome !== 'published') {
      const bucket = reason ?? outcome;
      state.skipReasons[bucket] = (state.skipReasons[bucket] ?? 0) + 1;
    }

    // Error-class kill-switch: same class twice (default) halts the WHOLE
    // run. The app stops, explains itself in the receipt, and waits for ack.
    const haltClass = KILL_SWITCH_CLASSES.find(
      (cls) => (state.errorClassCounts[cls] ?? 0) >= knobs.errorClassHaltThreshold,
    );
    if (haltClass) {
      await finalize('halted', `error_class:${haltClass}`);
      finished = true;
      haltedByErrors = true;
      break;
    }
    // The cascade's own daily LLM read budget is gone: nothing more can run
    // today, so end the run cleanly instead of burning selects.
    if (res?.reason === 'llm_budget_exhausted') {
      await finalize('completed', 'agreement_llm_budget_exhausted');
      finished = true;
      break;
    }

    const next = await persistRunState(env, runId, revision, state);
    if (next == null) return; // lost ownership to a concurrent consumer
    revision = next;
  }

  // Submit any collected pre-seed batches (skipped after an error halt: a
  // halted run must stop spending immediately).
  if (preseedQueue.size && !haltedByErrors) {
    await submitPreseedBatches(
      env,
      preseedQueue,
      state,
      runId,
      revision,
      deps.signal,
    )
      .then((next) => { if (next != null) revision = next; })
      .catch((err) => {
        deps.signal?.throwIfAborted();
        console.warn('autopilot: preseed submit failed:', (err as Error).message);
      });
  }

  if (!finished) {
    try {
      await env.INGEST_QUEUE.send({ type: 'autopilot.tick', runId });
    } catch (err) {
      deps.signal?.throwIfAborted();
      console.warn('autopilot: continuation enqueue failed:', runId, (err as Error).message);
      await markAutopilotRunHalted(env, runId, 'tick_enqueue_failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Batch pre-seeding (where supported: direct anthropic/openai/mistral/xai)
// ---------------------------------------------------------------------------

function isDirectBatchProvider(provider: string): provider is BatchProvider {
  return DIRECT_BATCH_PROVIDERS.includes(provider);
}

/** Trio models that could be batch pre-seeded and have no cached ok read yet. */
async function missingDirectBatchReads(
  env: Env,
  docId: string,
  trio: AgreementModelsC,
): Promise<Array<{ provider: BatchProvider; model: string }>> {
  const directModels = [trio.a, trio.b, trio.c]
    .filter((model) => isDirectBatchProvider(model.provider))
    .map((model) => ({ provider: model.provider as BatchProvider, model: model.model }));
  if (!directModels.length) return [];
  let cached: Array<{ provider: string; model: string }> = [];
  try {
    cached = await all<{ provider: string; model: string }>(
      env.DB,
      'SELECT DISTINCT provider, model FROM extraction_runs WHERE doc_id = ? AND ok = 1',
      [docId],
    );
  } catch {
    return []; // no extraction_runs table → no cache to seed; run live instead
  }
  const cachedLabels = new Set(cached.map((row) => `${row.provider}:${row.model}`));
  return directModels.filter((model) => !cachedLabels.has(`${model.provider}:${model.model}`));
}

export interface PreseedSubmitDeps {
  submit?: typeof submitBatch;
  now?: () => Date;
  id?: () => string;
}

export async function submitPreseedBatches(
  env: Env,
  queue: Map<string, Array<{ docId: string; rawObjectKey: string }>>,
  state: RunState,
  runId: string,
  revision: number,
  signal?: AbortSignal,
  deps: PreseedSubmitDeps = {},
): Promise<number | null> {
  const submit = deps.submit ?? submitBatch;
  const now = deps.now ?? (() => new Date());
  const id = deps.id ?? uuid;
  for (const [modelKey, docs] of queue) {
    const [provider, ...modelParts] = modelKey.split(':');
    const model = modelParts.join(':');
    if (!isDirectBatchProvider(provider)) continue;
    const batchDocs: BatchDoc[] = [];
    const seen = new Set<string>();
    for (const docRef of docs) {
      if (seen.has(docRef.docId)) continue;
      seen.add(docRef.docId);
      let obj: Awaited<ReturnType<Env['RAW_FILES']['get']>> | null;
      try {
        obj = await env.RAW_FILES.get(docRef.rawObjectKey);
      } catch {
        signal?.throwIfAborted();
        obj = null;
      }
      if (!obj) continue;
      const chamber: BatchChamber = docRef.docId.startsWith('E-')
        ? 'executive' : docRef.docId.startsWith('S-') ? 'senate' : 'house';
      batchDocs.push({ docId: docRef.docId, chamber, bytes: await obj.arrayBuffer() });
    }
    if (!batchDocs.length) continue;
    const jobId = `${AUTOPILOT_BATCH_ID_PREFIX}${id()}`;
    const submittedAt = now().toISOString();
    try {
      signal?.throwIfAborted();
      // Persist intent before the non-transactional provider call. If the
      // provider accepts work while this worker loses its queue lease, the
      // durable `submitting` row remains as an explicit unknown outcome for
      // reconciliation instead of silently orphaning unmetered work.
      await run(
        env.DB,
        `INSERT INTO batch_jobs
           (id, provider, model, provider_batch_id, doc_ids, status, submitted_at)
         VALUES (?, ?, ?, NULL, ?, 'submitting', ?)`,
        [
          jobId,
          provider,
          model,
          JSON.stringify(batchDocs.map((doc) => doc.docId)),
          submittedAt,
        ],
      );
      const providerBatchId = signal
        ? await submit(env, provider, model, batchDocs, signal)
        : await submit(env, provider, model, batchDocs);
      signal?.throwIfAborted();
      const finalized = await run(
        env.DB,
        `UPDATE batch_jobs
            SET provider_batch_id = ?, status = 'submitted'
          WHERE id = ? AND status = 'submitting'`,
        [providerBatchId, jobId],
      );
      if ((finalized.meta?.changes ?? 0) !== 1) {
        throw new Error('autopilot batch submission intent lost before finalization');
      }
      console.log(`autopilot: pre-seeded ${batchDocs.length} docs via ${modelKey} batch`);
    } catch (err) {
      signal?.throwIfAborted();
      await run(
        env.DB,
        `UPDATE batch_jobs
            SET status = 'submission_unknown', completed_at = ?, error = ?
          WHERE id = ? AND status = 'submitting'`,
        [
          now().toISOString(),
          `provider submission outcome unknown: ${(err as Error).message}`.slice(0, 500),
          jobId,
        ],
      ).catch(() => undefined);
      state.skipReasons.batch_preseed_submit_failed
        = (state.skipReasons.batch_preseed_submit_failed ?? 0) + 1;
      console.warn(`autopilot: batch pre-seed submit failed for ${modelKey}:`, (err as Error).message);
    }
  }
  return persistRunState(env, runId, revision, state);
}

/**
 * Poll outstanding autopilot-submitted batch jobs; persist finished readings
 * into extraction_runs (kind='batch') so the cascade's read cache reuses them,
 * and meter the priced batch spend into the day's autopilot budget.
 */
export async function pollAutopilotPreseedBatches(
  env: Env,
  day: string,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
  pollProviders = true,
): Promise<void> {
  let jobs: Array<{
    id: string;
    provider: string;
    model: string;
    provider_batch_id: string | null;
    status: string;
  }>;
  try {
    const submissionUnknownBefore = new Date(
      now().getTime() - PRESEED_SUBMISSION_UNKNOWN_AFTER_MS,
    ).toISOString();
    const eligibleStatuses = pollProviders
      ? "(status IN ('submitted', 'running') OR (status = 'submitting' AND submitted_at <= ?))"
      : "(status = 'submitting' AND submitted_at <= ?)";
    jobs = await all(
      env.DB,
      `SELECT id, provider, model, provider_batch_id, status FROM batch_jobs
        WHERE id LIKE '${AUTOPILOT_BATCH_ID_PREFIX}%'
          AND ${eligibleStatuses}
        ORDER BY submitted_at ASC LIMIT ?`,
      [submissionUnknownBefore, PRESEED_POLL_LIMIT],
    );
  } catch {
    signal?.throwIfAborted();
    return;
  }
  for (const job of jobs) {
    if (job.status === 'submitting' && !job.provider_batch_id) {
      signal?.throwIfAborted();
      await run(
        env.DB,
        `UPDATE batch_jobs
            SET status = 'submission_unknown', completed_at = ?,
                error = 'provider submission outcome unknown after queue lease loss'
          WHERE id = ? AND status = 'submitting'`,
        [now().toISOString(), job.id],
      );
      continue;
    }
    if (!job.provider_batch_id || !isDirectBatchProvider(job.provider)) continue;
    try {
      signal?.throwIfAborted();
      const poll = signal
        ? await pollBatch(env, job.provider, job.provider_batch_id, signal)
        : await pollBatch(env, job.provider, job.provider_batch_id);
      signal?.throwIfAborted();
      if (!poll.done) {
        await run(env.DB, "UPDATE batch_jobs SET status = 'running' WHERE id = ?", [job.id]);
        continue;
      }
      const nowIso = new Date().toISOString();
      if (poll.failed) {
        await run(
          env.DB,
          "UPDATE batch_jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?",
          [nowIso, JSON.stringify(poll.providerErrors ?? null), job.id],
        );
        continue;
      }
      let spentUsd = 0;
      for (const result of poll.results) {
        const candidateResult: CandidateDocResult = {
          provider: job.provider as Provider,
          model: job.model,
          docId: result.docId,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          latencyMs: 0,
          rowCount: result.rows?.length ?? 0,
          rowKeys: (result.rows ?? []).map(arbitrationRowKey),
          avgConfidence: meanConfidence(result.rows ?? []),
          rows: result.rows ?? [],
          ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
          ...(result.usage ? { usage: { ...result.usage, serviceTier: 'batch' } } : {}),
        };
        await persistExtractionRun(env, candidateResult, 'batch', job.id);
        if (result.usage) {
          spentUsd += priceBenchmarkUsage({
            provider: job.provider,
            model: job.model,
            invoked: true,
            usage: { ...result.usage, serviceTier: 'batch' },
          }).costUsd ?? 0;
        }
      }
      if (spentUsd > 0) {
        await run(env.DB, 'INSERT OR IGNORE INTO autopilot_budget (day, spend_microusd) VALUES (?, 0)', [day]);
        await settleAutopilotBudget(env, day, Math.ceil(spentUsd * MICRO));
      }
      await run(
        env.DB,
        `UPDATE batch_jobs SET status = 'completed', completed_at = ?, result_summary = ? WHERE id = ?`,
        [
          nowIso,
          JSON.stringify({
            source: 'autopilot-preseed',
            docs: poll.results.length,
            ok: poll.results.filter((result) => result.ok).length,
            spendUsd: Math.round(spentUsd * 10_000) / 10_000,
          }),
          job.id,
        ],
      );
      console.log(`autopilot: pre-seed batch ${job.id} completed (${poll.results.length} docs)`);
    } catch (err) {
      signal?.throwIfAborted();
      console.warn(`autopilot: pre-seed poll failed for ${job.id}:`, (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Admin surface — status + halt acknowledgment
// ---------------------------------------------------------------------------

export interface AutopilotRunReceipt {
  id: string;
  status: string;
  trigger: string;
  backlogBefore: number | null;
  docsAttempted: number;
  docsPublished: number;
  docsDeferred: number;
  spendUsd: number;
  budgetUsd: number;
  errorClassCounts: Partial<Record<ProviderErrorClass, number>>;
  sampleErrors: Partial<Record<ProviderErrorClass, string>>;
  outcomes: AutopilotOutcome[];
  skipReasons: Record<string, number>;
  haltReason: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function toReceipt(row: AutopilotRunRow): AutopilotRunReceipt {
  return {
    id: row.id,
    status: row.status,
    trigger: row.run_trigger,
    backlogBefore: row.backlog_before,
    docsAttempted: row.docs_attempted,
    docsPublished: row.docs_published,
    docsDeferred: row.docs_deferred,
    spendUsd: Math.round((row.spend_microusd / MICRO) * 10_000) / 10_000,
    budgetUsd: Math.round((row.budget_microusd / MICRO) * 10_000) / 10_000,
    errorClassCounts: parseJsonOr(row.error_class_counts, {}),
    sampleErrors: parseJsonOr(row.sample_errors, {}),
    outcomes: parseJsonOr(row.outcomes, []),
    skipReasons: parseJsonOr(row.skip_reasons, {}),
    haltReason: row.halt_reason,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function getAutopilotStatus(env: Env, now = new Date()): Promise<{
  enabled: boolean;
  knobs: Omit<AutopilotKnobs, 'enabled' | 'dailyBudgetMicroUsd'> & { dailyBudgetUsd: number };
  backlog: number | null;
  today: { day: string; spendUsd: number; budgetUsd: number };
  unacknowledgedHalt: AutopilotRunReceipt | null;
  runs: AutopilotRunReceipt[];
}> {
  const knobs = await resolveAutopilotKnobs(env);
  const day = budgetDay(now);
  const spendMicro = await todaysSpendMicro(env, day);
  let rows: AutopilotRunRow[] = [];
  try {
    rows = await all<AutopilotRunRow>(
      env.DB,
      'SELECT * FROM autopilot_runs ORDER BY started_at DESC LIMIT 10',
    );
  } catch {
    // Pre-migration: report empty run history.
  }
  const runs = rows.map(toReceipt);
  return {
    enabled: knobs.enabled,
    knobs: {
      backlogThreshold: knobs.backlogThreshold,
      dailyBudgetUsd: knobs.dailyBudgetMicroUsd / MICRO,
      maxDocsPerRun: knobs.maxDocsPerRun,
      errorClassHaltThreshold: knobs.errorClassHaltThreshold,
      minIntervalMinutes: knobs.minIntervalMinutes,
      preseedEnabled: knobs.preseedEnabled,
      emptySpotcheckRate: knobs.emptySpotcheckRate,
      legacyReplayEnabled: knobs.legacyReplayEnabled,
    },
    backlog: await countEligibleBacklog(env),
    today: {
      day,
      spendUsd: Math.round((spendMicro / MICRO) * 10_000) / 10_000,
      budgetUsd: knobs.dailyBudgetMicroUsd / MICRO,
    },
    unacknowledgedHalt: runs.find((receipt) => receipt.status === 'halted') ?? null,
    runs,
  };
}

/**
 * Acknowledge a halted run (unblocks the cron gate). With no runId, the most
 * recent halted run is acknowledged. Returns the acknowledged receipt, or
 * null when no halted run matched.
 */
export async function acknowledgeAutopilotHalt(
  env: Env,
  opts: { runId?: string; actor?: string } = {},
): Promise<AutopilotRunReceipt | null> {
  let target = opts.runId ?? null;
  if (!target) {
    try {
      const newest = await get<{ id: string }>(
        env.DB,
        "SELECT id FROM autopilot_runs WHERE status = 'halted' ORDER BY started_at DESC LIMIT 1",
      );
      target = newest?.id ?? null;
    } catch {
      return null;
    }
  }
  if (!target) return null;
  const nowIso = new Date().toISOString();
  const result = await run(
    env.DB,
    `UPDATE autopilot_runs
        SET status = 'halt_acknowledged', acknowledged_at = ?, acknowledged_by = ?,
            updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'halted'`,
    [nowIso, opts.actor ?? null, nowIso, target],
  );
  if ((result.meta?.changes ?? 0) === 0) return null;
  const row = await get<AutopilotRunRow>(env.DB, 'SELECT * FROM autopilot_runs WHERE id = ?', [target]);
  return row ? toReceipt(row) : null;
}
