import { all, batch, get, parseJson, run } from '../shared/db';
import { uuid } from '../shared/ids';
import {
  BENCHMARK_SCORING_PROFILE,
  scorePersistedBenchmarkResult,
} from './scoring';

export const BENCHMARK_CHAMBERS = ['house', 'senate', 'executive'] as const;
export type BenchmarkChamber = (typeof BENCHMARK_CHAMBERS)[number];
export type BenchmarkRunStatus = 'running' | 'completed' | 'failed';
export type BenchmarkCostSource = 'provider_reported' | 'usage_priced' | 'unknown';

export class BenchmarkRunStateConflictError extends Error {
  constructor(readonly status: BenchmarkRunStatus) {
    super(`benchmark run is ${status}`);
    this.name = 'BenchmarkRunStateConflictError';
  }
}

export class BenchmarkActiveRunConflictError extends Error {
  constructor(
    readonly chamber: BenchmarkChamber,
    readonly existingRunId: string,
  ) {
    super(`${chamber} already has a running benchmark`);
    this.name = 'BenchmarkActiveRunConflictError';
  }
}

export interface BenchmarkModelRef {
  provider: string;
  model: string;
}

export interface BenchmarkSelectedLineup {
  a: BenchmarkModelRef;
  b: BenchmarkModelRef;
  c: BenchmarkModelRef | null;
}

export interface BenchmarkDocumentInput {
  docId: string;
  resolved: boolean;
  groundTruth?: unknown;
}

export interface BeginBenchmarkRunInput {
  id?: string;
  chamber: BenchmarkChamber;
  models: BenchmarkModelRef[];
  documents: BenchmarkDocumentInput[];
  /** Non-secret extraction/request configuration needed to compare future runs. */
  requestProfile?: unknown;
  startedAt?: string;
}

export interface ReuseBenchmarkMeasurementsInput {
  runId: string;
  chamber: BenchmarkChamber;
  models: BenchmarkModelRef[];
  billableModels?: BenchmarkModelRef[];
  documents: BenchmarkDocumentInput[];
  reusedAt?: string;
}

export interface BenchmarkMeasurementInput {
  runId: string;
  docId: string;
  provider: string;
  model: string;
  /** Concrete provider model version when the requested model is an alias. */
  resolvedModel?: string | null;
  /** False when no external provider request was made (for example, no key). */
  invoked: boolean;
  ok: boolean;
  outcome?: string | null;
  autonomous: boolean;
  error?: string | null;
  rowCount: number;
  avgConfidence?: number | null;
  latencyMs?: number | null;
  /** Null when the invocation's monetary charge cannot be established. */
  costUsd?: number | null;
  costSource: BenchmarkCostSource;
  /** Pinned rates, rate-card version/source, billed units, and unpriced reason. */
  costDetail?: unknown;
  providerRequestId?: string | null;
  usage?: unknown;
  result?: unknown;
  perfectMatch?: boolean | null;
  truePositive?: number | null;
  falsePositive?: number | null;
  falseNegative?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  /** Server-issued lease token; prevents a stale worker from overwriting a retry. */
  claimToken?: string;
}

/** A deterministic circuit-breaker result that made no provider request. */
export interface BenchmarkUnavailableMeasurementInput extends BenchmarkModelRef {
  runId: string;
  docId: string;
  error: string;
  costDetail?: unknown;
  result?: unknown;
  createdAt?: string;
}

export interface BenchmarkMeasurementClaimInput extends BenchmarkModelRef {
  runId: string;
  docId: string;
  now?: string;
  leaseMs?: number;
  /** Explicitly authorize retrying a stale cell whose prior paid outcome is unknown. */
  allowRetryAfterUnknownOutcome?: boolean;
}

export interface BenchmarkMeasurementClaim {
  claimed: boolean;
  claimToken: string | null;
  leaseUntil: string | null;
  state: 'claimed' | 'running' | 'orphaned' | 'completed' | 'inactive';
  /** True when this claim replaced an expired attempt that may already have been billed. */
  reclaimedUnknownOutcome: boolean;
}

export interface ReleaseBenchmarkMeasurementClaimInput extends BenchmarkModelRef {
  runId: string;
  docId: string;
  claimToken: string;
  /** Keep an expired marker when this claim replaced a possibly billed attempt. */
  preserveUnknownOutcome: boolean;
  now?: string;
}

export interface BenchmarkModelSummary extends BenchmarkModelRef {
  docsMeasured: number;
  providerCalls: number;
  /** Saved cells that never reached the provider (for example, missing key). */
  unavailableDocs: number;
  docsOk: number;
  failures: number;
  autonomousDocs: number;
  autonomyRate: number | null;
  resolvedDocs: number;
  perfectMatches: number;
  perfectMatchRate: number | null;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  f1: number | null;
  avgConfidence: number | null;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** Provider error-response latency, kept separate from successful extraction speed. */
  avgFailureLatencyMs: number | null;
  p50FailureLatencyMs: number | null;
  p95FailureLatencyMs: number | null;
  knownCostUsd: number;
  coveredInvocations: number;
  costCoverageRate: number | null;
  actualCostPerDocumentUsd: number | null;
}

export interface BenchmarkRunSummary {
  documentCount: number;
  modelCount: number;
  invokedCalls: number;
  coveredInvocations: number;
  costCoverageRate: number | null;
  knownCostUsd: number;
  /** Present only when every invoked provider call has a known cost. */
  actualCostPerDocumentUsd: number | null;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  avgFailureLatencyMs: number | null;
  p50FailureLatencyMs: number | null;
  p95FailureLatencyMs: number | null;
  models: BenchmarkModelSummary[];
}

