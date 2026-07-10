/**
 * src/extraction/agreement.ts
 *
 * Cross-vendor agreement → auto-publish, as a TIERED CASCADE. Shared by the
 * admin /agreement-reprocess endpoint (on-demand, dry-runnable) and the
 * per-minute cron pass (autonomous). The cascade escalates a held-for-review
 * filing through up to three tiers before either publishing it autonomously or
 * leaving it for a human:
 *
 *   Tier 1  two models (A + B) cross-vendor. Unanimous full row-set + no
 *           hard-fail flags → publish (the original agreement behavior). On
 *           disagreement the doc is escalated to tier 2 (a fresh queue hop).
 *   Tier 2  three models (A + B + C). All three unanimous → publish. Otherwise
 *           fall through to tier 3 over the SAME three reads (no extra model
 *           calls).
 *   Tier 3  MAJORITY RESOLVE via buildConsensusRows over the three readings.
 *           Publish the majority row set ONLY IF every majority-present row has a
 *           per-field majority for txType, transactionDate, and the amount
 *           bracket (owner/assetName may fall back to the highest-confidence
 *           model's value) AND no hard-fail flags on any published row.
 *           Otherwise the doc stays in human review, flagged high-priority.
 *
 * When a doc trips cheap complexity signals (page_count / raw_bytes over their
 * thresholds) the cascade starts directly at tier 2 (AGREEMENT_BIG_DOC_START_TIER2,
 * default on). Attempts are capped by AGREEMENT_MAX_ATTEMPTS (default 3).
 *
 * The AUTONOMOUS cascade (handleAgreementCheck; NOT the operator-triggered
 * /agreement-reprocess endpoint, which stays uncapped) is additionally metered
 * against a daily candidate-doc-read budget, AGREEMENT_DAILY_LLM_BUDGET
 * (default 300; -1 = unlimited), backed by the llm_budget D1 table and
 * enforced atomically per tier via reserveLlmBudget so a runaway escalation
 * loop can't spend the day's LLM calls unbounded. A budget-exhausted doc is
 * left in review with a diagnostics receipt and does NOT consume an agreement
 * attempt.
 *
 * Every candidate's raw per-doc reading (success or structured failure) is
 * persisted to extraction_runs via bakeoff.ts's persistExtractionRun
 * (kind='agreement'), regardless of the eventual publish decision, for the
 * review dashboard + later learning. Machine-resolved docs are marked in the
 * ingestion_decisions audit with resolvedBy:'agreement-cascade', the resolving
 * tier, the models, and a per-field vote summary, so they stay distinguishable
 * from human confirmations downstream.
 *
 * On `source`: published rows keep source='primary' (NOT a new 'agreement'
 * source) because downstream consumers depend on that value — pitScores.ts's
 * `allPrimary` gate (src/export/pitScores.ts) and the dashboard's primary count
 * (src/ui/dashboardHtml.ts) both filter on source === 'primary', and TxSource is
 * the closed union 'primary' | 'seed_dataset' | 'manual'. Distinguishability
 * comes from the ingestion_decisions audit row instead.
 */

import type { Env, ParsedTx, Owner, TxType } from '../shared/types';
import { all, get, run } from '../shared/db';
import { runCandidateOnDoc, persistExtractionRun, type BakeoffCandidate, type CandidateDocResult } from './bakeoff';
import { arbitrationRowKey } from '../extractors/types';
import { recomputeTransactions, persistTransactions, HARD_FAILURE_FLAGS } from './normalizer';
import { mapFiling, type FilingRow } from '../delivery/rows';
import { recordIngestionDecision } from '../shared/ingestionDecisions';
import { buildConsensusRows, type AmountBracket, type ConsensusResult } from './consensus';
import { uuid } from '../shared/ids';

export interface AgreementModels {
  a: BakeoffCandidate;
  b: BakeoffCandidate;
  /** Optional third-model consensus tier; off by default. */
  c?: BakeoffCandidate | null;
}

/** A three-model lineup for tier-2+ passes (C required and non-null). */
export interface AgreementModelsC {
  a: BakeoffCandidate;
  b: BakeoffCandidate;
  c: BakeoffCandidate;
}

export type AgreementOutcome =
  | 'published'
  | 'would_publish'
  | 'disagree'
  | 'agree_but_hardfail'
  | 'review_flagged'
  | 'skipped';

export interface AgreementDocResult {
  docId: string;
  outcome: AgreementOutcome;
  /** Resolving tier (1 A/B unanimous, 2 A/B/C unanimous, 3 majority resolve). */
  tier?: number;
  rowCount?: number;
  inserted?: number;
  reason?: string;
  flags?: string[];
  tickers?: string[];
  rows?: Record<string, number | string>;
}

