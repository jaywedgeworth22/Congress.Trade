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
 *   Tier 3  MAJORITY RESOLVE over the same three readings. Publish only when
 *           every union row is majority-present, every material field has a
 *           strict majority, no minority-only/ambiguous duplicate row would be
 *           dropped, and no hard-fail flag remains. Otherwise the doc stays in
 *           human review, flagged high-priority.
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
 *
 * "Unanimous"/"majority" above means MATERIAL agreement, not byte agreement.
 * The 9 strict/enum fields (ticker, amount_min, amount_max, tx_type, tx_date,
 * owner, is_option, cap_gains_over_200, filing_status) always require exact
 * value equality. The 7 free-text fields (assetName, assetType, assetTypeName,
 * subholding, location, description, supplementalText) compare through a
 * canonical form (casefold, punctuation stripped, company suffixes
 * canonicalized via the existing cleanAssetString helper) so two vendors that
 * both correctly read "First Data Corp." don't disagree merely over casing or
 * punctuation — the single largest cause of the cascade's production
 * 0-publish rate before this normalization (324/324 cascade_unresolved over a
 * 6h sample). Gated by AGREEMENT_TEXT_NORMALIZATION (default on; 'false'
 * restores byte-strict comparison on every tier). See materialRowFingerprint,
 * buildMajorityRows, and resolveAgreedRows below for the mechanics.
 */

import type { Env, ParsedTx, Transaction } from '../shared/types';
import { all, batch, fromBool, get, run } from '../shared/db';
import {
  runCandidateOnDoc,
  persistExtractionRun,
  upgradeRetiredDisclosureCandidate,
  type BakeoffCandidate,
  type CandidateDocResult,
  type CandidateInvocation,
} from './bakeoff';
import { arbitrationRowKey } from '../extractors/types';
import {
  recomputeTransactions,
  HARD_FAILURE_FLAGS,
  MAX_PUBLISH_TRANSACTIONS_PER_FILING,
  loadResolver,
} from './normalizer';
import { cleanAssetString } from './nameNormalizer';
import { mapFiling, type FilingRow } from '../delivery/rows';
import { recordIngestionDecision } from '../shared/ingestionDecisions';
import { buildConsensusRows, type AmountBracket, type ConsensusResult } from './consensus';
import { uuid } from '../shared/ids';
import { estimateTransactionValue } from '../shared/transactionValue';
import { flushDeliveryOutbox } from '../delivery/outbox';
import { resolveSecrets } from '../secrets/infisical';
import { getUnderlyingProvider } from '../benchmark/settings';
import { recordProviderHealth } from './providerHealth';

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
  /** Autonomous lease owner; omitted for an operator-triggered reprocess. */
  claimToken?: string;
  /** Review version observed before operator-triggered model reads. */
  reviewRevision?: number;
  unanimous?: boolean;
  /** Per-field vote summary (tier-3 majority resolve); omitted for unanimous tiers. */
  votes?: unknown;
}