interface BenchmarkRunRow {
  id: string;
  chamber: BenchmarkChamber;
  status: BenchmarkRunStatus;
  requested_doc_count: number;
  completed_doc_count: number;
  model_count: number;
  models_json: string;
  request_profile_json: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  known_cost_usd: number | null;
  cost_covered_calls: number;
  invoked_calls: number;
  summary_json: string | null;
  selected_lineup_json: string | null;
  selected_at: string | null;
  selection_error: string | null;
  selection_audit_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface BenchmarkDocumentRow {
  run_id: string;
  doc_id: string;
  ordinal: number;
  resolved: number;
  ground_truth_json: string | null;
}

interface BenchmarkMeasurementRow {
  run_id: string;
  doc_id: string;
  provider: string;
  model: string;
  resolved_model: string | null;
  invoked: number;
  ok: number;
  outcome: string | null;
  autonomous: number;
  error: string | null;
  row_count: number;
  avg_confidence: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  cost_source: BenchmarkCostSource;
  cost_detail_json: string | null;
  provider_request_id: string | null;
  usage_json: string | null;
  result_json: string | null;
  perfect_match: number | null;
  true_positive: number | null;
  false_positive: number | null;
  false_negative: number | null;
  started_at: string | null;
  completed_at: string | null;
  claim_token: string | null;
  lease_until: string | null;
  created_at: string;
}

export interface BenchmarkRunRecord {
  id: string;
  chamber: BenchmarkChamber;
  status: BenchmarkRunStatus;
  requestedDocCount: number;
  completedDocCount: number;
  models: BenchmarkModelRef[];
  requestProfile: unknown;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  knownCostUsd: number | null;
  costCoveredCalls: number;
  invokedCalls: number;
  summary: BenchmarkRunSummary | null;
  selectedLineup: BenchmarkSelectedLineup | null;
  selectedAt: string | null;
  selectionError: string | null;
  selectionAudit: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkRunDetail extends BenchmarkRunRecord {
  documents: Array<{
    docId: string;
    ordinal: number;
    resolved: boolean;
    groundTruth: unknown;
  }>;
  results: Array<{
    runId: string;
    docId: string;
    provider: string;
    model: string;
    resolvedModel: string | null;
    invoked: boolean;
    ok: boolean;
    outcome: string | null;
    autonomous: boolean;
    error: string | null;
    rowCount: number;
    avgConfidence: number | null;
    latencyMs: number | null;
    costUsd: number | null;
    costSource: BenchmarkCostSource;
    costDetail: unknown;
    providerRequestId: string | null;
    usage: unknown;
    result: unknown;
    perfectMatch: boolean | null;
    truePositive: number | null;
    falsePositive: number | null;
    falseNegative: number | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}

function cleanPart(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${field} must not be empty`);
  return cleaned;
}

function finiteNonNegative(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number`);
  return value;
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function round(value: number, places = 12): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Nearest-rank percentile; deterministic for the small benchmark sample. */
function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1];
}

function mapRun(row: BenchmarkRunRow): BenchmarkRunRecord {
  return {
    id: row.id,
    chamber: row.chamber,
    status: row.status,
    requestedDocCount: row.requested_doc_count,
    completedDocCount: row.completed_doc_count,
    models: parseJson<BenchmarkModelRef[]>(row.models_json, []),
    requestProfile: parseJson<unknown>(row.request_profile_json, {}),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    knownCostUsd: row.known_cost_usd,
    costCoveredCalls: row.cost_covered_calls,
    invokedCalls: row.invoked_calls,
    summary: parseJson<BenchmarkRunSummary | null>(row.summary_json, null),
    selectedLineup: parseJson<BenchmarkSelectedLineup | null>(row.selected_lineup_json, null),
    selectedAt: row.selected_at,
    selectionError: row.selection_error,
    selectionAudit: parseJson<unknown>(row.selection_audit_json, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMeasurement(row: BenchmarkMeasurementRow): BenchmarkRunDetail['results'][number] {
  return {
    runId: row.run_id,
    docId: row.doc_id,
    provider: row.provider,
    model: row.model,
    resolvedModel: row.resolved_model,
    invoked: row.invoked === 1,
    ok: row.ok === 1,
    outcome: row.outcome,
    autonomous: row.autonomous === 1,
    error: row.error,
    rowCount: row.row_count,
    avgConfidence: row.avg_confidence,
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd,
    costSource: row.cost_source,
    costDetail: parseJson<unknown>(row.cost_detail_json, null),
    providerRequestId: row.provider_request_id,
    usage: parseJson<unknown>(row.usage_json, null),
    result: parseJson<unknown>(row.result_json, null),
    perfectMatch: row.perfect_match == null ? null : row.perfect_match === 1,
    truePositive: row.true_positive,
    falsePositive: row.false_positive,
    falseNegative: row.false_negative,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function beginBenchmarkRun(
  db: D1Database,
  input: BeginBenchmarkRunInput,
): Promise<BenchmarkRunRecord> {
  if (!BENCHMARK_CHAMBERS.includes(input.chamber)) throw new Error('invalid benchmark chamber');
  if (!input.models.length) throw new Error('benchmark requires at least one model');
  if (!input.documents.length) throw new Error('benchmark requires at least one document');

  const models = input.models.map((model) => ({
    provider: cleanPart(model.provider, 'provider'),
    model: cleanPart(model.model, 'model'),
  }));
  const modelKeys = new Set(models.map((model) => `${model.provider}:${model.model}`));
  if (modelKeys.size !== models.length) throw new Error('benchmark models must be unique');

  const docIds = input.documents.map((document) => cleanPart(document.docId, 'docId'));
  if (new Set(docIds).size !== docIds.length) throw new Error('benchmark documents must be unique');

  const id = input.id ? cleanPart(input.id, 'id') : uuid();
  const startedAt = input.startedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error('startedAt must be an ISO timestamp');

  const statements: Array<[string, Array<string | number | null>]> = [
    [
      `INSERT INTO benchmark_runs
         (id, chamber, status, requested_doc_count, completed_doc_count, model_count,
          models_json, request_profile_json, started_at, created_at, updated_at)
       VALUES (?, ?, 'running', ?, 0, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.chamber,
        input.documents.length,
        models.length,
        JSON.stringify(models),
        JSON.stringify(input.requestProfile ?? {}),
        startedAt,
        startedAt,
        startedAt,
      ],
    ],
  ];
  input.documents.forEach((document, ordinal) => {
    statements.push([
      `INSERT INTO benchmark_run_documents
         (run_id, doc_id, ordinal, resolved, ground_truth_json)
       VALUES (?, ?, ?, ?, ?)`,
      [id, docIds[ordinal], ordinal, document.resolved ? 1 : 0, jsonOrNull(document.groundTruth)],
    ]);
  });
  try {
    await batch(db, statements);
  } catch (error) {
    const active = await get<{ id: string }>(
      db,
      `SELECT id FROM benchmark_runs
        WHERE chamber = ? AND status = 'running'
        ORDER BY started_at DESC LIMIT 1`,
      [input.chamber],
    );
    if (active && active.id !== id) {
      throw new BenchmarkActiveRunConflictError(input.chamber, active.id);
    }
    throw error;
  }

  return {
    id,
    chamber: input.chamber,
    status: 'running',
    requestedDocCount: input.documents.length,
    completedDocCount: 0,
    models,
    requestProfile: input.requestProfile ?? {},
    startedAt,
    completedAt: null,
    durationMs: null,
    knownCostUsd: null,
    costCoveredCalls: 0,
    invokedCalls: 0,
    summary: null,
    selectedLineup: null,
    selectedAt: null,
    selectionError: null,
    selectionAudit: null,
    error: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

/**
 * Copy the newest prior successful reading for the same chamber/doc/model into
 * a new run. This is deliberately scoped to exact doc id plus provider:model so
 * an operator can rerun House/Senate/Executive without paying again for cells
 * already proven successful. Completion rescoring refreshes accuracy/F1 against
 * the new run's ground-truth snapshot.
 */
export async function reuseSuccessfulBenchmarkMeasurements(
  db: D1Database,
  input: ReuseBenchmarkMeasurementsInput,
): Promise<{ attempted: number; reused: number; reusedBillable: number }> {
  if (!BENCHMARK_CHAMBERS.includes(input.chamber)) throw new Error('invalid benchmark chamber');
  const runId = cleanPart(input.runId, 'runId');
  const reusedAt = input.reusedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(reusedAt))) throw new Error('reusedAt must be an ISO timestamp');
  const models = input.models.map((model) => ({
    provider: cleanPart(model.provider, 'provider'),
    model: cleanPart(model.model, 'model'),
  }));
  const billableKeys = new Set((input.billableModels ?? input.models).map((model) =>
    `${cleanPart(model.provider, 'provider')}:${cleanPart(model.model, 'model')}`,
  ));
  const docIds = input.documents.map((document) => cleanPart(document.docId, 'docId'));
  const statements: Array<{
    sql: string;
    params: Array<string | number | null>;
    billable: boolean;
  }> = [];
  for (const docId of docIds) {
    for (const model of models) {
      statements.push({
        sql: `INSERT INTO benchmark_model_results
           (run_id, doc_id, provider, model, resolved_model, invoked, ok, outcome,
            autonomous, error, row_count, avg_confidence, latency_ms, cost_usd,
            cost_source, cost_detail_json, provider_request_id, usage_json,
            result_json, perfect_match, true_positive, false_positive,
            false_negative, started_at, completed_at, created_at)
         SELECT ?, ?, provider, model, resolved_model, invoked, ok, outcome,
                autonomous, error, row_count, avg_confidence, latency_ms, cost_usd,
                cost_source, cost_detail_json, provider_request_id, usage_json,
                result_json, perfect_match, true_positive, false_positive,
                false_negative, started_at, completed_at, ?
           FROM (
             SELECT bmr.*
               FROM benchmark_model_results bmr
               JOIN benchmark_runs br ON br.id = bmr.run_id
              WHERE br.chamber = ?
                AND br.id <> ?
                AND bmr.doc_id = ?
                AND bmr.provider = ?
                AND bmr.model = ?
                AND bmr.outcome <> 'running'
                AND bmr.ok = 1
                AND bmr.claim_token IS NULL
              ORDER BY br.started_at DESC, bmr.completed_at DESC, bmr.created_at DESC
              LIMIT 1
           )
         ON CONFLICT (run_id, doc_id, provider, model) DO NOTHING`,
        params: [runId, docId, reusedAt, input.chamber, runId, docId, model.provider, model.model],
        billable: billableKeys.has(`${model.provider}:${model.model}`),
      });
    }
  }
  if (!statements.length) return { attempted: 0, reused: 0, reusedBillable: 0 };
  let reused = 0;
  let reusedBillable = 0;
  for (let offset = 0; offset < statements.length; offset += 50) {
    const chunk = statements.slice(offset, offset + 50);
    const results = await batch(db, chunk.map((entry) => [entry.sql, entry.params]));
    results.forEach((result, index) => {
      const changes = Number(result.meta?.changes ?? 0);
      reused += changes;
      if (chunk[index]?.billable) reusedBillable += changes;
    });
  }
  return { attempted: statements.length, reused, reusedBillable };
}

export async function getRunningBenchmarkRun(
  db: D1Database,
  chamber: BenchmarkChamber,
): Promise<BenchmarkRunDetail | null> {
  const active = await get<{ id: string }>(
    db,
    `SELECT id FROM benchmark_runs
      WHERE chamber = ? AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [chamber],
  );
  return active ? getBenchmarkRun(db, active.id) : null;
}

export async function updateBenchmarkRunRequestProfile(
  db: D1Database,
  runId: string,
  requestProfile: unknown,
  updatedAt = new Date().toISOString(),
): Promise<boolean> {
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('updatedAt must be an ISO timestamp');
  const result = await run(
    db,
    `UPDATE benchmark_runs
        SET request_profile_json = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [JSON.stringify(requestProfile ?? {}), updatedAt, cleanPart(runId, 'runId')],
  );
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Atomically claim one paid model/document cell. A completed cell is never
 * reclaimed. An expired running cell remains orphaned unless the caller has
 * explicitly confirmed a retry whose prior provider charge is unknowable.
 */
export async function claimBenchmarkMeasurement(
  db: D1Database,
  input: BenchmarkMeasurementClaimInput,
): Promise<BenchmarkMeasurementClaim> {
  const runId = cleanPart(input.runId, 'runId');
  const docId = cleanPart(input.docId, 'docId');
  const provider = cleanPart(input.provider, 'provider');
  const model = cleanPart(input.model, 'model');
  const now = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error('now must be an ISO timestamp');
  const leaseMs = input.leaseMs ?? 15 * 60_000;
  if (!Number.isFinite(leaseMs) || leaseMs < 30_000 || leaseMs > 60 * 60_000) {
    throw new Error('leaseMs must be between 30000 and 3600000');
  }
  const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
  const claimToken = uuid();

  const previous = await get<{
    outcome: string | null;
    claim_token: string | null;
    lease_until: string | null;
  }>(
    db,
    `SELECT outcome, claim_token, lease_until
       FROM benchmark_model_results
      WHERE run_id = ? AND doc_id = ? AND provider = ? AND model = ?`,
    [runId, docId, provider, model],
  );

  const claimWrite = await run(
    db,
    `INSERT INTO benchmark_model_results
       (run_id, doc_id, provider, model, invoked, ok, outcome, autonomous,
        row_count, cost_source, started_at, completed_at, claim_token,
        lease_until, created_at)
     SELECT ?, ?, ?, ?, 0, 0, 'running', 0, 0, 'unknown', ?, NULL, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM benchmark_runs WHERE id = ? AND status = 'running'
      )
     ON CONFLICT (run_id, doc_id, provider, model) DO UPDATE SET
       outcome = 'running', error = NULL, started_at = excluded.started_at,
       completed_at = NULL, claim_token = excluded.claim_token,
       lease_until = excluded.lease_until, created_at = excluded.created_at
     WHERE benchmark_model_results.outcome = 'running'
       AND ? = 1
       AND (benchmark_model_results.lease_until IS NULL
            OR benchmark_model_results.lease_until <= excluded.started_at)
       AND EXISTS (
         SELECT 1 FROM benchmark_runs
          WHERE id = excluded.run_id AND status = 'running'
       )`,
    [
      runId,
      docId,
      provider,
      model,
      now,
      claimToken,
      leaseUntil,
      now,
      runId,
      input.allowRetryAfterUnknownOutcome ? 1 : 0,
    ],
  );

  if (Number(claimWrite.meta?.changes ?? 0) === 0) {
    const parent = await get<{ status: BenchmarkRunStatus }>(
      db,
      'SELECT status FROM benchmark_runs WHERE id = ?',
      [runId],
    );
    if (!parent || parent.status !== 'running') {
      return {
        claimed: false,
        claimToken: null,
        leaseUntil: null,
        state: 'inactive',
        reclaimedUnknownOutcome: false,
      };
    }
  }

  const row = await get<{
    outcome: string | null;
    claim_token: string | null;
    lease_until: string | null;
  }>(
    db,
    `SELECT outcome, claim_token, lease_until
       FROM benchmark_model_results
      WHERE run_id = ? AND doc_id = ? AND provider = ? AND model = ?`,
    [runId, docId, provider, model],
  );
  if (!row) throw new Error('benchmark measurement claim was not persisted');
  const claimed = row.outcome === 'running' && row.claim_token === claimToken;
  const expired = row.outcome === 'running'
    && (row.lease_until === null || row.lease_until <= now);
  const reclaimedUnknownOutcome = claimed && previous?.outcome === 'running';
  return {
    claimed,
    claimToken: claimed ? claimToken : null,
    leaseUntil: row.lease_until,
    state: claimed
      ? 'claimed'
      : row.outcome === 'running'
        ? expired ? 'orphaned' : 'running'
        : 'completed',
    reclaimedUnknownOutcome,
  };
}

/**
 * Release an uninvoked claim when the paid-call reservation cannot be acquired.
 * Fresh cells are removed; reclaimed unknown-outcome cells remain immediately
 * orphaned so their possible prior provider charge is never forgotten.
 */
export async function releaseBenchmarkMeasurementClaim(
  db: D1Database,
  input: ReleaseBenchmarkMeasurementClaimInput,
): Promise<boolean> {
  const runId = cleanPart(input.runId, 'runId');
  const docId = cleanPart(input.docId, 'docId');
  const provider = cleanPart(input.provider, 'provider');
  const model = cleanPart(input.model, 'model');
  const claimToken = cleanPart(input.claimToken, 'claimToken');
  if (input.preserveUnknownOutcome) {
    const now = input.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(now))) throw new Error('now must be an ISO timestamp');
    const result = await run(
      db,
      `UPDATE benchmark_model_results
          SET claim_token = NULL, lease_until = ?
        WHERE run_id = ? AND doc_id = ? AND provider = ? AND model = ?
          AND outcome = 'running' AND invoked = 0 AND claim_token = ?`,
      [now, runId, docId, provider, model, claimToken],
    );
    return Number(result.meta?.changes ?? 0) === 1;
  }
  const result = await run(
    db,
    `DELETE FROM benchmark_model_results
      WHERE run_id = ? AND doc_id = ? AND provider = ? AND model = ?
        AND outcome = 'running' AND invoked = 0 AND claim_token = ?`,
    [runId, docId, provider, model, claimToken],
  );
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Atomically fill circuit-broken cells without overwriting a completed or
 * in-flight reading. This race fence matters when two browsers resume the same
 * run: a late blocker must never erase a request already owned by another
 * claim token.
 */
export async function saveUnavailableBenchmarkMeasurementsIfAbsent(
  db: D1Database,
  inputs: readonly BenchmarkUnavailableMeasurementInput[],
): Promise<{ attempted: number; inserted: number }> {
  if (!inputs.length) return { attempted: 0, inserted: 0 };
  const statements: Array<[string, Array<string | number | null>]> = inputs.map((input) => {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const error = cleanPart(input.error, 'error');
    return [
      `INSERT INTO benchmark_model_results
         (run_id, doc_id, provider, model, resolved_model, invoked, ok, outcome,
          autonomous, error, row_count, avg_confidence, latency_ms, cost_usd,
          cost_source, cost_detail_json, provider_request_id, usage_json, result_json,
          perfect_match, true_positive, false_positive, false_negative, started_at,
          completed_at, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 0, 'skipped', 0, ?, 0, NULL, NULL, NULL,
               'unknown', ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT (run_id, doc_id, provider, model) DO NOTHING`,
      [
        cleanPart(input.runId, 'runId'),
        cleanPart(input.docId, 'docId'),
        cleanPart(input.provider, 'provider'),
        cleanPart(input.model, 'model'),
        error,
        jsonOrNull(input.costDetail),
        jsonOrNull(input.result),
        createdAt,
        createdAt,
        createdAt,
      ],
    ];
  });
  const results = await batch(db, statements);
  return {
    attempted: inputs.length,
    inserted: results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0),
  };
}

/** Idempotently insert or replace one model/document measurement. */
export async function saveBenchmarkMeasurement(
  db: D1Database,
  input: BenchmarkMeasurementInput,
): Promise<void> {
  const now = input.createdAt ?? new Date().toISOString();
  const latencyMs = finiteNonNegative(input.latencyMs, 'latencyMs');
  const costUsd = finiteNonNegative(input.costUsd, 'costUsd');
  if (input.costSource === 'unknown' && costUsd != null) {
    throw new Error('unknown cost source requires costUsd=null');
  }
  if (!input.invoked && costUsd != null) {
    throw new Error('a non-invoked provider call requires costUsd=null');
  }
  if (input.costSource !== 'unknown' && input.invoked && costUsd == null) {
    throw new Error('known cost source requires costUsd');
  }

  const values: Array<string | number | null> = [
    cleanPart(input.runId, 'runId'),
    cleanPart(input.docId, 'docId'),
    cleanPart(input.provider, 'provider'),
    cleanPart(input.model, 'model'),
    input.resolvedModel?.trim() || null,
    input.invoked ? 1 : 0,
    input.ok ? 1 : 0,
    input.outcome ?? null,
    input.autonomous ? 1 : 0,
    input.error ?? null,
    Math.max(0, Math.floor(input.rowCount)),
    finiteNonNegative(input.avgConfidence, 'avgConfidence'),
    latencyMs == null ? null : Math.round(latencyMs),
    costUsd,
    input.costSource,
    jsonOrNull(input.costDetail),
    input.providerRequestId ?? null,
    jsonOrNull(input.usage),
    jsonOrNull(input.result),
    input.perfectMatch == null ? null : input.perfectMatch ? 1 : 0,
    finiteNonNegative(input.truePositive, 'truePositive'),
    finiteNonNegative(input.falsePositive, 'falsePositive'),
    finiteNonNegative(input.falseNegative, 'falseNegative'),
    input.startedAt ?? null,
    input.completedAt ?? null,
    now,
  ];

  if (input.claimToken) {
    const result = await run(
      db,
      `UPDATE benchmark_model_results SET
         resolved_model = ?, invoked = ?, ok = ?, outcome = ?, autonomous = ?,
         error = ?, row_count = ?, avg_confidence = ?, latency_ms = ?,
         cost_usd = ?, cost_source = ?, cost_detail_json = ?,
         provider_request_id = ?, usage_json = ?, result_json = ?,
         perfect_match = ?, true_positive = ?, false_positive = ?,
         false_negative = ?, started_at = ?, completed_at = ?, created_at = ?,
         claim_token = NULL, lease_until = NULL
       WHERE run_id = ? AND doc_id = ? AND provider = ? AND model = ?
         AND claim_token = ? AND outcome = 'running'`,
      [
        ...values.slice(4),
        values[0],
        values[1],
        values[2],
        values[3],
        cleanPart(input.claimToken, 'claimToken'),
      ],
    );
    if (!result.meta?.changes) throw new Error('benchmark measurement claim was lost');
    return;
  }

  await run(
    db,
    `INSERT INTO benchmark_model_results
       (run_id, doc_id, provider, model, resolved_model, invoked, ok, outcome,
        autonomous, error, row_count, avg_confidence, latency_ms, cost_usd,
        cost_source, cost_detail_json, provider_request_id, usage_json, result_json,
        perfect_match, true_positive, false_positive, false_negative, started_at,
        completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, doc_id, provider, model) DO UPDATE SET
       resolved_model = excluded.resolved_model,
       invoked = excluded.invoked,
       ok = excluded.ok,
       outcome = excluded.outcome,
       autonomous = excluded.autonomous,
       error = excluded.error,
       row_count = excluded.row_count,
       avg_confidence = excluded.avg_confidence,
       latency_ms = excluded.latency_ms,
       cost_usd = excluded.cost_usd,
       cost_source = excluded.cost_source,
       cost_detail_json = excluded.cost_detail_json,
       provider_request_id = excluded.provider_request_id,
       usage_json = excluded.usage_json,
       result_json = excluded.result_json,
       perfect_match = excluded.perfect_match,
       true_positive = excluded.true_positive,
       false_positive = excluded.false_positive,
       false_negative = excluded.false_negative,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       created_at = excluded.created_at,
       claim_token = NULL,
       lease_until = NULL`,
    values,
  );
}

export function summarizeBenchmarkMeasurements(
  models: BenchmarkModelRef[],
  documentCount: number,
  results: BenchmarkRunDetail['results'],
): BenchmarkRunSummary {
  const invoked = results.filter((result) => result.invoked);
  const covered = invoked.filter((result) => result.costUsd != null);
  const knownCostUsd = round(covered.reduce((sum, result) => sum + (result.costUsd ?? 0), 0));
  const latencies = invoked
    .filter((result) => result.ok)
    .map((result) => result.latencyMs)
    .filter((value): value is number => value != null);
  const failureLatencies = invoked
    .filter((result) => !result.ok)
    .map((result) => result.latencyMs)
    .filter((value): value is number => value != null);

  const summaries = models.map((ref): BenchmarkModelSummary => {
    const measured = results.filter(
      (result) => result.provider === ref.provider && result.model === ref.model,
    );
    const modelInvoked = measured.filter((result) => result.invoked);
    const modelOk = modelInvoked.filter((result) => result.ok);
    const modelCovered = modelInvoked.filter((result) => result.costUsd != null);
    const resolved = measured.filter((result) => result.perfectMatch != null);
    const modelLatencies = modelInvoked
      .filter((result) => result.ok)
      .map((result) => result.latencyMs)
      .filter((value): value is number => value != null);
    const modelFailureLatencies = modelInvoked
      .filter((result) => !result.ok)
      .map((result) => result.latencyMs)
      .filter((value): value is number => value != null);
    const confidences = modelOk
      .map((result) => result.avgConfidence)
      .filter((value): value is number => value != null);
    const tp = resolved.reduce((sum, result) => sum + (result.truePositive ?? 0), 0);
    const fp = resolved.reduce((sum, result) => sum + (result.falsePositive ?? 0), 0);
    const fn = resolved.reduce((sum, result) => sum + (result.falseNegative ?? 0), 0);
    const f1Denominator = 2 * tp + fp + fn;
    const modelKnownCost = round(modelCovered.reduce((sum, result) => sum + (result.costUsd ?? 0), 0));
    const fullCostCoverage = modelInvoked.length > 0 && modelCovered.length === modelInvoked.length;

    return {
      ...ref,
      docsMeasured: measured.length,
      providerCalls: modelInvoked.length,
      unavailableDocs: measured.filter((result) => !result.invoked).length,
      docsOk: modelOk.length,
      failures: modelInvoked.filter((result) => !result.ok).length,
      autonomousDocs: modelOk.filter((result) => result.autonomous).length,
      autonomyRate: modelOk.length
        ? modelOk.filter((result) => result.autonomous).length / modelOk.length
        : null,
      resolvedDocs: resolved.length,
      perfectMatches: resolved.filter((result) => result.perfectMatch).length,
      perfectMatchRate: resolved.length
        ? resolved.filter((result) => result.perfectMatch).length / resolved.length
        : null,
      truePositive: tp,
      falsePositive: fp,
      falseNegative: fn,
      f1: !resolved.length
        ? null
        : f1Denominator > 0
          ? (2 * tp) / f1Denominator
          : resolved.every((result) => result.perfectMatch) ? 1 : 0,
      avgConfidence: mean(confidences),
      avgLatencyMs: mean(modelLatencies),
      p50LatencyMs: percentile(modelLatencies, 0.5),
      p95LatencyMs: percentile(modelLatencies, 0.95),
      avgFailureLatencyMs: mean(modelFailureLatencies),
      p50FailureLatencyMs: percentile(modelFailureLatencies, 0.5),
      p95FailureLatencyMs: percentile(modelFailureLatencies, 0.95),
      knownCostUsd: modelKnownCost,
      coveredInvocations: modelCovered.length,
      costCoverageRate: modelInvoked.length ? modelCovered.length / modelInvoked.length : null,
      actualCostPerDocumentUsd: fullCostCoverage && measured.length
        ? round(modelKnownCost / measured.length)
        : null,
    };
  });

  const fullCostCoverage = invoked.length > 0 && covered.length === invoked.length;
  return {
    documentCount,
    modelCount: models.length,
    invokedCalls: invoked.length,
    coveredInvocations: covered.length,
    costCoverageRate: invoked.length ? covered.length / invoked.length : null,
    knownCostUsd,
    actualCostPerDocumentUsd: fullCostCoverage && documentCount > 0
      ? round(knownCostUsd / documentCount)
      : null,
    avgLatencyMs: mean(latencies),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    avgFailureLatencyMs: mean(failureLatencies),
    p50FailureLatencyMs: percentile(failureLatencies, 0.5),
    p95FailureLatencyMs: percentile(failureLatencies, 0.95),
    models: summaries,
  };
}

export async function getBenchmarkRun(
  db: D1Database,
  runId: string,
): Promise<BenchmarkRunDetail | null> {
  const row = await get<BenchmarkRunRow>(db, 'SELECT * FROM benchmark_runs WHERE id = ?', [runId]);
  if (!row) return null;
  const documents = await all<BenchmarkDocumentRow>(
    db,
    'SELECT * FROM benchmark_run_documents WHERE run_id = ? ORDER BY ordinal',
    [runId],
  );
  const results = await all<BenchmarkMeasurementRow>(
    db,
    `SELECT * FROM benchmark_model_results
      WHERE run_id = ? ORDER BY doc_id, provider, model`,
    [runId],
  );
  return {
    ...mapRun(row),
    documents: documents.map((document) => ({
      docId: document.doc_id,
      ordinal: document.ordinal,
      resolved: document.resolved === 1,
      groundTruth: parseJson<unknown>(document.ground_truth_json, null),
    })),
    results: results.map(mapMeasurement),
  };
}

export interface BenchmarkRescoreResult {
  run: BenchmarkRunDetail;
  rescoredMeasurements: number;
  scoringProfile: typeof BENCHMARK_SCORING_PROFILE;
}

function requestProfileRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

function runUsesCurrentScoringProfile(runRecord: BenchmarkRunDetail): boolean {
  return requestProfileRecord(runRecord.requestProfile).scoringProfile === BENCHMARK_SCORING_PROFILE;
}

/**
 * Recompute saved comparison columns from persisted model rows + the immutable
 * ground-truth snapshot. This path performs D1 reads/writes only; it cannot reach
 * a provider adapter or create a paid request.
 */
export async function rescoreBenchmarkRun(
  db: D1Database,
  runId: string,
  rescoredAt = new Date().toISOString(),
): Promise<BenchmarkRescoreResult | null> {
  const detail = await getBenchmarkRun(db, runId);
  if (!detail) return null;
  if (!Number.isFinite(Date.parse(rescoredAt))) throw new Error('rescoredAt must be an ISO timestamp');
  const documents = new Map(detail.documents.map((document) => [document.docId, document]));
  const updates: Array<[string, Array<string | number | null>]> = [];

  for (const result of detail.results) {
    if (result.outcome === 'running') continue;
    const document = documents.get(result.docId);
    if (!document) continue;
    const comparison = scorePersistedBenchmarkResult(document, result);
    updates.push([
      `UPDATE benchmark_model_results
          SET perfect_match = ?, true_positive = ?, false_positive = ?, false_negative = ?
        WHERE run_id = ? AND doc_id = ? AND provider = ? AND model = ?
          AND outcome <> 'running' AND claim_token IS NULL`,
      [
        comparison == null ? null : comparison.perfectMatch ? 1 : 0,
        comparison?.tp ?? null,
        comparison?.fp ?? null,
        comparison?.fn ?? null,
        detail.id,
        result.docId,
        result.provider,
        result.model,
      ],
    ]);
  }

  let rescoredMeasurements = 0;
  for (let offset = 0; offset < updates.length; offset += 50) {
    const results = await batch(db, updates.slice(offset, offset + 50));
    rescoredMeasurements += results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
  }
  if (rescoredMeasurements !== updates.length) {
    throw new Error(
      `benchmark rescore lost a terminal cell: updated ${rescoredMeasurements}/${updates.length}`,
    );
  }

  const requestProfile = {
    ...requestProfileRecord(detail.requestProfile),
    scoringProfile: BENCHMARK_SCORING_PROFILE,
  };
  await run(
    db,
    `UPDATE benchmark_runs SET request_profile_json = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(requestProfile), rescoredAt, detail.id],
  );

  let rescored = await getBenchmarkRun(db, detail.id);
  if (!rescored) throw new Error(`benchmark run ${detail.id} disappeared during rescore`);
  if (rescored.status === 'completed') {
    const summary = summarizeBenchmarkMeasurements(rescored.models, rescored.documents.length, rescored.results);
    await run(
      db,
      `UPDATE benchmark_runs
          SET known_cost_usd = ?, cost_covered_calls = ?, invoked_calls = ?,
              summary_json = ?, updated_at = ?
        WHERE id = ? AND status = 'completed'`,
      [
        summary.knownCostUsd,
        summary.coveredInvocations,
        summary.invokedCalls,
        JSON.stringify(summary),
        rescoredAt,
        rescored.id,
      ],
    );
    rescored = {
      ...rescored,
      knownCostUsd: summary.knownCostUsd,
      costCoveredCalls: summary.coveredInvocations,
      invokedCalls: summary.invokedCalls,
      summary,
      updatedAt: rescoredAt,
    };
  }

  return { run: rescored, rescoredMeasurements, scoringProfile: BENCHMARK_SCORING_PROFILE };
}

export async function completeBenchmarkRun(
  db: D1Database,
  runId: string,
  completedAt = new Date().toISOString(),
): Promise<BenchmarkRunDetail> {
  let detail = await getBenchmarkRun(db, runId);
  if (!detail) throw new Error(`benchmark run ${runId} not found`);
  if (!runUsesCurrentScoringProfile(detail)) {
    let rescored: BenchmarkRescoreResult | null;
    try {
      rescored = await rescoreBenchmarkRun(db, detail.id, completedAt);
    } catch (error) {
      const current = await getBenchmarkRun(db, runId);
      if (current && current.status !== 'running') {
        throw new BenchmarkRunStateConflictError(current.status);
      }
      throw error;
    }
    if (!rescored) throw new Error(`benchmark run ${runId} disappeared during rescore`);
    detail = rescored.run;
  }
  const expected = new Set(
    detail.documents.flatMap((document) => detail.models.map(
      (model) => `${document.docId}\u0000${model.provider}\u0000${model.model}`,
    )),
  );
  const completed = new Set(
    detail.results
      .filter((result) => result.outcome !== 'running')
      .map((result) => `${result.docId}\u0000${result.provider}\u0000${result.model}`),
  );
  const missing = [...expected].filter((key) => !completed.has(key));
  if (missing.length) {
    throw new Error(`benchmark run is incomplete: ${missing.length} model/document readings remain`);
  }
  const summary = summarizeBenchmarkMeasurements(detail.models, detail.documents.length, detail.results);
  const completedDocCount = detail.documents.length;
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(detail.startedAt));
  const completion = await run(
    db,
    `UPDATE benchmark_runs
        SET status = 'completed', completed_doc_count = ?, completed_at = ?,
            duration_ms = ?, known_cost_usd = ?, cost_covered_calls = ?,
            invoked_calls = ?, summary_json = ?, error = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [
      completedDocCount,
      completedAt,
      durationMs,
      summary.knownCostUsd,
      summary.coveredInvocations,
      summary.invokedCalls,
      JSON.stringify(summary),
      completedAt,
      runId,
    ],
  );
  if (Number(completion.meta?.changes ?? 0) !== 1) {
    const current = await getBenchmarkRun(db, runId);
    if (!current) throw new Error(`benchmark run ${runId} disappeared during completion`);
    if (current.status === 'completed') return current;
    throw new BenchmarkRunStateConflictError(current.status);
  }
  return {
    ...detail,
    status: 'completed',
    completedDocCount,
    completedAt,
    durationMs,
    knownCostUsd: summary.knownCostUsd,
    costCoveredCalls: summary.coveredInvocations,
    invokedCalls: summary.invokedCalls,
    summary,
    error: null,
    updatedAt: completedAt,
  };
}

export async function failBenchmarkRun(
  db: D1Database,
  runId: string,
  error: string,
  completedAt = new Date().toISOString(),
): Promise<boolean> {
  const result = await run(
    db,
    `UPDATE benchmark_runs
        SET status = 'failed', completed_at = ?,
            duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
            error = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [completedAt, completedAt, error.slice(0, 2000), completedAt, runId],
  );
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Attach the operator's A/B/C choice (and non-secret settings-write receipt) to
 * the benchmark that informed it. Call on both success and failure so a failed
 * Infisical write remains visible instead of disappearing from the audit trail.
 */
export async function recordBenchmarkSelection(
  db: D1Database,
  runId: string,
  input: {
    lineup: BenchmarkSelectedLineup;
    selectedAt?: string;
    error?: string | null;
    audit?: unknown;
  },
): Promise<void> {
  const selectedAt = input.selectedAt ?? new Date().toISOString();
  const cleanModel = (model: BenchmarkModelRef): BenchmarkModelRef => ({
    provider: cleanPart(model.provider, 'provider'),
    model: cleanPart(model.model, 'model'),
  });
  const lineup: BenchmarkSelectedLineup = {
    a: cleanModel(input.lineup.a),
    b: cleanModel(input.lineup.b),
    c: input.lineup.c ? cleanModel(input.lineup.c) : null,
  };
  await run(
    db,
    `UPDATE benchmark_runs
        SET selected_lineup_json = ?, selected_at = ?, selection_error = ?,
            selection_audit_json = ?, updated_at = ?
      WHERE id = ?`,
    [
      JSON.stringify(lineup),
      selectedAt,
      input.error?.slice(0, 2000) ?? null,
      jsonOrNull(input.audit),
      selectedAt,
      cleanPart(runId, 'runId'),
    ],
  );
}

export async function listBenchmarkRuns(
  db: D1Database,
  chamber?: BenchmarkChamber,
  requestedLimit = 20,
): Promise<BenchmarkRunRecord[]> {
  const limit = Math.min(Math.max(Math.floor(requestedLimit) || 20, 1), 100);
  const rows = chamber
    ? await all<BenchmarkRunRow>(
        db,
        'SELECT * FROM benchmark_runs WHERE chamber = ? ORDER BY started_at DESC LIMIT ?',
        [chamber, limit],
      )
    : await all<BenchmarkRunRow>(
        db,
        'SELECT * FROM benchmark_runs ORDER BY started_at DESC LIMIT ?',
        [limit],
      );
  return rows.map(mapRun);
}

export async function clearBenchmarkRuns(
  db: D1Database,
  chamber: BenchmarkChamber,
): Promise<{ runsDeleted: number; documentsDeleted: number; resultsDeleted: number }> {
  const active = await get<{ id: string }>(
    db,
    "SELECT id FROM benchmark_runs WHERE chamber = ? AND status = 'running' LIMIT 1",
    [chamber],
  );
  if (active) {
    throw new BenchmarkActiveRunConflictError(chamber, active.id);
  }
  const runRows = await all<{ id: string }>(
    db,
    'SELECT id FROM benchmark_runs WHERE chamber = ?',
    [chamber],
  );
  if (!runRows.length) return { runsDeleted: 0, documentsDeleted: 0, resultsDeleted: 0 };
  const runIds = runRows.map((row) => row.id);
  const placeholders = runIds.map(() => '?').join(', ');
  const results = await run(
    db,
    `DELETE FROM benchmark_model_results WHERE run_id IN (${placeholders})`,
    runIds,
  );
  const documents = await run(
    db,
    `DELETE FROM benchmark_run_documents WHERE run_id IN (${placeholders})`,
    runIds,
  );
  const runs = await run(
    db,
    `DELETE FROM benchmark_runs WHERE id IN (${placeholders}) AND chamber = ?`,
    [...runIds, chamber],
  );
  return {
    runsDeleted: Number(runs.meta?.changes ?? 0),
    documentsDeleted: Number(documents.meta?.changes ?? 0),
    resultsDeleted: Number(results.meta?.changes ?? 0),
  };
}