const label = (c: BakeoffCandidate): string => `${c.provider}:${c.model}`;

/** Audit context threaded into the ingestion_decisions row for a cascade resolve. */
interface CascadeAudit {
  tier: number;
  models: Record<string, string>;
  unanimous?: boolean;
  /** Per-field vote summary (tier-3 majority resolve); omitted for unanimous tiers. */
  votes?: unknown;
}

/** True when two candidate reads carry the identical row-key SET (not just count). */
export function sameRowSet(a: CandidateDocResult, b: CandidateDocResult): boolean {
  if (!a.ok || !b.ok || a.rows.length === 0) return false;
  const ka = new Set(a.rows.map(arbitrationRowKey));
  const kb = new Set(b.rows.map(arbitrationRowKey));
  if (ka.size !== kb.size) return false;
  for (const k of ka) if (!kb.has(k)) return false;
  return true;
}

/**
 * Load the raw doc bytes for a review filing, or a skip result explaining why we
 * can't read it. Shared by the tier executors.
 */
async function loadDocBytes(
  env: Env,
  docId: string,
  rawObjectKey: string | null,
): Promise<{ bytes: ArrayBuffer } | { skip: AgreementDocResult }> {
  if (!rawObjectKey) return { skip: { docId, outcome: 'skipped', reason: 'no raw_object_key' } };
  const obj = await env.RAW_FILES.get(rawObjectKey);
  if (!obj) return { skip: { docId, outcome: 'skipped', reason: 'R2 object missing' } };
  return { bytes: await obj.arrayBuffer() };
}