/** Canonical comparison form for text-valued material fields. */
function canonicalText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Canonical comparison form for FREE-TEXT material fields (assetName,
 * assetType, assetTypeName, subholding, location, description,
 * supplementalText) — used instead of {@link canonicalText} when
 * AGREEMENT_TEXT_NORMALIZATION is enabled (default; see resolveAgreementEnv).
 *
 * Two independent vision reads of the SAME filing routinely transcribe the
 * same disclosed text with different casing or punctuation ("First Data
 * Corp." vs "FIRST DATA CORP" vs "First Data, Corp.") even when both vendors
 * read it correctly. This standardizes casing/punctuation of the SAME
 * abbreviation (via cleanAssetString: "corp"/"CORP"/"Corp" all -> "Corp.")
 * — it does NOT expand or equate distinct spellings ("Corp" and
 * "Corporation" still compare unequal; that would need a synonym dictionary,
 * which is exactly the "new normalizer" this PR was told not to invent).
 * Byte-strict comparison of that free text (canonicalText only
 * trims/uppercases/collapses whitespace) was the single largest cause of the
 * cascade's 0-publish rate in production (324/324 cascade_unresolved over a
 * 6h sample) — every tier required identical text across ~16 fields,
 * including these 7.
 *
 * NOT applied to the 9 strict/enum fields (ticker, amount_min, amount_max,
 * tx_type, tx_date, owner, is_option, cap_gains_over_200, filing_status) —
 * those keep byte/value equality via canonicalText/direct comparison, always,
 * regardless of this flag; loosening them risks conflating two different
 * facts disclosed by the filer.
 *
 * Order matters: cleanAssetString (the EXISTING extraction-side helper,
 * src/extraction/nameNormalizer.ts — already applied to assetName at persist
 * time in normalizer.ts's buildTransaction; no new normalizer invented here)
 * needs intact casing/punctuation to recognize "INC"/"Inc."/"llc" and to
 * strip "(NYSE)"-style exchange suffixes and "/DE/" state-of-incorporation
 * codes; only THEN do we casefold and strip remaining punctuation (including
 * trailing periods/commas). `ticker` is passed only for the assetName field,
 * mirroring cleanAssetString's own ticker-equals-name shortcut.
 */
function canonicalAgreementText(value: string | null | undefined, ticker?: string | null): string {
  const cleaned = cleanAssetString(value ?? '', ticker ?? null);
  return cleaned
    .toLowerCase()
    .replace(/[.,;:'"()[\]{}/\\_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True only for a real calendar date in the model contract's YYYY-MM-DD form.
 * Date.parse alone is deliberately not used because it normalizes impossible
 * dates (for example 2026-02-31) instead of rejecting them.
 */
function isValidTransactionDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const calendarValid = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
  return calendarValid && value <= new Date().toISOString().slice(0, 10);
}

/**
 * Exact material-row fingerprint used by the unanimous tiers. Confidence and
 * rawText are intentionally excluded: they are model/audit metadata, not facts
 * disclosed by the filer. Every other publishable filing-row detail is part of
 * the comparison so agreement cannot hide a different owner, bracket, asset
 * classification, option/capital-gain flag, or structured row detail.
 *
 * The 9 strict/enum fields (ticker, txDate, txType, amountMin, amountMax,
 * owner, isOption, capGainsOver200, filingStatus) ALWAYS go through
 * canonicalText only, regardless of `normalizeText` — no loosening there. The
 * 7 free-text fields (assetName, assetType, assetTypeName, subholding,
 * location, description, supplementalText) go through canonicalAgreementText
 * when `normalizeText` is true (AGREEMENT_TEXT_NORMALIZATION default-on; see
 * resolveAgreementEnv), else canonicalText — the exact legacy byte-strict
 * comparison, restored verbatim by the kill switch.
 */
function materialRowFingerprint(tx: ParsedTx, normalizeText: boolean): string | null {
  if (!isValidTransactionDate(tx.txDate)) return null;
  const text = (value: string | null | undefined, ticker: string | null = null): string =>
    normalizeText ? canonicalAgreementText(value, ticker) : canonicalText(value);
  return JSON.stringify([
    canonicalText(tx.ticker),
    text(tx.assetName, tx.ticker),
    tx.txDate,
    canonicalText(tx.txType),
    tx.amountMin,
    tx.amountMax,
    canonicalText(tx.owner),
    text(tx.assetType),
    text(tx.assetTypeName),
    tx.isOption === true,
    tx.capGainsOver200 === true,
    canonicalText(tx.filingStatus),
    text(tx.subholding),
    text(tx.location),
    text(tx.description),
    text(tx.supplementalText),
  ]);
}

/**
 * True when two successful reads carry the identical material-row MULTISET.
 * Sorting fingerprints makes row order irrelevant while retaining duplicate
 * multiplicity (two identical disclosed lots never compare equal to one).
 *
 * `normalizeText` (default true) gates whether the 7 free-text fields compare
 * through canonicalAgreementText (material agreement) or canonicalText (byte
 * agreement, the pre-fix behavior) — see materialRowFingerprint. Defaulting to
 * true here matters for the one caller outside this module that invokes
 * sameRowSet directly (admin/routes.ts's benchmark-lineup cascade simulator),
 * which has no live AGREEMENT_TEXT_NORMALIZATION env to resolve; every call
 * site WITHIN this file resolves the live flag and passes it explicitly.
 */
export function sameRowSet(
  a: CandidateDocResult,
  b: CandidateDocResult,
  normalizeText = true,
): boolean {
  if (!a.ok || !b.ok || a.rows.length === 0) return false;
  if (a.rows.length !== b.rows.length) return false;
  const ka = a.rows.map((tx) => materialRowFingerprint(tx, normalizeText));
  const kb = b.rows.map((tx) => materialRowFingerprint(tx, normalizeText));
  if (ka.some((k) => k === null) || kb.some((k) => k === null)) return false;
  const sortedA = (ka as string[]).sort();
  const sortedB = (kb as string[]).sort();
  return sortedA.every((key, index) => key === sortedB[index]);
}

/**
 * Resolve the PUBLISHED row content across 2–3 reads already confirmed to
 * materially agree (sameRowSet true pairwise). Byte-strict mode
 * (`normalizeText` false) is EXACTLY today's shortcut — the first read's own
 * rows verbatim, since byte-strict agreement means the rows really are
 * identical already; the kill switch touches nothing here.
 *
 * Once near-miss text can agree (`normalizeText` true), two agreeing rows can
 * still carry different raw text ("First Data Corp." vs "FIRST DATA
 * CORPORATION"), so this groups each read's rows by materialRowFingerprint —
 * preserving duplicate-lot occurrence order, the same idea consensus.ts uses
 * for repeated ticker/date/type keys — and, for each matched occurrence,
 * publishes the WHOLE row from whichever model had the higher per-row
 * confidence, ties broken by slot order (a before b before c). Confidence is
 * a per-row scalar, so preferring it is naturally a whole-row choice: it never
 * mixes assetName from one model with description from another, keeping a
 * published row internally coherent.
 */
function resolveAgreedRows(reads: CandidateDocResult[], normalizeText: boolean): ParsedTx[] {
  if (!normalizeText) return reads[0]?.rows ?? [];
  const grouped = reads.map((r) => {
    const byFingerprint = new Map<string, ParsedTx[]>();
    for (const tx of r.rows) {
      const fp = materialRowFingerprint(tx, true) ?? '';
      const bucket = byFingerprint.get(fp);
      if (bucket) bucket.push(tx);
      else byFingerprint.set(fp, [tx]);
    }
    return byFingerprint;
  });
  const allFingerprints = new Set<string>();
  for (const byFingerprint of grouped) for (const fp of byFingerprint.keys()) allFingerprints.add(fp);

  const resolved: ParsedTx[] = [];
  for (const fp of [...allFingerprints].sort()) {
    const maxOccurrences = Math.max(...grouped.map((m) => m.get(fp)?.length ?? 0));
    for (let occurrence = 0; occurrence < maxOccurrences; occurrence += 1) {
      const candidates: Array<{ tx: ParsedTx; order: number }> = [];
      grouped.forEach((byFingerprint, order) => {
        const tx = byFingerprint.get(fp)?.[occurrence];
        if (tx) candidates.push({ tx, order });
      });
      if (candidates.length === 0) continue;
      const winner = [...candidates].sort(
        (x, y) => (y.tx.confidence ?? 0) - (x.tx.confidence ?? 0) || x.order - y.order,
      )[0];
      resolved.push(winner.tx);
    }
  }
  return resolved;
}

/**
 * Reject a lineup that would let one provider corroborate itself.
 *
 * Provider distinctness is measured over the UNDERLYING vendor
 * (getUnderlyingProvider), NOT the literal `provider` field. Every
 * OpenRouter-transported model shares provider==='openrouter', so comparing the
 * raw field wrongly rejects any trio with 2+ OpenRouter models as
 * `duplicate_provider_lineup` and fails the cascade closed — which is why
 * all-OpenRouter trios never publish. getUnderlyingProvider maps e.g.
 * openrouter:google/gemini-3.5-flash → gemini, openrouter:x-ai/grok-4.3 → xai,
 * openrouter:openai/gpt-5.6-terra → openai, and passes direct providers (and
 * llamaparse) through unchanged. The model-label distinctness check
 * (duplicate_model_lineup) is unaffected. Canonical copy of getUnderlyingProvider
 * lives in benchmark/settings.ts, where validateBenchmarkLineup enforces the
 * identical rule for the admin-configured trio.
 */
export function duplicateLineupReason(models: BakeoffCandidate[]): string | null {
  const ids = models.map((m) => label(m).trim().toLowerCase());
  if (new Set(ids).size !== ids.length) return 'duplicate_model_lineup';
  const providers = models.map((m) => getUnderlyingProvider(m).trim().toLowerCase());
  return new Set(providers).size === providers.length ? null : 'duplicate_provider_lineup';
}

/**
 * Load the raw doc bytes for a review filing, or a skip result explaining why we
 * can't read it. Shared by the tier executors.
 */
export async function loadDocBytes(
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
// Exported for admin/routes.ts benchmark dry-run
export async function loadFilingRow(env: Env, docId: string): Promise<FilingRow | null> {
  return get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, filer_id, filing_type, filed_date, source_url, raw_object_key,
            ingest_status, doc_kind, extractor, model_version, confidence, first_seen_at,
            source_updated_at, error FROM filings WHERE doc_id = ?`,
    [docId],
  );
}

interface AgreementReviewState {
  resolved: number;
  agreement_attempts: number | null;
  agreement_tier: number | null;
  agreement_next_attempt_at: string | null;
  agreement_claim_token: string | null;
  agreement_claimed_at: string | null;
  agreement_suppressed_at: string | null;
  agreement_suppression_reason: string | null;
  review_revision: number;
}

export const AGREEMENT_CLAIM_LEASE_MS = 15 * 60 * 1000;

async function loadReviewState(env: Env, docId: string): Promise<AgreementReviewState | null> {
  return get<AgreementReviewState>(
    env.DB,
    `SELECT resolved, agreement_attempts, agreement_tier, agreement_next_attempt_at,
            agreement_claim_token, agreement_claimed_at, agreement_suppressed_at,
            agreement_suppression_reason, review_revision
       FROM review_queue WHERE doc_id = ?`,
    [docId],
  );
}

/** Fail-closed unresolved/lease ownership check immediately before model spend. */
async function ownsUnresolvedReview(env: Env, docId: string, claimToken: string): Promise<boolean> {
  try {
    const row = await loadReviewState(env, docId);
    return row?.resolved === 0
      && row.agreement_suppressed_at == null
      && row.agreement_claim_token === claimToken;
  } catch (err) {
    console.warn('agreement review-state check failed:', docId, (err as Error).message);
    return false;
  }
}

/**
 * Acquire a short publish lease by CAS. Autonomous calls must still own their
 * consumer claim; operator-triggered calls may acquire only an unclaimed or
 * expired row. The returned token is used by every write in the atomic publish
 * batch, preventing a completed human action from being overwritten.
 */
async function acquirePublishLease(
  env: Env,
  docId: string,
  expectedClaimToken?: string,
  expectedReviewRevision?: number,
): Promise<string | null> {
  const publishToken = uuid();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiredBefore = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  const result = expectedClaimToken
    ? await run(
        env.DB,
        `UPDATE review_queue
            SET agreement_claim_token = ?, agreement_claimed_at = ?
          WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
            AND agreement_claim_token = ?`,
        [publishToken, nowIso, docId, expectedClaimToken],
      )
    : await run(
        env.DB,
        `UPDATE review_queue
            SET agreement_claim_token = ?, agreement_claimed_at = ?
          WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
            AND review_revision = ?
            AND (agreement_claim_token IS NULL OR agreement_claimed_at IS NULL OR agreement_claimed_at <= ?)`,
        [publishToken, nowIso, docId, expectedReviewRevision ?? -1, expiredBefore],
      );
  return (result.meta?.changes ?? 0) > 0 ? publishToken : null;
}

const CONDITIONAL_BULK_INSERT_TX_SQL = `INSERT OR IGNORE INTO transactions (
  id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
  tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
  raw_text, asset_type_name, filing_status, subholding, location, description,
  supplemental_text, row_key, confidence, source, created_at, cursor_seq,
  first_seen_at, filed_date, est_value
) SELECT
  json_extract(value, '$.id'), json_extract(value, '$.docId'),
  json_extract(value, '$.filerId'), json_extract(value, '$.txDate'),
  json_extract(value, '$.owner'), json_extract(value, '$.assetName'),
  json_extract(value, '$.ticker'), json_extract(value, '$.assetType'),
  json_extract(value, '$.txType'), json_extract(value, '$.amountMin'),
  json_extract(value, '$.amountMax'), json_extract(value, '$.isOption'),
  json_extract(value, '$.capGainsOver200'), json_extract(value, '$.rawText'),
  json_extract(value, '$.assetTypeName'), json_extract(value, '$.filingStatus'),
  json_extract(value, '$.subholding'), json_extract(value, '$.location'),
  json_extract(value, '$.description'), json_extract(value, '$.supplementalText'),
  json_extract(value, '$.rowKey'), json_extract(value, '$.confidence'),
  json_extract(value, '$.source'), json_extract(value, '$.createdAt'), NULL,
  json_extract(value, '$.firstSeenAt'), json_extract(value, '$.filedDate'),
  json_extract(value, '$.estValue')
  FROM json_each(?)
   WHERE EXISTS (
      SELECT 1 FROM review_queue
       WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
         AND agreement_claim_token = ?
    )`;

/**
 * Persist all rows and resolve the review item in one D1 batch. Every statement
 * is guarded by the same unresolved+claim predicate, so a human resolution that
 * lands before this batch causes zero transaction inserts and a zero-change CAS.
 */
async function persistClaimedPublish(
  env: Env,
  docId: string,
  claimToken: string,
  transactions: Transaction[],
  audit: CascadeAudit,
): Promise<{ published: boolean; insertedIds: string[] }> {
  const nowIso = new Date().toISOString();
  const rowKeysJson = JSON.stringify(transactions.map((tx) => tx.rowKey ?? ''));
  const insertRowsJson = JSON.stringify(transactions.map((tx) => ({
    id: tx.id,
    docId: tx.docId,
    filerId: tx.filerId,
    txDate: tx.txDate,
    owner: tx.owner,
    assetName: tx.assetName,
    ticker: tx.ticker,
    assetType: tx.assetType,
    txType: tx.txType,
    amountMin: tx.amountMin,
    amountMax: tx.amountMax,
    isOption: fromBool(tx.isOption),
    capGainsOver200: fromBool(tx.capGainsOver200),
    rawText: tx.rawText,
    assetTypeName: tx.assetTypeName ?? null,
    filingStatus: tx.filingStatus ?? null,
    subholding: tx.subholding ?? null,
    location: tx.location ?? null,
    description: tx.description ?? null,
    supplementalText: tx.supplementalText ?? null,
    rowKey: tx.rowKey ?? null,
    confidence: tx.confidence,
    source: tx.source,
    createdAt: tx.createdAt,
    firstSeenAt: tx.firstSeenAt ?? null,
    filedDate: tx.filedDate ?? null,
    estValue: estimateTransactionValue(tx.amountMin, tx.amountMax),
  })));
  const exactLiveSetPredicate = `(SELECT COUNT(*) FROM transactions
      WHERE doc_id = ? AND source IN ('primary', 'manual')
        AND deprecated_at IS NULL) = ?
    AND (SELECT COUNT(*) FROM transactions
      WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL
        AND row_key IN (SELECT value FROM json_each(?))) = ?`;
  const statements: Array<[string, any[]]> = [[
    CONDITIONAL_BULK_INSERT_TX_SQL,
    [insertRowsJson, docId, claimToken],
  ]];
  // D1 batch rolls back only on a statement error, not on a later UPDATE with
  // meta.changes=0. Deliberately attempt the already-existing review_queue PK
  // when the post-insert live set is not exact; the constraint error rolls the
  // whole batch back so no undelivered partial transaction set can leak out.
  statements.push([
    `INSERT INTO review_queue (doc_id)
      SELECT ?
       WHERE EXISTS (
         SELECT 1 FROM review_queue
          WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
            AND agreement_claim_token = ?
       )
         AND NOT (${exactLiveSetPredicate})`,
    [
      docId, docId, claimToken,
      docId, transactions.length,
      docId, rowKeysJson, transactions.length,
    ],
  ]);
  statements.push([
    `INSERT OR IGNORE INTO delivery_outbox
       (tx_id, status, attempts, available_at, last_error, created_at, updated_at)
      SELECT id, 'pending', 0, ?, NULL, ?, ? FROM transactions
       WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL
         AND row_key IN (SELECT value FROM json_each(?))
         AND EXISTS (
           SELECT 1 FROM review_queue
            WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
              AND agreement_claim_token = ?
         )`,
    [nowIso, nowIso, nowIso, docId, rowKeysJson, docId, claimToken],
  ]);
  statements.push([
    `INSERT INTO ingestion_decisions
       (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM review_queue
         WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
           AND agreement_claim_token = ?
      ) AND ${exactLiveSetPredicate}
     ON CONFLICT(id) DO NOTHING`,
    [
      `decision:agreement_published:${docId}`,
      docId,
      'agreement_published',
      'agreement',
      null,
      'model_agreement',
      JSON.stringify({
        resolvedBy: 'agreement-cascade',
        tier: audit.tier,
        unanimous: audit.unanimous ?? undefined,
        rowCount: transactions.length,
        models: audit.models,
        votes: audit.votes ?? undefined,
      }),
      JSON.stringify(transactions.map((tx) => tx.id)),
      nowIso,
      docId,
      claimToken,
      docId,
      transactions.length,
      docId,
      rowKeysJson,
      transactions.length,
    ],
  ]);
  statements.push([
    `UPDATE filings SET ingest_status = 'persisted', error = NULL
      WHERE doc_id = ? AND EXISTS (
        SELECT 1 FROM review_queue
         WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
           AND agreement_claim_token = ?
      ) AND ${exactLiveSetPredicate}`,
    [
      docId, docId, claimToken,
      docId, transactions.length,
      docId, rowKeysJson, transactions.length,
    ],
  ]);
  statements.push([
    `UPDATE review_queue
        SET resolved = 1,
            agreement_next_attempt_at = NULL,
            agreement_claim_token = NULL,
            agreement_claimed_at = NULL,
            review_revision = review_revision + 1
      WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
        AND agreement_claim_token = ? AND ${exactLiveSetPredicate}`,
    [
      docId, claimToken,
      docId, transactions.length,
      docId, rowKeysJson, transactions.length,
    ],
  ]);

  const results = await batch(env.DB, statements);
  const resolvedResult = results[results.length - 1];
  if ((resolvedResult?.meta?.changes ?? 0) === 0) return { published: false, insertedIds: [] };

  const insertedCount = results[0]?.meta?.changes ?? 0;
  let insertedIds = insertedCount === transactions.length ? transactions.map((tx) => tx.id) : [];
  try {
    const liveRows = await all<{ id: string }>(
      env.DB,
      `SELECT id FROM transactions
        WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL
          AND row_key IN (SELECT value FROM json_each(?))`,
      [docId, rowKeysJson],
    );
    if (liveRows.length > 0) insertedIds = liveRows.map((row) => row.id);
  } catch (err) {
    console.error('agreement publish: live transaction lookup failed', docId, (err as Error).message);
  }
  return { published: true, insertedIds };
}

/** Run each model over the doc and persist every reading to extraction_runs. */
async function readAndPersist(
  env: Env,
  models: BakeoffCandidate[],
  docId: string,
  bytes: ArrayBuffer,
  runBatchId: string,
  invocations?: CandidateInvocation[],
): Promise<CandidateDocResult[]> {
  const reads: CandidateDocResult[] = [];
  for (const [index, m] of models.entries()) {
    const r = await runCandidateOnDoc(env, m, docId, bytes, invocations?.[index]);
    if (!r.cached) {
      await persistExtractionRun(env, r, 'agreement', runBatchId);
      // Feed the per-provider:model rolling health window (billing/auth
      // breaker) from cascade reads too. Best-effort by construction.
      await recordProviderHealth(env, m, r.ok, r.error);
    }
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
  const filedDate = frow.filed_date?.slice(0, 10) ?? null;
  if (parsed.some((tx) => !isValidTransactionDate(tx.txDate) || (filedDate !== null && tx.txDate! > filedDate))) {
    return {
      docId,
      outcome: 'agree_but_hardfail',
      tier: audit.tier,
      rowCount: parsed.length,
      flags: ['invalid_transaction_date'],
    };
  }
  const flagged = await recomputeTransactions(env, mapFiling(frow), parsed);
  if (flagged.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING) {
    return {
      docId,
      outcome: 'agree_but_hardfail',
      tier: audit.tier,
      rowCount: flagged.length,
      flags: ['row_limit_exceeded'],
    };
  }
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
  const publishToken = await acquirePublishLease(env, docId, audit.claimToken, audit.reviewRevision);
  if (!publishToken) {
    return { docId, outcome: 'skipped', tier: audit.tier, reason: 'review_resolved_or_claim_lost' };
  }
  const persisted = await persistClaimedPublish(env, docId, publishToken, txs, audit);
  if (!persisted.published) {
    return { docId, outcome: 'skipped', tier: audit.tier, reason: 'review_resolved_or_claim_lost' };
  }
  const insertedIds = persisted.insertedIds;
  await flushDeliveryOutbox(env, {
    txIds: insertedIds,
    limit: Math.max(insertedIds.length, 1),
  }).catch((err) => {
    // The committed generic outbox rows remain pending for the reconciler.
    console.error('agreement publish: delivery outbox flush failed', docId, (err as Error).message);
  });
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
  options: { invocations?: CandidateInvocation[] } = {},
): Promise<AgreementDocResult> {
  const loaded = await loadDocBytes(env, docId, rawObjectKey);
  if ('skip' in loaded) return loaded.skip;

  // Live-toggleable text-field agreement normalization (default on). Resolved
  // here (not just threaded from handleAgreementCheck) so the operator
  // /agreement-reprocess endpoint and the admin benchmark dry-run route — both
  // of which call this function directly — pick up the current value too.
  const normalizeText = (await resolveAgreementEnv(env)).AGREEMENT_TEXT_NORMALIZATION !== 'false';

  // Group this doc's candidate reads under one batch id so they're
  // recognizable as one agreement pass in the extraction_runs dashboard.
  const runBatchId = uuid();
  const lineup = [models.a, models.b, ...(models.c ? [models.c] : [])];
  const lineupError = duplicateLineupReason(lineup);
  if (lineupError) return { docId, outcome: 'skipped', reason: lineupError };
  let operatorReviewRevision: number | undefined;
  if (!dryRun && !audit?.claimToken) {
    const reviewState = await loadReviewState(env, docId);
    if (!reviewState || reviewState.resolved !== 0 || reviewState.agreement_suppressed_at != null) {
      return { docId, outcome: 'skipped', tier: audit?.tier, reason: 'review_resolved_or_claim_lost' };
    }
    operatorReviewRevision = reviewState.review_revision;
  }
  if (audit?.claimToken && !(await ownsUnresolvedReview(env, docId, audit.claimToken))) {
    return { docId, outcome: 'skipped', tier: audit.tier, reason: 'review_resolved_or_claim_lost' };
  }
  const reads = await readAndPersist(
    env,
    lineup,
    docId,
    loaded.bytes,
    runBatchId,
    options.invocations,
  );
  const [rA, rB, rC] = [reads[0], reads[1], reads[2] ?? null];

  if (!rA.ok || !rB.ok || (rC !== null && !rC.ok)) {
    return { docId, outcome: 'skipped', tier: audit?.tier, reason: 'model_read_failed' };
  }

  const agree = sameRowSet(rA, rB, normalizeText)
    && (!rC || (sameRowSet(rA, rC, normalizeText) && sameRowSet(rB, rC, normalizeText)));
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

  const agreedReads = rC ? [rA, rB, rC] : [rA, rB];
  return finalizePublish(env, frow, docId, resolveAgreedRows(agreedReads, normalizeText), dryRun, {
    tier: audit?.tier ?? (models.c ? 2 : 1),
    models: modelLabels(models),
    claimToken: audit?.claimToken,
    reviewRevision: operatorReviewRevision,
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

interface MajorityBuild {
  ok: boolean;
  rows: ParsedTx[];
  reason?: string;
}

/**
 * Build a fail-closed tier-3 majority. Unlike the reviewer-facing consensus
 * grid, publishing may not ignore minority-only rows or fall back to one
 * high-confidence model for a material field. Every union row must be backed by
 * at least two of the three models, and every publishable field must itself
 * receive at least two votes. A duplicate arbitration key is ambiguous to align
 * across models, so tier 3 rejects it instead of collapsing a disclosed lot.
 *
 * Fields vote through the SAME comparator as materialRowFingerprint (shared
 * per constraint: one comparator for both the unanimous tiers and this
 * majority resolve): the 4 strict/enum fields still handled here (ticker,
 * txType, owner, filingStatus — the rest of the 9 strict fields are voted as
 * txDate/amount/isOption/capGainsOver200 special cases below) stay on
 * canonicalText; the 7 free-text fields vote through canonicalAgreementText
 * when `normalizeText` is true. When the winning bloc's members carry
 * byte-different-but-normalize-equal text, the published value is the
 * CONTRIBUTING row with the higher per-row confidence, ties broken by slot
 * order (a before b before c) — never an arbitrary "first seen" pick.
 */
function buildMajorityRows(
  reads: CandidateDocResult[],
  totalModels: number,
  normalizeText: boolean,
): MajorityBuild {
  type MaterialField =
    | 'ticker'
    | 'assetName'
    | 'txDate'
    | 'txType'
    | 'amount'
    | 'owner'
    | 'assetType'
    | 'assetTypeName'
    | 'isOption'
    | 'capGainsOver200'
    | 'filingStatus'
    | 'subholding'
    | 'location'
    | 'description'
    | 'supplementalText';
  const fields: MaterialField[] = [
    'ticker', 'assetName', 'txDate', 'txType', 'amount', 'owner', 'assetType',
    'assetTypeName', 'isOption', 'capGainsOver200', 'filingStatus', 'subholding',
    'location', 'description', 'supplementalText',
  ];
  // The 4 remaining strict/enum fields voted through this generic path (the
  // other 5 strict fields — txDate, amountMin/amountMax, isOption,
  // capGainsOver200 — are special-cased below); these ALWAYS stay on
  // canonicalText regardless of `normalizeText`, matching materialRowFingerprint.
  const STRICT_TEXT_FIELDS = new Set<MaterialField>(['ticker', 'txType', 'owner', 'filingStatus']);
  const valueFor = (tx: ParsedTx, field: MaterialField): unknown => {
    if (field === 'amount') return { amountMin: tx.amountMin, amountMax: tx.amountMax };
    return tx[field];
  };
  const voteKey = (tx: ParsedTx, field: MaterialField): string => {
    if (field === 'amount') return JSON.stringify([tx.amountMin, tx.amountMax]);
    if (field === 'isOption' || field === 'capGainsOver200') return tx[field] === true ? '1' : '0';
    if (field === 'txDate') return tx.txDate ?? '';
    const raw = valueFor(tx, field) as string | null | undefined;
    if (normalizeText && !STRICT_TEXT_FIELDS.has(field)) {
      return canonicalAgreementText(raw, field === 'assetName' ? tx.ticker : null);
    }
    return canonicalText(raw);
  };
  const groups = reads.map((read) => {
    const grouped = new Map<string, ParsedTx[]>();
    for (const tx of read.rows) {
      if (!isValidTransactionDate(tx.txDate)) {
        return { grouped, error: `invalid_transaction_date:${arbitrationRowKey(tx)}` };
      }
      const key = arbitrationRowKey(tx);
      const rows = grouped.get(key) ?? [];
      rows.push(tx);
      grouped.set(key, rows);
    }
    for (const [key, rows] of grouped) {
      if (rows.length > 1) return { grouped, error: `ambiguous_multi_lot:${key}` };
    }
    return { grouped, error: null };
  });
  const groupError = groups.find((group) => group.error)?.error;
  if (groupError) return { ok: false, rows: [], reason: groupError };

  const allKeys = new Set<string>();
  for (const { grouped } of groups) for (const key of grouped.keys()) allKeys.add(key);
  if (allKeys.size === 0) return { ok: false, rows: [], reason: 'no_majority_rows' };

  const built: ParsedTx[] = [];
  for (const rowKey of [...allKeys].sort()) {
    const present = groups
      .map(({ grouped }) => grouped.get(rowKey)?.[0] ?? null)
      .filter((tx): tx is ParsedTx => tx !== null);
    if (present.length * 2 <= totalModels) {
      return { ok: false, rows: [], reason: `minority_extra_row:${rowKey}` };
    }
    const base = [...present].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    const winners = new Map<MaterialField, unknown>();
    for (const field of fields) {
      const blocs = new Map<string, { count: number; entries: Array<{ tx: ParsedTx; order: number }> }>();
      present.forEach((tx, order) => {
        const key = voteKey(tx, field);
        const bloc = blocs.get(key);
        if (bloc) { bloc.count += 1; bloc.entries.push({ tx, order }); }
        else blocs.set(key, { count: 1, entries: [{ tx, order }] });
      });
      const winnerBloc = [...blocs.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))[0]?.[1];
      if (!winnerBloc || winnerBloc.count * 2 <= totalModels) {
        return { ok: false, rows: [], reason: `field_disagreement:${rowKey}:${field}` };
      }
      // Within the winning bloc, publish the CONTRIBUTING row's own reading
      // with the highest confidence — ties broken by slot order (a<b<c) —
      // rather than whichever model happened to be first in `present`. Only
      // matters when normalizeText let byte-different raw text into the same
      // bloc; with a single contributor (or identical raw text) this is a
      // no-op.
      const winnerEntry = [...winnerBloc.entries].sort(
        (x, y) => (y.tx.confidence ?? 0) - (x.tx.confidence ?? 0) || x.order - y.order,
      )[0];
      winners.set(field, valueFor(winnerEntry.tx, field));
    }
    const amount = winners.get('amount') as AmountBracket;
    built.push({
      ...base,
      ticker: winners.get('ticker') as ParsedTx['ticker'],
      assetName: winners.get('assetName') as ParsedTx['assetName'],
      txDate: winners.get('txDate') as ParsedTx['txDate'],
      txType: winners.get('txType') as ParsedTx['txType'],
      amountMin: amount.amountMin,
      amountMax: amount.amountMax,
      owner: winners.get('owner') as ParsedTx['owner'],
      assetType: winners.get('assetType') as ParsedTx['assetType'],
      assetTypeName: winners.get('assetTypeName') as ParsedTx['assetTypeName'],
      isOption: winners.get('isOption') as boolean,
      capGainsOver200: winners.get('capGainsOver200') as boolean,
      filingStatus: winners.get('filingStatus') as ParsedTx['filingStatus'],
      subholding: winners.get('subholding') as ParsedTx['subholding'],
      location: winners.get('location') as ParsedTx['location'],
      description: winners.get('description') as ParsedTx['description'],
      supplementalText: winners.get('supplementalText') as ParsedTx['supplementalText'],
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
  claimToken?: string,
): Promise<AgreementDocResult> {
  // Preserve any existing payload (e.g. transactions queued for human review) by
  // reading it first, then merging cascade metadata fields on top, so the human
  // reviewer does not lose the extracted rows that need attention.
  let existingPayload: Record<string, unknown> = {};
  let existingRevision: number | null = null;
  try {
    const row = await get<{ payload: string | null; review_revision: number }>(
      env.DB,
      'SELECT payload, review_revision FROM review_queue WHERE doc_id = ?',
      [docId],
    );
    existingRevision = row?.review_revision ?? null;
    if (row?.payload) {
      existingPayload = JSON.parse(row.payload) as Record<string, unknown>;
    }
  } catch (err) {
    console.warn('leaveInReviewHighPriority failed to read existing payload:', docId, (err as Error).message);
  }
  if (existingRevision === null) {
    return { docId, outcome: 'skipped', tier, reason: 'review_resolved_or_claim_lost' };
  }
  const payload = {
    ...existingPayload,
    resolvedBy: 'agreement-cascade',
    priority: 'high',
    tier,
    models,
    votes,
    detail: reason,
  };
  let updated = false;
  try {
    const result = claimToken
      ? await run(
          env.DB,
          `UPDATE review_queue
              SET reason = ?, payload = ?, review_revision = review_revision + 1
            WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
              AND agreement_claim_token = ? AND review_revision = ?`,
          ['agreement_cascade_unresolved', JSON.stringify(payload), docId, claimToken, existingRevision],
        )
      : await run(
          env.DB,
          `UPDATE review_queue
              SET reason = ?, payload = ?, review_revision = review_revision + 1
            WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
              AND review_revision = ?`,
          ['agreement_cascade_unresolved', JSON.stringify(payload), docId, existingRevision],
        );
    updated = (result.meta?.changes ?? 0) > 0;
  } catch (err) {
    console.warn('leaveInReviewHighPriority update failed:', docId, (err as Error).message);
  }
  if (!updated) {
    return { docId, outcome: 'skipped', tier, reason: 'review_resolved_or_claim_lost' };
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
  claimToken?: string,
): Promise<AgreementDocResult> {
  const loaded = await loadDocBytes(env, docId, rawObjectKey);
  if ('skip' in loaded) return loaded.skip;

  // Live-toggleable text-field agreement normalization (default on) — see the
  // matching comment in processAgreementDoc.
  const normalizeText = (await resolveAgreementEnv(env)).AGREEMENT_TEXT_NORMALIZATION !== 'false';

  const lineup = [models.a, models.b, models.c];
  const lineupError = duplicateLineupReason(lineup);
  if (lineupError) return { docId, outcome: 'skipped', reason: lineupError };
  let operatorReviewRevision: number | undefined;
  if (!dryRun && !claimToken) {
    const reviewState = await loadReviewState(env, docId);
    if (!reviewState || reviewState.resolved !== 0 || reviewState.agreement_suppressed_at != null) {
      return { docId, outcome: 'skipped', tier: 2, reason: 'review_resolved_or_claim_lost' };
    }
    operatorReviewRevision = reviewState.review_revision;
  }
  if (claimToken && !(await ownsUnresolvedReview(env, docId, claimToken))) {
    return { docId, outcome: 'skipped', tier: 2, reason: 'review_resolved_or_claim_lost' };
  }
  const runBatchId = uuid();
  const reads = await readAndPersist(env, lineup, docId, loaded.bytes, runBatchId);

  // Align rows before consensus checks to prevent spurious field_disagreement
  // on raw string variants of the same ticker/asset.
  const resolver = await loadResolver(env);
  for (const read of reads) {
    if (read.ok) {
      for (const tx of read.rows) {
        const cleaned = cleanAssetString(tx.assetName, tx.ticker);
        const resolved = resolver(tx.ticker, cleaned);
        if (resolved) {
          tx.ticker = resolved;
        }
        if (cleaned) {
          tx.assetName = cleaned;
        }
      }
    }
  }

  const [rA, rB, rC] = reads;

  const frow = await loadFilingRow(env, docId);
  if (!frow) return { docId, outcome: 'skipped', reason: 'filing row missing' };

  const labels = modelLabels(models);

  // 3-way unanimity → publish exactly as the original agreement path (tier 2).
  const unanimous = rA.ok && rB.ok && rC.ok
    && sameRowSet(rA, rB, normalizeText) && sameRowSet(rA, rC, normalizeText) && sameRowSet(rB, rC, normalizeText);
  if (unanimous) {
    return finalizePublish(env, frow, docId, resolveAgreedRows([rA, rB, rC], normalizeText), dryRun, {
      tier: 2, models: labels, unanimous: true, claimToken, reviewRevision: operatorReviewRevision,
    });
  }

  // A provider failure is operational, not semantic disagreement. Return a
  // retryable skip so the autonomous handler applies bounded backoff/cap logic;
  // never count an error as "saw nothing" in a false 2/3 publish quorum.
  if (!rA.ok || !rB.ok || !rC.ok) {
    return { docId, outcome: 'skipped', tier: 3, reason: 'model_read_failed' };
  }

  // Tier 3 — majority resolve over the three reads (no extra model calls).
  const consensus = buildConsensusRows([
    { model: labels.a, rows: rA.rows },
    { model: labels.b, rows: rB.rows },
    { model: labels.c, rows: rC.rows },
  ]);
  const majority = buildMajorityRows(reads, 3, normalizeText);
  const votes = voteSummary(consensus, 3);
  if (!majority.ok) {
    if (dryRun) return { docId, outcome: 'review_flagged', tier: 3, reason: majority.reason };
    return leaveInReviewHighPriority(env, docId, 3, labels, votes, majority.reason ?? 'no_majority', claimToken);
  }

  const res = await finalizePublish(env, frow, docId, majority.rows, dryRun, {
    tier: 3,
    models: labels,
    claimToken,
    reviewRevision: operatorReviewRevision,
    unanimous: false,
    votes,
  });
  // A hard-fail on the majority row set is NOT publishable — flag high-priority.
  if (res.outcome === 'agree_but_hardfail') {
    if (dryRun) return res;
    return leaveInReviewHighPriority(
      env, docId, 3, labels, votes, `hard_fail:${(res.flags ?? []).join(',')}`, claimToken,
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// Autonomous pass (cron backstop + queue consumer)
// ---------------------------------------------------------------------------

/** Parse an explicit "provider:model" selection. */
export function parseCandidate(s: string | undefined): BakeoffCandidate | null {
  if (!s) return null;
  const [provider, ...rest] = s.split(':');
  const model = rest.join(':');
  const valid = ['gemini', 'openai', 'anthropic', 'mistral', 'xai', 'llamaparse', 'openrouter'];
  return valid.includes(provider) && model
    ? upgradeRetiredDisclosureCandidate({ provider, model } as BakeoffCandidate)
    : null;
}

export interface AgreementEnv {
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  AGREEMENT_AUTOPUBLISH_LIMIT?: string;
  AGREEMENT_SENATE_MODEL_C?: string;
  AGREEMENT_SENATE_MODEL_D?: string;
  AGREEMENT_SENATE_MODEL_E?: string;
  AGREEMENT_HOUSE_MODEL_C?: string;
  AGREEMENT_HOUSE_MODEL_D?: string;
  AGREEMENT_HOUSE_MODEL_E?: string;
  AGREEMENT_EXEC_MODEL_C?: string;
  AGREEMENT_EXEC_MODEL_D?: string;
  AGREEMENT_EXEC_MODEL_E?: string;
  AGREEMENT_MAX_ATTEMPTS?: string;
  AGREEMENT_BIG_DOC_START_TIER2?: string;
  AGREEMENT_BIG_DOC_PAGE_THRESHOLD?: string;
  AGREEMENT_BIG_DOC_BYTES_THRESHOLD?: string;
  AGREEMENT_DAILY_LLM_BUDGET?: string;
  /** Kill switch for the free-text agreement comparator (default on; 'false' restores byte-strict). */
  AGREEMENT_TEXT_NORMALIZATION?: string;
}

/**
 * Resolve agreement controls and the explicit per-chamber C/D/E trio. The A/B
 * primary/failover slots are a SEPARATE live-ingestion concern (see
 * resolvePrimaryFailoverModels in ./configuredVision) and are deliberately not
 * requested here.
 */
export async function resolveAgreementEnv(env: Env): Promise<AgreementEnv> {
  return (await resolveSecrets(env, [
    'AGREEMENT_AUTOPUBLISH_ENABLED',
    'AGREEMENT_AUTOPUBLISH_LIMIT',
    'AGREEMENT_SENATE_MODEL_C',
    'AGREEMENT_SENATE_MODEL_D',
    'AGREEMENT_SENATE_MODEL_E',
    'AGREEMENT_HOUSE_MODEL_C',
    'AGREEMENT_HOUSE_MODEL_D',
    'AGREEMENT_HOUSE_MODEL_E',
    'AGREEMENT_EXEC_MODEL_C',
    'AGREEMENT_EXEC_MODEL_D',
    'AGREEMENT_EXEC_MODEL_E',
    'AGREEMENT_MAX_ATTEMPTS',
    'AGREEMENT_BIG_DOC_START_TIER2',
    'AGREEMENT_BIG_DOC_PAGE_THRESHOLD',
    'AGREEMENT_BIG_DOC_BYTES_THRESHOLD',
    'AGREEMENT_DAILY_LLM_BUDGET',
    'AGREEMENT_TEXT_NORMALIZATION',
  ])) as AgreementEnv;
}

/** Resolve the explicit C/D chamber lineup (tier-1 pair); missing config fails closed. */
function resolveModels(e: AgreementEnv, chamber: string): AgreementModels | null {
  const modelA = chamber === 'senate'
    ? e.AGREEMENT_SENATE_MODEL_C
    : chamber === 'executive' ? e.AGREEMENT_EXEC_MODEL_C : e.AGREEMENT_HOUSE_MODEL_C;
  const modelB = chamber === 'senate'
    ? e.AGREEMENT_SENATE_MODEL_D
    : chamber === 'executive' ? e.AGREEMENT_EXEC_MODEL_D : e.AGREEMENT_HOUSE_MODEL_D;
  const a = parseCandidate(modelA);
  const b = parseCandidate(modelB);
  return a && b ? { a, b } : null;
}

/** Resolve the explicit C/D/E lineup for a tier-2+ pass; missing config fails
 *  closed. Exported for the backlog autopilot's per-doc cost estimation. */
export function resolveModelsWithC(e: AgreementEnv, chamber: string): AgreementModelsC | null {
  const ab = resolveModels(e, chamber);
  const modelC = chamber === 'senate'
    ? e.AGREEMENT_SENATE_MODEL_E
    : chamber === 'executive' ? e.AGREEMENT_EXEC_MODEL_E : e.AGREEMENT_HOUSE_MODEL_E;
  const c = parseCandidate(modelC);
  return ab && c ? { ...ab, c } : null;
}

/** Max cascade attempts before a doc stays in human review (clamped 1–5).
 *  Exported for the backlog autopilot's eligibility selector. */
export function maxAttempts(e: AgreementEnv): number {
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

/** Best-effort refund when a post-reservation ownership check prevents all reads. */
async function refundLlmBudget(env: Env, budget: number, count: number): Promise<void> {
  if (budget === LLM_BUDGET_UNLIMITED) return;
  try {
    await run(
      env.DB,
      'UPDATE llm_budget SET reads = MAX(reads - ?, 0) WHERE day = ?',
      [count, llmBudgetDay()],
    );
  } catch (err) {
    console.warn('agreement LLM budget refund failed:', (err as Error).message);
  }
}

function nextUtcMidnight(now = new Date()): string {
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
  )).toISOString();
}

/**
 * Record a diagnostics receipt when the daily LLM budget is exhausted, using
 * the same recordIngestionDecision "receipt" pattern as leaveInReviewHighPriority
 * above. Unlike that helper, this does NOT touch review_queue — the doc is
 * left exactly as it was (not flagged high-priority; budget exhaustion is an
 * operational throttle, not a model disagreement) and gets a fresh shot once
 * the day's budget resets.
 */
async function deferForBudgetExhausted(
  env: Env,
  docId: string,
  tier: number,
  budget: number,
  claimToken: string,
): Promise<void> {
  if (!(await ownsUnresolvedReview(env, docId, claimToken))) {
    await releaseAgreementClaim(env, docId, claimToken);
    return;
  }
  await recordIngestionDecision(env.DB, {
    docId,
    action: 'review_opened',
    source: 'agreement',
    reason: 'llm_budget_exhausted',
    payload: { resolvedBy: 'agreement-cascade', tier, budget, detail: 'budget_exhausted' },
  });
  await rollbackUnspentAttempt(env, docId, claimToken, nextUtcMidnight());
}

/**
 * Decide the starting tier for a fresh (tier-1) pass. Cheap complexity signals
 * (filings.page_count / filings.raw_bytes, populated best-effort by the
 * orchestrator) push a big doc straight to tier 2 for a third opinion, and a
 * doc classified 'hard_scan' (docClassifier.ts) gets the full trio from the
 * start — its handwriting/skew is exactly what drives tier-1 disagreement.
 * Gated by AGREEMENT_BIG_DOC_START_TIER2 (default on). Never throws
 * (pre-migration safe: doc_class is read separately from the 0033 columns).
 */
async function resolveStartTier(env: Env, e: AgreementEnv, docId: string): Promise<number> {
  if (e.AGREEMENT_BIG_DOC_START_TIER2 === 'false') return 1;
  const pageMax = parseInt(e.AGREEMENT_BIG_DOC_PAGE_THRESHOLD || '10', 10) || 10;
  const bytesMax = parseInt(e.AGREEMENT_BIG_DOC_BYTES_THRESHOLD || '2097152', 10) || 2097152;
  try {
    const docClassRow = await get<{ doc_class: string | null }>(
      env.DB,
      'SELECT doc_class FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (docClassRow?.doc_class === 'hard_scan') return 2;
  } catch {
    // doc_class column not migrated yet — fall through to the size signals.
  }
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

function leaseExpiredBefore(now: Date): string {
  return new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
}

/** Acquire/renew the queue lease before enqueueing or consuming a legacy message. */
async function acquireAgreementLease(
  env: Env,
  docId: string,
  max: number,
  existingClaimToken?: string,
): Promise<string | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const token = existingClaimToken ?? uuid();
  try {
    const result = existingClaimToken
      ? await run(
          env.DB,
          `UPDATE review_queue
              SET agreement_claimed_at = ?, agreement_next_attempt_at = NULL
            WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
              AND agreement_claim_token = ?
              AND COALESCE(agreement_attempts, 0) < ?
              AND NOT EXISTS (
                SELECT 1 FROM transactions t
                 WHERE t.doc_id = review_queue.doc_id
                   AND t.source IN ('primary', 'manual') AND t.deprecated_at IS NULL
              )`,
          [nowIso, docId, existingClaimToken, max],
        )
      : await run(
          env.DB,
          `UPDATE review_queue
              SET agreement_claim_token = ?, agreement_claimed_at = ?, agreement_next_attempt_at = NULL
            WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
              AND COALESCE(agreement_attempts, 0) < ?
              AND NOT EXISTS (
                SELECT 1 FROM transactions t
                 WHERE t.doc_id = review_queue.doc_id
                   AND t.source IN ('primary', 'manual') AND t.deprecated_at IS NULL
              )
              AND (agreement_next_attempt_at IS NULL OR agreement_next_attempt_at <= ?)
              AND (
                agreement_claim_token IS NULL OR agreement_claimed_at IS NULL OR agreement_claimed_at <= ?
              )`,
          [token, nowIso, docId, max, nowIso, leaseExpiredBefore(now)],
        );
    return (result.meta?.changes ?? 0) > 0 ? token : null;
  } catch (err) {
    console.warn('agreement lease acquire failed:', docId, (err as Error).message);
    return null;
  }
}

/**
 * Consume a queue-message token exactly once while atomically incrementing the
 * attempt counter under its cap. Rotating the token makes concurrent delivery
 * of the same message lose the CAS; escalation sends the resulting owner token
 * onward and the next tier rotates it again.
 */
async function claimAgreementAttempt(
  env: Env,
  docId: string,
  expectedClaimToken: string,
  tier: number,
  max: number,
): Promise<{ token: string; attempts: number } | null> {
  const token = uuid();
  const nowIso = new Date().toISOString();
  // Read before mutation, then CAS the exact observed attempt count. This
  // avoids the old update-then-read gap where a successful token rotation plus
  // failed follow-up read made the old queue message ACK as a no-op forever.
  const state = await loadReviewState(env, docId);
  const attempts = state?.agreement_attempts ?? 0;
  if (
    !state || state.resolved !== 0 || state.agreement_suppressed_at != null
    || state.agreement_claim_token !== expectedClaimToken || attempts >= max
    || (state.agreement_next_attempt_at !== null && state.agreement_next_attempt_at > nowIso)
  ) return null;
  const result = await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_attempts = ?,
            agreement_tier = ?,
            agreement_attempted_at = ?,
            agreement_claim_token = ?,
            agreement_claimed_at = ?,
            agreement_next_attempt_at = NULL
      WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
        AND agreement_claim_token = ?
        AND COALESCE(agreement_attempts, 0) = ?
        AND COALESCE(agreement_attempts, 0) < ?
        AND (agreement_next_attempt_at IS NULL OR agreement_next_attempt_at <= ?)`,
    [attempts + 1, tier, nowIso, token, nowIso, docId, expectedClaimToken, attempts, max, nowIso],
  );
  return (result.meta?.changes ?? 0) > 0 ? { token, attempts: attempts + 1 } : null;
}

async function releaseAgreementClaim(env: Env, docId: string, claimToken: string): Promise<void> {
  await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_claim_token = NULL, agreement_claimed_at = NULL
      WHERE doc_id = ? AND agreement_claim_token = ?`,
    [docId, claimToken],
  );
}

async function rollbackUnspentAttempt(
  env: Env,
  docId: string,
  claimToken: string,
  nextAttemptAt: string | null,
): Promise<void> {
  await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_attempts = MAX(COALESCE(agreement_attempts, 0) - 1, 0),
            agreement_next_attempt_at = ?,
            agreement_claim_token = NULL,
            agreement_claimed_at = NULL
      WHERE doc_id = ? AND agreement_claim_token = ?`,
    [nextAttemptAt, docId, claimToken],
  );
}

function retryAt(attempts: number, now = new Date()): string {
  const delay = Math.min(5 * 60 * 1000 * (2 ** Math.max(attempts - 1, 0)), 6 * 60 * 60 * 1000);
  return new Date(now.getTime() + delay).toISOString();
}

async function releaseForRetry(env: Env, docId: string, claimToken: string, attempts: number): Promise<void> {
  await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_next_attempt_at = ?, agreement_claim_token = NULL, agreement_claimed_at = NULL
      WHERE doc_id = ? AND agreement_claim_token = ?`,
    [retryAt(attempts), docId, claimToken],
  );
}

async function finishTerminalClaim(
  env: Env,
  docId: string,
  claimToken: string,
  max: number,
): Promise<void> {
  await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_attempts = MAX(COALESCE(agreement_attempts, 0), ?),
            agreement_next_attempt_at = NULL,
            agreement_claim_token = NULL,
            agreement_claimed_at = NULL
      WHERE doc_id = ? AND agreement_claim_token = ?`,
    [max, docId, claimToken],
  );
}

/**
 * Enqueue an `agreement.check` only after acquiring its durable lease. A fresh
 * enqueue mints a token with a guarded due/cap/expiry UPDATE; escalation renews
 * and reuses the current consumer token. Send failure releases only that token.
 */
export async function enqueueAgreementCheck(
  env: Env,
  docId: string,
  rawObjectKey: string | null,
  escalationTier = 1,
  existingClaimToken?: string,
): Promise<boolean> {
  const e = await resolveAgreementEnv(env);
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return false;
  const token = await acquireAgreementLease(env, docId, maxAttempts(e), existingClaimToken);
  if (!token) return false;

  try {
    await env.INGEST_QUEUE.send({ type: 'agreement.check', docId, rawObjectKey, escalationTier, claimToken: token });
    return true;
  } catch (err) {
    console.warn('enqueueAgreementCheck send failed:', docId, (err as Error).message);
    const state = await loadReviewState(env, docId).catch(() => null);
    await releaseForRetry(env, docId, token, Math.max(state?.agreement_attempts ?? 0, 1));
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
 *
 * Returns the per-doc outcome (or null when no check ran: disabled flag, lost
 * lease, or duplicate delivery). The queue consumer ignores the return value;
 * the backlog autopilot uses it for its run receipt and halt logic.
 */
export async function handleAgreementCheck(
  env: Env,
  docId: string,
  rawObjectKey: string | null,
  escalationTier?: number,
  claimToken?: string,
): Promise<AgreementDocResult | null> {
  const e = await resolveAgreementEnv(env);
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return null;
  const max = maxAttempts(e);

  // A fresh check (tier unset) may start at tier 2 for a complex doc.
  let tier = escalationTier ?? 1;
  if (tier === 1) tier = await resolveStartTier(env, e, docId);

  // Backward-compatible tokenless messages acquire a fresh lease. Modern queue
  // messages carry the enqueue lease, which the attempt CAS consumes below.
  const queuedToken = claimToken ?? await acquireAgreementLease(env, docId, max);
  if (!queuedToken) return null;

  const chamberRow = await get<{ chamber: string }>(env.DB, 'SELECT chamber FROM filings WHERE doc_id = ?', [docId]);
  const chamber = chamberRow?.chamber || 'house';

  const models = tier >= 2 ? resolveModelsWithC(e, chamber) : resolveModels(e, chamber);
  if (!models) {
    const flagged = await leaveInReviewHighPriority(
      env, docId, tier, {}, null, 'missing_chamber_model_config', queuedToken,
    );
    await finishTerminalClaim(env, docId, queuedToken, max);
    return flagged;
  }
  const lineupError = duplicateLineupReason(
    tier >= 2
      ? [(models as AgreementModelsC).a, (models as AgreementModelsC).b, (models as AgreementModelsC).c]
      : [(models as AgreementModels).a, (models as AgreementModels).b],
  );
  if (lineupError) {
    const flagged = await leaveInReviewHighPriority(
      env, docId, tier, modelLabels(models), null, lineupError, queuedToken,
    );
    await finishTerminalClaim(env, docId, queuedToken, max);
    return flagged;
  }

  const claimed = await claimAgreementAttempt(env, docId, queuedToken, tier, max);
  if (!claimed) return null; // duplicate/redelivered message, cap, resolved row, or lost lease

  try {
    const budget = dailyLlmBudget(e);
    const readsNeeded = tier >= 2 ? 3 : 2;
    if (!(await reserveLlmBudget(env, budget, readsNeeded))) {
      await deferForBudgetExhausted(env, docId, tier, budget, claimed.token);
      console.log(`agreement.check ${docId} tier${tier}: LLM budget exhausted (cap ${budget}/day) → deferred, no attempt spent`);
      return { docId, outcome: 'skipped', tier, reason: 'llm_budget_exhausted' };
    }

    // A human may resolve the row after enqueue/claim but before the model calls.
    // Recheck ownership after budget reservation and refund without spending.
    if (!(await ownsUnresolvedReview(env, docId, claimed.token))) {
      await refundLlmBudget(env, budget, readsNeeded);
      await rollbackUnspentAttempt(env, docId, claimed.token, null);
      return { docId, outcome: 'skipped', tier, reason: 'review_resolved_or_claim_lost' };
    }

    if (tier >= 2) {
      const res = await processAgreementCascadeTier2(
        env, models as AgreementModelsC, docId, rawObjectKey, false, claimed.token,
      );
      if (res.outcome === 'review_flagged') {
        await finishTerminalClaim(env, docId, claimed.token, max);
      } else if (res.outcome === 'skipped') {
        if (res.reason === 'review_resolved_or_claim_lost') {
          await releaseAgreementClaim(env, docId, claimed.token);
        } else if (claimed.attempts >= max) {
          await leaveInReviewHighPriority(
            env, docId, tier, modelLabels(models), null, 'attempt_cap_reached', claimed.token,
          );
          await finishTerminalClaim(env, docId, claimed.token, max);
        } else {
          await releaseForRetry(env, docId, claimed.token, claimed.attempts);
        }
      }
      console.log(`agreement.check ${docId} tier${tier}: ${res.outcome}${res.inserted ? ` (+${res.inserted} tx)` : ''}`);
      return res;
    }

    const tier1Models = models as AgreementModels;
    const res = await processAgreementDoc(
      env, tier1Models, docId, rawObjectKey, false, { tier: 1, claimToken: claimed.token },
    );
    if (res.outcome === 'disagree') {
      if (claimed.attempts < max) {
        const escalated = await enqueueAgreementCheck(env, docId, rawObjectKey, 2, claimed.token);
        console.log(`agreement.check ${docId} tier1: disagree → ${escalated ? 'escalated to tier2' : 'escalation enqueue failed'}`);
        return { ...res, reason: escalated ? 'escalated_tier2' : 'escalation_enqueue_failed' };
      }
      // Attempt cap reached — leave in human review, flagged high-priority.
      await leaveInReviewHighPriority(
        env, docId, 1, modelLabels(tier1Models), res.rows ?? null, 'attempt_cap_reached', claimed.token,
      );
      await finishTerminalClaim(env, docId, claimed.token, max);
      console.log(`agreement.check ${docId} tier1: disagree, attempt cap (${max}) reached → human review`);
      return { ...res, reason: 'attempt_cap_reached' };
    }
    if (res.outcome === 'agree_but_hardfail') {
      await leaveInReviewHighPriority(
        env, docId, 1, modelLabels(tier1Models), null,
        `hard_fail:${(res.flags ?? []).join(',')}`, claimed.token,
      );
      await finishTerminalClaim(env, docId, claimed.token, max);
    } else if (res.outcome === 'skipped') {
      if (res.reason === 'review_resolved_or_claim_lost') {
        await releaseAgreementClaim(env, docId, claimed.token);
      } else if (claimed.attempts >= max) {
        await leaveInReviewHighPriority(
          env, docId, 1, modelLabels(tier1Models), null, 'attempt_cap_reached', claimed.token,
        );
        await finishTerminalClaim(env, docId, claimed.token, max);
      } else {
        await releaseForRetry(env, docId, claimed.token, claimed.attempts);
      }
    }
    console.log(`agreement.check ${docId} tier1: ${res.outcome}${res.inserted ? ` (+${res.inserted} tx)` : ''}`);
    return res;
  } catch (err) {
    console.error(`agreement.check ${docId} tier${tier} failed after claim:`, (err as Error).message);
    if (claimed.attempts >= max) {
      await leaveInReviewHighPriority(
        env, docId, tier, modelLabels(models), null, 'handler_error_attempt_cap', claimed.token,
      ).catch(() => {});
      await finishTerminalClaim(env, docId, claimed.token, max);
    } else {
      await releaseForRetry(env, docId, claimed.token, claimed.attempts);
    }
    // Preserve the queue-level Sentry issue/dead-letter signal. The old message
    // token will no-op on redelivery; the cron later acquires the due row with a
    // fresh token after backoff.
    throw err;
  }
}

/**
 * Repair a capped row whose previous consumer died before it could write the
 * terminal human-review flag. A fresh CAS lease makes this safe under
 * concurrent cron ticks; failures retain the lease and are retried after its
 * 15-minute expiry instead of silently stranding the row at the attempt cap.
 */
async function recoverExpiredCappedReviews(
  env: Env,
  max: number,
  limit: number,
): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiredBefore = leaseExpiredBefore(now);
  const rows = await all<{ doc_id: string; agreement_tier: number | null }>(
    env.DB,
    `SELECT doc_id, agreement_tier FROM review_queue
      WHERE resolved = 0 AND agreement_suppressed_at IS NULL
        AND COALESCE(agreement_attempts, 0) >= ?
        AND COALESCE(reason, '') <> 'agreement_cascade_unresolved'
        AND (
          agreement_claim_token IS NULL OR agreement_claimed_at IS NULL
          OR agreement_claimed_at <= ?
        )
      ORDER BY created_at ASC LIMIT ?`,
    [max, expiredBefore, limit],
  );
  let terminalized = 0;
  for (const row of rows) {
    const token = uuid();
    try {
      const leased = await run(
        env.DB,
        `UPDATE review_queue
            SET agreement_claim_token = ?, agreement_claimed_at = ?
          WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
            AND COALESCE(agreement_attempts, 0) >= ?
            AND COALESCE(reason, '') <> 'agreement_cascade_unresolved'
            AND (
              agreement_claim_token IS NULL OR agreement_claimed_at IS NULL
              OR agreement_claimed_at <= ?
            )`,
        [token, nowIso, row.doc_id, max, expiredBefore],
      );
      if ((leased.meta?.changes ?? 0) === 0) continue;
      const flagged = await leaveInReviewHighPriority(
        env,
        row.doc_id,
        row.agreement_tier ?? 1,
        {},
        null,
        'attempt_cap_recovery',
        token,
      );
      if (flagged.outcome === 'review_flagged') {
        await finishTerminalClaim(env, row.doc_id, token, max);
        terminalized += 1;
      } else {
        await releaseAgreementClaim(env, row.doc_id, token);
      }
    } catch (err) {
      console.error('agreement capped-row recovery failed:', row.doc_id, (err as Error).message);
    }
  }
  return terminalized;
}

/**
 * Autonomous per-minute backstop: pick up to `limit` unresolved, due, under-cap
 * review docs whose lease is free/expired and enqueue a fresh tier-1 check. The
 * enqueue helper repeats the same predicates in its guarded lease UPDATE, so
 * concurrent schedulers cannot both send the same document.
 */
export async function maybeRunAgreementAutopublish(
  env: Env,
): Promise<{ attempted: number; enqueued: number; terminalized: number } | null> {
  const e = await resolveAgreementEnv(env);
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return null;
  const limit = Math.min(Math.max(parseInt(e.AGREEMENT_AUTOPUBLISH_LIMIT || '3', 10) || 3, 1), 10);
  const max = maxAttempts(e);
  const now = new Date();
  const nowIso = now.toISOString();
  const terminalized = await recoverExpiredCappedReviews(env, max, limit);

  let docs: Array<{ doc_id: string; raw_object_key: string | null }>;
  try {
    docs = await all<{ doc_id: string; raw_object_key: string | null }>(
      env.DB,
      `SELECT f.doc_id, f.raw_object_key
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0
          AND rq.agreement_suppressed_at IS NULL
          AND COALESCE(rq.agreement_attempts, 0) < ?
          AND (rq.agreement_next_attempt_at IS NULL OR rq.agreement_next_attempt_at <= ?)
          AND (
            rq.agreement_claim_token IS NULL OR rq.agreement_claimed_at IS NULL OR rq.agreement_claimed_at <= ?
          )
          AND f.raw_object_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.doc_id = rq.doc_id AND t.source IN ('primary', 'manual')
               AND t.deprecated_at IS NULL
          )
        ORDER BY rq.created_at ASC LIMIT ?`,
      [max, nowIso, leaseExpiredBefore(now), limit],
    );
  } catch (err) {
    console.error('agreement autopublish selector failed:', (err as Error).message);
    throw err;
  }

  let enqueued = 0;
  for (const d of docs) {
    if (await enqueueAgreementCheck(env, d.doc_id, d.raw_object_key)) enqueued++;
  }
  if (docs.length) console.log(`agreement autopublish: enqueued ${enqueued}/${docs.length} checks`);
  return { attempted: docs.length, enqueued, terminalized };
}