/** Fetch the filing row backing a doc (needed by the normalizer + publish path). */
async function loadFilingRow(env: Env, docId: string): Promise<FilingRow | null> {
  return get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, filer_id, filing_type, filed_date, source_url, raw_object_key,
            ingest_status, doc_kind, extractor, model_version, confidence, first_seen_at,
            source_updated_at, error FROM filings WHERE doc_id = ?`,
    [docId],
  );
}

/** Run each model over the doc and persist every reading to extraction_runs. */
async function readAndPersist(
  env: Env,
  models: BakeoffCandidate[],
  docId: string,
  bytes: ArrayBuffer,
  runBatchId: string,
): Promise<CandidateDocResult[]> {
  const reads: CandidateDocResult[] = [];
  for (const m of models) {
    const r = await runCandidateOnDoc(env, m, docId, bytes);
    await persistExtractionRun(env, r, 'agreement', runBatchId);
    reads.push(r);
  }
  return reads;
}

/**
 * Normalize a candidate row set for a filing and, unless dryRun, publish it —
 * overriding the soft confidence cap. Shared by every tier's publish path so the
 * write side (persist tx + resolve review + audit + delivery fan-out) is
 * identical regardless of how the rows were agreed. Returns 'agree_but_hardfail'
 * without publishing when any resulting row carries a hard-failure flag.
 */
async function finalizePublish(
  env: Env,
  frow: FilingRow,
  docId: string,
  parsed: ParsedTx[],
  dryRun: boolean,
  audit: CascadeAudit,
): Promise<AgreementDocResult> {
  const flagged = await recomputeTransactions(env, mapFiling(frow), parsed);
  const hardFlags = Array.from(
    new Set(flagged.flatMap((f) => f.flags).filter((fl) => HARD_FAILURE_FLAGS.includes(fl))),
  );
  if (hardFlags.length) {
    return { docId, outcome: 'agree_but_hardfail', tier: audit.tier, rowCount: parsed.length, flags: hardFlags };
  }

  if (dryRun) {
    return {
      docId,
      outcome: 'would_publish',
      tier: audit.tier,
      rowCount: flagged.length,
      tickers: flagged.map((f) => f.tx.ticker).filter((t): t is string => !!t).slice(0, 8),
    };
  }

  const txs = flagged.map((f) => ({ ...f.tx, source: 'primary' as const, confidence: Math.max(f.tx.confidence, 0.95) }));
  const insertedIds = await persistTransactions(env, txs);
  await run(env.DB, "UPDATE filings SET ingest_status = 'persisted', error = NULL WHERE doc_id = ?", [docId]);
  await run(env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [docId]);
  if (insertedIds.length > 0) {
    await recordIngestionDecision(env.DB, {
      docId,
      action: 'agreement_published',
      source: 'agreement',
      reason: 'model_agreement',
      transactionIds: insertedIds,
      payload: {
        resolvedBy: 'agreement-cascade',
        tier: audit.tier,
        unanimous: audit.unanimous ?? undefined,
        rowCount: flagged.length,
        inserted: insertedIds.length,
        models: audit.models,
        votes: audit.votes ?? undefined,
      },
    });
  }
  for (const txId of insertedIds) {
    try { await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId }); } catch { /* best-effort */ }
  }
  return { docId, outcome: 'published', tier: audit.tier, inserted: insertedIds.length };
}

/**
 * Run the (tier-1/2) agreement check on ONE document and (unless dryRun) publish
 * on FULL agreement across the supplied models. This is the original
 * agreement-publish path: it publishes only on unanimity and returns 'disagree'
 * without escalating (the cascade orchestration lives in handleAgreementCheck).
 * Kept stable for the admin /agreement-reprocess endpoint and its tests.
 */
export async function processAgreementDoc(
  env: Env,
  models: AgreementModels,
  docId: string,
  rawObjectKey: string | null,
  dryRun: boolean,
  audit?: Partial<CascadeAudit>,
): Promise<AgreementDocResult> {
  const loaded = await loadDocBytes(env, docId, rawObjectKey);
  if ('skip' in loaded) return loaded.skip;

  // Group this doc's candidate reads under one batch id so they're
  // recognizable as one agreement pass in the extraction_runs dashboard.
  const runBatchId = uuid();
  const lineup = [models.a, models.b, ...(models.c ? [models.c] : [])];
  const reads = await readAndPersist(env, lineup, docId, loaded.bytes, runBatchId);
  const [rA, rB, rC] = [reads[0], reads[1], reads[2] ?? null];

  const agree = sameRowSet(rA, rB) && (!rC || (sameRowSet(rA, rC) && sameRowSet(rB, rC)));
  if (!agree) {
    return {
      docId,
      outcome: 'disagree',
      rows: {
        [label(models.a)]: rA.ok ? rA.rowCount : 'ERR',
        [label(models.b)]: rB.ok ? rB.rowCount : 'ERR',
        ...(models.c ? { [label(models.c)]: rC && rC.ok ? rC.rowCount : 'ERR' } : {}),
      },
    };
  }

  const frow = await loadFilingRow(env, docId);
  if (!frow) return { docId, outcome: 'skipped', reason: 'filing row missing' };

  return finalizePublish(env, frow, docId, rA.rows, dryRun, {
    tier: audit?.tier ?? (models.c ? 2 : 1),
    models: modelLabels(models),
    unanimous: true,
    votes: audit?.votes,
  });
}

/** {a, b, c?} → { a: "prov:model", ... } for the audit payload. */
function modelLabels(models: AgreementModels): Record<string, string> {
  return {
    a: label(models.a),
    b: label(models.b),
    ...(models.c ? { c: label(models.c) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tier 3 — majority resolve over three reads (pure-ish helpers)
// ---------------------------------------------------------------------------

/** The highest-confidence model's reading of a given row key, across all reads. */
function baseRowFor(reads: CandidateDocResult[], rowKey: string): ParsedTx | null {
  let best: ParsedTx | null = null;
  for (const r of reads) {
    for (const tx of r.rows) {
      if (arbitrationRowKey(tx) !== rowKey) continue;
      if (!best || (tx.confidence ?? 0) > (best.confidence ?? 0)) best = tx;
    }
  }
  return best;
}

interface MajorityBuild {
  ok: boolean;
  rows: ParsedTx[];
  reason?: string;
}

/**
 * Build the publishable majority row set from a consensus over `totalModels`
 * reads. A row qualifies only when it is present in a strict majority of the
 * models AND has a per-field majority for txType, transactionDate, and the
 * amount bracket. owner/assetName/ticker fall back to the highest-confidence
 * model's value when they lack a majority. If ANY majority-present row fails the
 * type/date/amount gate the whole doc is rejected (ok:false) — the caller then
 * leaves it in human review.
 *
 * Multi-lot guard: the consensus row key is ticker|date|type (amount excluded),
 * so two genuinely-distinct lots disclosed on the same day with the same type
 * but different dollar brackets share one key and collapse to a single voted
 * row — auto-publishing would silently DROP the other lot(s). Whenever any
 * single read reported 2+ distinct amount brackets for a majority row key we
 * cannot faithfully represent the set, so the whole doc is rejected to human
 * review rather than published incomplete.
 */
function buildMajorityRows(
  reads: CandidateDocResult[],
  consensus: ConsensusResult,
  totalModels: number,
): MajorityBuild {
  const majorityRows = consensus.rows.filter((r) => r.presentIn.length * 2 > totalModels);
  if (majorityRows.length === 0) return { ok: false, rows: [], reason: 'no_majority_rows' };

  const amountKey = (tx: ParsedTx): string => `${tx.amountMin ?? ''}|${tx.amountMax ?? ''}`;
  for (const r of majorityRows) {
    for (const read of reads) {
      const brackets = new Set<string>();
      for (const tx of read.rows) {
        if (arbitrationRowKey(tx) === r.rowKey) brackets.add(amountKey(tx));
      }
      if (brackets.size > 1) return { ok: false, rows: [], reason: `multi_lot:${r.rowKey}` };
    }
  }

  const hasMaj = (f: { votes: number; total: number }): boolean => f.votes * 2 > f.total;
  const built: ParsedTx[] = [];
  for (const r of majorityRows) {
    const { txType, transactionDate, amount, owner, assetName, ticker } = r.fields;
    if (!(hasMaj(txType) && hasMaj(transactionDate) && hasMaj(amount))) {
      return { ok: false, rows: [], reason: `field_disagreement:${r.rowKey}` };
    }
    const base = baseRowFor(reads, r.rowKey);
    if (!base) return { ok: false, rows: [], reason: `no_base:${r.rowKey}` };
    const amt = amount.value as AmountBracket;
    built.push({
      ...base,
      txType: ((txType.value as TxType | null) ?? base.txType),
      txDate: transactionDate.value as string | null,
      owner: (hasMaj(owner) ? (owner.value as Owner | null) : base.owner),
      assetName: (hasMaj(assetName) ? (assetName.value as string | null) : base.assetName) || base.assetName,
      ticker: (hasMaj(ticker) ? (ticker.value as string | null) : base.ticker),
      amountMin: amt.amountMin,
      amountMax: amt.amountMax,
    });
  }
  return { ok: true, rows: built };
}

/** Compact per-field vote summary for the audit payload (majority-present rows). */
function voteSummary(consensus: ConsensusResult, totalModels: number): unknown {
  return consensus.rows
    .filter((r) => r.presentIn.length * 2 > totalModels)
    .map((r) => ({
      rowKey: r.rowKey,
      presentIn: r.presentIn,
      fields: Object.fromEntries(
        Object.entries(r.fields).map(([name, fc]) => [name, `${fc.votes}/${fc.total}`]),
      ),
    }));
}

/**
 * Leave a doc in human review, flagged high-priority, when the cascade could not
 * resolve it. Records the distinguishing ingestion_decisions audit row and
 * annotates the review_queue reason/payload with the cascade context.
 */
async function leaveInReviewHighPriority(
  env: Env,
  docId: string,
  tier: number,
  models: Record<string, string>,
  votes: unknown,
  reason: string,
): Promise<AgreementDocResult> {
  const payload = { resolvedBy: 'agreement-cascade', priority: 'high', tier, models, votes, detail: reason };
  try {
    await run(
      env.DB,
      'UPDATE review_queue SET reason = ?, payload = ? WHERE doc_id = ?',
      ['agreement_cascade_unresolved', JSON.stringify(payload), docId],
    );
  } catch (err) {
    console.warn('leaveInReviewHighPriority update failed:', docId, (err as Error).message);
  }
  await recordIngestionDecision(env.DB, {
    docId,
    action: 'review_opened',
    source: 'agreement',
    reason: 'cascade_unresolved',
    payload,
  });
  return { docId, outcome: 'review_flagged', tier, reason };
}

/**
 * Tier-2/3 executor: read A + B + C once, publish on 3-way unanimity, else
 * attempt a tier-3 majority resolve over the SAME three reads. On an
 * unresolvable set (no majority, a field-level tie, or a hard-fail flag) the doc
 * stays in human review, flagged high-priority. Persists all three reads.
 */
export async function processAgreementCascadeTier2(
  env: Env,
  models: AgreementModelsC,
  docId: string,
  rawObjectKey: string | null,
  dryRun: boolean,
): Promise<AgreementDocResult> {
  const loaded = await loadDocBytes(env, docId, rawObjectKey);
  if ('skip' in loaded) return loaded.skip;

  const runBatchId = uuid();
  const reads = await readAndPersist(env, [models.a, models.b, models.c], docId, loaded.bytes, runBatchId);
  const [rA, rB, rC] = reads;

  const frow = await loadFilingRow(env, docId);
  if (!frow) return { docId, outcome: 'skipped', reason: 'filing row missing' };

  const labels = modelLabels(models);

  // 3-way unanimity → publish exactly as the original agreement path (tier 2).
  const unanimous = rA.ok && rB.ok && rC.ok
    && sameRowSet(rA, rB) && sameRowSet(rA, rC) && sameRowSet(rB, rC);
  if (unanimous) {
    return finalizePublish(env, frow, docId, rA.rows, dryRun, { tier: 2, models: labels, unanimous: true });
  }

  // If any model's read failed (ok: false, rows: []) it would be counted as
  // "saw nothing" by buildConsensusRows, turning a 2/3 majority into a false
  // publish quorum. Only proceed to majority resolve when ALL three reads
  // succeeded; otherwise leave the doc for human review.
  if (!rA.ok || !rB.ok || !rC.ok) {
    if (dryRun) return { docId, outcome: 'review_flagged', tier: 3, reason: 'model_read_failed' };
    return leaveInReviewHighPriority(env, docId, 3, labels, null, 'model_read_failed');
  }

  // Tier 3 — majority resolve over the three reads (no extra model calls).
  const consensus = buildConsensusRows([
    { model: labels.a, rows: rA.rows },
    { model: labels.b, rows: rB.rows },
    { model: labels.c, rows: rC.rows },
  ]);
  const majority = buildMajorityRows(reads, consensus, 3);
  const votes = voteSummary(consensus, 3);
  if (!majority.ok) {
    if (dryRun) return { docId, outcome: 'review_flagged', tier: 3, reason: majority.reason };
    return leaveInReviewHighPriority(env, docId, 3, labels, votes, majority.reason ?? 'no_majority');
  }

  const res = await finalizePublish(env, frow, docId, majority.rows, dryRun, {
    tier: 3,
    models: labels,
    unanimous: false,
    votes,
  });
  // A hard-fail on the majority row set is NOT publishable — flag high-priority.
  if (res.outcome === 'agree_but_hardfail') {
    if (dryRun) return res;
    return leaveInReviewHighPriority(env, docId, 3, labels, votes, `hard_fail:${(res.flags ?? []).join(',')}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Autonomous pass (cron backstop + queue consumer)
// ---------------------------------------------------------------------------

/** Parse "provider:model" or fall back. e.g. "mistral:mistral-ocr-latest". */
function parseCandidate(s: string | undefined, fallback: BakeoffCandidate): BakeoffCandidate {
  if (!s) return fallback;
  const [provider, ...rest] = s.split(':');
  const model = rest.join(':');
  const valid = ['gemini', 'openai', 'anthropic', 'mistral', 'xai', 'llamaparse'];
  return valid.includes(provider) && model ? ({ provider, model } as BakeoffCandidate) : fallback;
}

interface AgreementEnv {
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  AGREEMENT_AUTOPUBLISH_MODEL_A?: string;
  AGREEMENT_AUTOPUBLISH_MODEL_B?: string;
  AGREEMENT_AUTOPUBLISH_LIMIT?: string;
  AGREEMENT_MODEL_C?: string;
  AGREEMENT_MAX_ATTEMPTS?: string;
  AGREEMENT_BIG_DOC_START_TIER2?: string;
  AGREEMENT_BIG_DOC_PAGE_THRESHOLD?: string;
  AGREEMENT_BIG_DOC_BYTES_THRESHOLD?: string;
  AGREEMENT_DAILY_LLM_BUDGET?: string;
}

/** Resolve the configured A/B agreement models (with sensible defaults). */
function resolveModels(e: AgreementEnv): AgreementModels {
  return {
    a: parseCandidate(e.AGREEMENT_AUTOPUBLISH_MODEL_A, { provider: 'mistral', model: 'mistral-ocr-latest' }),
    b: parseCandidate(e.AGREEMENT_AUTOPUBLISH_MODEL_B, { provider: 'gemini', model: 'gemini-3.5-flash' }),
  };
}

/** Resolve the A/B/C lineup for a tier-2+ pass (C defaults to a third vendor). */
function resolveModelsWithC(e: AgreementEnv): AgreementModelsC {
  const ab = resolveModels(e);
  const c = parseCandidate(e.AGREEMENT_MODEL_C, { provider: 'openai', model: 'gpt-4o' });
  return { a: ab.a, b: ab.b, c };
}

/** Max cascade attempts before a doc stays in human review (clamped 1–5). */
function maxAttempts(e: AgreementEnv): number {
  const n = parseInt(e.AGREEMENT_MAX_ATTEMPTS || '3', 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : 3, 1), 5);
}

// ---------------------------------------------------------------------------
// Daily LLM budget guardrail — autonomous cascade only. There is no cap on the
// operator-triggered /agreement-reprocess endpoint (it calls processAgreementDoc
// directly and never reaches handleAgreementCheck), matching the spec that
// humans clicking buttons stay uncapped. One model reading one doc = 1 read.
// ---------------------------------------------------------------------------

const DEFAULT_DAILY_LLM_BUDGET = 300;
/** Explicit sentinel meaning "no cap"; 0/unset/non-numeric fall back to the default instead. */
const LLM_BUDGET_UNLIMITED = -1;

/** Resolve AGREEMENT_DAILY_LLM_BUDGET: -1 (explicit) => unlimited; anything else unset/zero/invalid => the 300/day default. */
function dailyLlmBudget(e: AgreementEnv): number {
  const n = parseInt(e.AGREEMENT_DAILY_LLM_BUDGET ?? '', 10);
  if (n === LLM_BUDGET_UNLIMITED) return LLM_BUDGET_UNLIMITED;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LLM_BUDGET;
}

/** UTC calendar-day key for the llm_budget counter row (rolls over at midnight UTC). */
function llmBudgetDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Atomically reserve `count` candidate doc-reads against today's LLM budget,
 * up front for the whole tier (2 reads for tier 1, 3 for tier 2+) rather than
 * per individual model call — a partial reservation would leave the cascade
 * mid-read with fewer candidates than sameRowSet/buildMajorityRows expect, so
 * bailing out before ANY read starts keeps their invariants (and this task's
 * "do not disturb the cascade" constraint) intact. Returns true (counter
 * incremented by `count`) when that stays within budget; false (counter
 * untouched) once today's cap would be exceeded. -1 (unlimited) always
 * returns true without touching the DB.
 *
 * The actual gate is the single guarded UPDATE: its WHERE clause only lets the
 * increment apply under the cap, so D1's `meta.changes` tells us whether THIS
 * reservation landed — the same "genuinely happened" gate as insertFilingIfNew
 * (src/ingestion/watcher.ts). Fails OPEN (never blocks the cascade) on a
 * missing table / transient D1 error, the same policy as bumpAttempt() below —
 * a pre-migration deploy behaves like unlimited rather than wedging the cascade.
 */
async function reserveLlmBudget(env: Env, budget: number, count: number): Promise<boolean> {
  if (budget === LLM_BUDGET_UNLIMITED) return true;
  const day = llmBudgetDay();
  try {
    await run(env.DB, 'INSERT OR IGNORE INTO llm_budget (day, reads) VALUES (?, 0)', [day]);
    const res = await run(
      env.DB,
      'UPDATE llm_budget SET reads = reads + ? WHERE day = ? AND reads + ? <= ?',
      [count, day, count, budget],
    );
    return (res.meta?.changes ?? 0) > 0;
  } catch (err) {
    console.warn('reserveLlmBudget failed (failing open):', (err as Error).message);
    return true;
  }
}

/**
 * Record a diagnostics receipt when the daily LLM budget is exhausted, using
 * the same recordIngestionDecision "receipt" pattern as leaveInReviewHighPriority
 * above. Unlike that helper, this does NOT touch review_queue — the doc is
 * left exactly as it was (not flagged high-priority; budget exhaustion is an
 * operational throttle, not a model disagreement) and gets a fresh shot once
 * the day's budget resets.
 */
async function deferForBudgetExhausted(env: Env, docId: string, tier: number, budget: number): Promise<void> {
  await recordIngestionDecision(env.DB, {
    docId,
    action: 'review_opened',
    source: 'agreement',
    reason: 'llm_budget_exhausted',
    payload: { resolvedBy: 'agreement-cascade', tier, budget, detail: 'budget_exhausted' },
  });
}

/**
 * Decide the starting tier for a fresh (tier-1) pass. Cheap complexity signals
 * (filings.page_count / filings.raw_bytes, populated best-effort by the
 * orchestrator) push a big doc straight to tier 2 for a third opinion. Gated by
 * AGREEMENT_BIG_DOC_START_TIER2 (default on). Never throws (pre-migration safe).
 */
async function resolveStartTier(env: Env, e: AgreementEnv, docId: string): Promise<number> {
  if (e.AGREEMENT_BIG_DOC_START_TIER2 === 'false') return 1;
  const pageMax = parseInt(e.AGREEMENT_BIG_DOC_PAGE_THRESHOLD || '10', 10) || 10;
  const bytesMax = parseInt(e.AGREEMENT_BIG_DOC_BYTES_THRESHOLD || '2097152', 10) || 2097152;
  try {
    const row = await get<{ page_count: number | null; raw_bytes: number | null }>(
      env.DB,
      'SELECT page_count, raw_bytes FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (!row) return 1;
    if ((row.page_count ?? 0) > pageMax || (row.raw_bytes ?? 0) > bytesMax) return 2;
  } catch {
    return 1; // complexity columns not migrated yet — start at tier 1
  }
  return 1;
}

/**
 * Increment the doc's cascade attempt counter and stamp the current tier +
 * attempted-at. Returns the NEW attempt count (1-based). Never throws; a
 * pre-migration DB (missing columns) reads as 0 attempts and the UPDATE is a
 * best-effort no-op.
 */
async function bumpAttempt(env: Env, docId: string, tier: number): Promise<number> {
  let prior = 0;
  try {
    const row = await get<{ agreement_attempts: number | null }>(
      env.DB,
      'SELECT agreement_attempts FROM review_queue WHERE doc_id = ?',
      [docId],
    );
    prior = row?.agreement_attempts ?? 0;
  } catch { /* column missing pre-migration */ }
  const next = prior + 1;
  try {
    await run(
      env.DB,
      'UPDATE review_queue SET agreement_attempts = ?, agreement_tier = ?, agreement_attempted_at = ? WHERE doc_id = ?',
      [next, tier, new Date().toISOString(), docId],
    );
  } catch (err) {
    console.warn('bumpAttempt failed:', docId, (err as Error).message);
  }
  return next;
}

/**
 * Enqueue an `agreement.check` for one doc at a given tier. Optionally stamps the
 * legacy agreement_attempted_at marker (used by the cron's fresh pickup to avoid
 * re-enqueuing the same doc every minute); the tier-2 escalation path skips the
 * stamp since the doc is already in-flight. The stamp is written only when a
 * send is about to happen and rolled back on send failure so a transient error
 * lets the backstop retry. Returns true when a check was enqueued.
 */
export async function enqueueAgreementCheck(
  env: Env,
  docId: string,
  rawObjectKey: string | null,
  escalationTier = 1,
  stampAttempt = true,
): Promise<boolean> {
  const e = env as unknown as AgreementEnv;
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return false;

  let dbUpdated = false;
  if (stampAttempt) {
    const now = new Date().toISOString();
    try {
      await run(env.DB, 'UPDATE review_queue SET agreement_attempted_at = ? WHERE doc_id = ?', [now, docId]);
      dbUpdated = true;
    } catch (err) {
      console.warn('enqueueAgreementCheck DB stamp failed:', docId, (err as Error).message);
    }
  }

  try {
    await env.INGEST_QUEUE.send({ type: 'agreement.check', docId, rawObjectKey, escalationTier });
    return true;
  } catch (err) {
    console.warn('enqueueAgreementCheck send failed:', docId, (err as Error).message);
    if (dbUpdated) {
      try {
        await run(env.DB, 'UPDATE review_queue SET agreement_attempted_at = NULL WHERE doc_id = ?', [docId]);
      } catch (rollbackErr) {
        console.error('enqueueAgreementCheck rollback failed:', docId, (rollbackErr as Error).message);
      }
    }
    return false;
  }
}

/**
 * Queue-consumer handler for an `agreement.check` message: run the appropriate
 * cascade tier for one doc. Tier 1 (or a big-doc tier-2 start) reads A + B and
 * publishes on unanimity, escalating to tier 2 on disagreement (a fresh queue
 * hop) while the attempt cap allows. Tier 2 reads A + B + C, publishing on
 * unanimity or a tier-3 majority resolve, else leaving the doc in human review.
 * Self-gates on the flag so a disabled deploy drains queued checks as no-ops.
 *
 * Also self-gates on the daily LLM budget (AGREEMENT_DAILY_LLM_BUDGET, default
 * 300, -1 = unlimited): before spending an attempt, this tier's candidate
 * reads (2 for tier 1, 3 for tier 2+) are reserved atomically against today's
 * counter. Once the day's budget is exhausted, the doc is left in review with
 * a diagnostics receipt and does NOT consume an agreement attempt or escalate
 * — it gets a fresh shot once the day rolls over.
 */
export async function handleAgreementCheck(
  env: Env,
  docId: string,
  rawObjectKey: string | null,
  escalationTier?: number,
): Promise<void> {
  const e = env as unknown as AgreementEnv;
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return;

  // A fresh check (tier unset) may start at tier 2 for a complex doc.
  let tier = escalationTier ?? 1;
  if (tier === 1) tier = await resolveStartTier(env, e, docId);

  const budget = dailyLlmBudget(e);
  const readsNeeded = tier >= 2 ? 3 : 2;
  if (!(await reserveLlmBudget(env, budget, readsNeeded))) {
    await deferForBudgetExhausted(env, docId, tier, budget);
    // Clear the agreement_attempted_at stamp that enqueueAgreementCheck set,
    // so the cron backstop picks this doc up again after the budget resets
    // (next UTC day) rather than permanently ignoring it.
    try {
      await run(env.DB, 'UPDATE review_queue SET agreement_attempted_at = NULL WHERE doc_id = ?', [docId]);
    } catch (err) {
      console.warn('handleAgreementCheck failed to clear stamp on budget-exhausted:', docId, (err as Error).message);
    }
    console.log(`agreement.check ${docId} tier${tier}: LLM budget exhausted (cap ${budget}/day) → deferred, no attempt spent`);
    return;
  }

  const attempts = await bumpAttempt(env, docId, tier);
  const max = maxAttempts(e);

  if (tier >= 2) {
    const res = await processAgreementCascadeTier2(env, resolveModelsWithC(e), docId, rawObjectKey, false);
    console.log(`agreement.check ${docId} tier${tier}: ${res.outcome}${res.inserted ? ` (+${res.inserted} tx)` : ''}`);
    return;
  }

  // Tier 1 — two-model cross-vendor check (unchanged publish behavior).
  const res = await processAgreementDoc(env, resolveModels(e), docId, rawObjectKey, false, { tier: 1 });
  if (res.outcome === 'disagree') {
    if (attempts < max) {
      const escalated = await enqueueAgreementCheck(env, docId, rawObjectKey, 2, false);
      if (!escalated) {
        // Enqueue failed — the doc still has its tier-1 agreement_attempted_at
        // stamp so the cron backstop won't retry. Escalation is the only path
        // to tier 2/3, so flag for human review rather than leaving the doc in
        // invisible limbo.
        await leaveInReviewHighPriority(
          env, docId, 1, modelLabels(resolveModels(e)), res.rows ?? null, 'escalation_enqueue_failed',
        );
      }
      console.log(`agreement.check ${docId} tier1: disagree → ${escalated ? 'escalated to tier2' : 'escalation enqueue failed'}`);
      return;
    }
    // Attempt cap reached — leave in human review, flagged high-priority.
    await leaveInReviewHighPriority(env, docId, 1, modelLabels(resolveModels(e)), res.rows ?? null, 'attempt_cap_reached');
    console.log(`agreement.check ${docId} tier1: disagree, attempt cap (${max}) reached → human review`);
    return;
  }
  console.log(`agreement.check ${docId} tier1: ${res.outcome}${res.inserted ? ` (+${res.inserted} tx)` : ''}`);
}

/**
 * Autonomous per-minute backstop: pick up to `limit` review docs that have NOT
 * yet had an agreement attempt and ENQUEUE a fresh tier-1 agreement.check for
 * each (fast — no model work, so it never gets canceled like inline cron work
 * does). Each doc is stamped on enqueue (agreement_attempted_at) so it is not
 * re-enqueued every minute; the tiered cascade thereafter runs in the queue
 * consumer. Self-gates on AGREEMENT_AUTOPUBLISH_ENABLED; never throws (cron-safe).
 */
export async function maybeRunAgreementAutopublish(env: Env): Promise<{ attempted: number; enqueued: number } | null> {
  const e = env as unknown as AgreementEnv;
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return null;
  const limit = Math.min(Math.max(parseInt(e.AGREEMENT_AUTOPUBLISH_LIMIT || '3', 10) || 3, 1), 10);

  let docs: Array<{ doc_id: string; raw_object_key: string | null }>;
  try {
    docs = await all<{ doc_id: string; raw_object_key: string | null }>(
      env.DB,
      `SELECT f.doc_id, f.raw_object_key
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0 AND rq.agreement_attempted_at IS NULL AND f.raw_object_key IS NOT NULL
        ORDER BY rq.created_at DESC LIMIT ?`,
      [limit],
    );
  } catch {
    return null; // migration not applied yet
  }

  let enqueued = 0;
  for (const d of docs) {
    if (await enqueueAgreementCheck(env, d.doc_id, d.raw_object_key)) enqueued++;
  }
  if (docs.length) console.log(`agreement autopublish: enqueued ${enqueued}/${docs.length} checks`);
  return { attempted: docs.length, enqueued };
}
