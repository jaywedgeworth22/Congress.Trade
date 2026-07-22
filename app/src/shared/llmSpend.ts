/**
 * src/shared/llmSpend.ts
 *
 * GOVERNOR 1 — hard daily LLM USD ceiling (owner mandate: "no more spend
 * spikes ever").
 *
 * Every extraction/benchmark/bakeoff provider call flows through ONE choke
 * point — `runCandidateOnDoc` in src/extraction/bakeoff.ts (production live
 * ingestion routes there via ConfiguredVisionExtractor, agreement/batch/
 * benchmark/bakeoff call it directly) — plus the shared `fetchWithRetry`
 * wrapper in visionLlm.ts for the raw HTTP adapters. Both consult this module
 * BEFORE spending money, and `runCandidateOnDoc` records the metered dollars
 * for every attempt (success or failure) immediately AFTER the provider
 * responds, so the meter is durable across isolates via one immutable,
 * response/attempt-keyed settlement per paid call.
 *
 * Pricing: provider-reported cost when the provider returns the actual charge
 * (xAI cost_in_usd_ticks), otherwise the shared benchmark rate card
 * (priceBenchmarkUsage). Unpriceable usage (unknown model) records nothing —
 * the meter never invents numbers.
 *
 * Enforcement semantics (the exact "$20 sonnet storm" vector this closes):
 *   - Exceeding a ceiling FAILS CLOSED with error-class 'budget'
 *     (LlmBudgetExceededError / failure code 'llm_budget_exceeded').
 *   - Budget errors are TERMINAL for the attempt: they are never retried by
 *     fetchWithRetry, and ConfiguredVisionExtractor never fails over to
 *     another (potentially pricier) model on a budget halt.
 *   - The meter read itself FAILS OPEN (a D1 blip must not take extraction
 *     down), but spend is recorded on the same D1, so a sustained meter
 *     outage also stops accruing extraction results.
 *
 * Knobs (Infisical-tunable, env fallback, all optional):
 *   LLM_DAILY_USD_CEILING               global daily ceiling, default $10
 *   LLM_DAILY_USD_CEILING_<PROVIDER>    per-provider sub-ceiling (e.g.
 *                                       LLM_DAILY_USD_CEILING_OPENROUTER);
 *                                       unset = governed by the global only
 */

import type { Env } from './types.ts';
import { resolveSecret } from '../secrets/infisical.ts';

/** Stable marker embedded in every budget-halt error message. Provider-failure
 * classification and the no-failover break key off this exact string, so it
 * must never drift and must never match the transient rate-limit regexes
 * (`429|402|too many requests|quota exceeded|rate[- ]?limit|payment required`). */
export const LLM_BUDGET_ERROR_MARKER = 'llm daily usd budget exceeded';

export interface LlmSpendDecision {
  allowed: boolean;
  /** Which ceiling tripped when not allowed. */
  scope: 'total' | 'provider';
  provider: string;
  spentUsd: number;
  ceilingUsd: number;
}

/** Fail-closed budget halt. `errorClass: 'budget'` is the stable class name. */
export class LlmBudgetExceededError extends Error {
  readonly errorClass = 'budget' as const;
  constructor(readonly decision: LlmSpendDecision) {
    super(llmBudgetHaltMessage(decision));
    this.name = 'LlmBudgetExceededError';
  }
}

/** Stable, secret-safe budget-halt message carrying the classification marker. */
export function llmBudgetHaltMessage(decision: LlmSpendDecision): string {
  return (
    `${LLM_BUDGET_ERROR_MARKER} (${decision.scope}` +
    `${decision.scope === 'provider' ? `:${decision.provider}` : ''}): ` +
    `$${decision.spentUsd.toFixed(4)} of $${decision.ceilingUsd.toFixed(2)} spent today`
  );
}

/** True for any error/message produced by a budget halt (error-class 'budget'). */
export function isLlmBudgetHalt(error: unknown): boolean {
  if (error instanceof LlmBudgetExceededError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.toLowerCase().includes(LLM_BUDGET_ERROR_MARKER);
}

export const DEFAULT_LLM_DAILY_USD_CEILING = 10;

function dayStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function usdVar(value: string | undefined, fallback: number | null): number | null {
  const n = Number.parseFloat((value ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function providerCeilingKey(provider: string): string {
  const tag = provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `LLM_DAILY_USD_CEILING_${tag}`;
}

async function resolveUsdKnob(env: Env, key: string, fallback: number | null): Promise<number | null> {
  try {
    const live = (await resolveSecret(env, key as keyof Env & string)).value
      ?? (env[key as keyof Env] as string | undefined);
    return usdVar(live, fallback);
  } catch {
    return usdVar(env[key as keyof Env] as string | undefined, fallback);
  }
}

export interface LlmSpendTotals {
  day: string;
  totalUsd: number;
  perProvider: Record<string, number>;
}

export const LLM_SPEND_SETTLEMENT_WRITER = Symbol.for(
  'congress.trade.llm-spend-settlement-writer',
);
export const AUTOPILOT_BUDGET_SETTLEMENT_WRITER = Symbol.for(
  'congress.trade.autopilot-budget-settlement-writer',
);

export interface LlmSpendSettlementReceipt {
  settlementId: string;
  provider: string;
  providerResponseId: string | null;
  attemptId: string;
  day: string;
  occurredAt: string;
  requestedModel: string;
  resolvedModel: string | null;
  docId: string | null;
  usd: number;
  receiptHash: string;
  createdAt: string;
}

export interface LlmSpendSettlementWriter {
  write(receipt: LlmSpendSettlementReceipt): Promise<'inserted' | 'duplicate'>;
}

export interface AutopilotBudgetSettlementReceipt {
  settlementId: string;
  day: string;
  reservedMicroUsd: number;
  actualMicroUsd: number;
  status: 'completed' | 'aborted' | 'failed';
  createdAt: string;
}

export interface AutopilotBudgetSettlementWriter {
  write(receipt: AutopilotBudgetSettlementReceipt): Promise<'inserted' | 'duplicate'>;
}

export const LLM_SPEND_SETTLEMENT_ERROR_MARKER = 'llm spend settlement failed';

export class LlmSpendSettlementError extends Error {
  readonly errorClass = 'accounting' as const;
  constructor(message: string, override readonly cause?: unknown) {
    super(`${LLM_SPEND_SETTLEMENT_ERROR_MARKER}: ${message}`);
    this.name = 'LlmSpendSettlementError';
  }
}

export function isLlmSpendSettlementFailure(error: unknown): boolean {
  if (error instanceof LlmSpendSettlementError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.toLowerCase().includes(LLM_SPEND_SETTLEMENT_ERROR_MARKER);
}

class SettlementIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementIntegrityError';
  }
}

function missingSettlementProjection(error: unknown): boolean {
  return /no such table:\s*llm_spend_settlement_totals/i
    .test(error instanceof Error ? error.message : String(error));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface StoredLlmSettlement {
  receipt_hash: string;
}

export function createLlmSpendSettlementWriter(db: D1Database): LlmSpendSettlementWriter {
  return {
    async write(receipt) {
      const inserted = await db.prepare(
        `INSERT OR IGNORE INTO llm_spend_settlements
           (settlement_id, provider, provider_response_id, attempt_id, day,
            occurred_at, requested_model, resolved_model, doc_id, usd,
            receipt_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        receipt.settlementId,
        receipt.provider,
        receipt.providerResponseId,
        receipt.attemptId,
        receipt.day,
        receipt.occurredAt,
        receipt.requestedModel,
        receipt.resolvedModel,
        receipt.docId,
        receipt.usd,
        receipt.receiptHash,
        receipt.createdAt,
      ).run();
      if ((inserted.meta?.changes ?? 0) > 0) return 'inserted';

      const existing = await db.prepare(
        `SELECT receipt_hash FROM llm_spend_settlements
          WHERE settlement_id = ?
             OR (? IS NOT NULL AND provider = ? AND provider_response_id = ?)
          LIMIT 1`,
      ).bind(
        receipt.settlementId,
        receipt.providerResponseId,
        receipt.provider,
        receipt.providerResponseId,
      ).first<StoredLlmSettlement>();
      if (!existing) throw new Error('settlement insert was ignored without an existing receipt');
      if (existing.receipt_hash !== receipt.receiptHash) {
        throw new SettlementIntegrityError('settlement identity replayed with conflicting accounting data');
      }
      return 'duplicate';
    },
  };
}

interface StoredAutopilotSettlement {
  day: string;
  reserved_microusd: number;
  actual_microusd: number;
  status: string;
}

export function createAutopilotBudgetSettlementWriter(
  db: D1Database,
): AutopilotBudgetSettlementWriter {
  return {
    async write(receipt) {
      const settled = await db.prepare(
        `UPDATE autopilot_budget_reservations
            SET actual_microusd = ?, status = ?, settled_at = ?
          WHERE reservation_id = ? AND day = ? AND reserved_microusd = ?
            AND status = 'reserved'`,
      ).bind(
        receipt.actualMicroUsd,
        receipt.status,
        receipt.createdAt,
        receipt.settlementId,
        receipt.day,
        receipt.reservedMicroUsd,
      ).run();
      if ((settled.meta?.changes ?? 0) > 0) return 'inserted';
      const existing = await db.prepare(
        `SELECT day, reserved_microusd, actual_microusd, status
           FROM autopilot_budget_reservations WHERE reservation_id = ?`,
      ).bind(receipt.settlementId).first<StoredAutopilotSettlement>();
      if (!existing) throw new Error('autopilot reservation is missing');
      if (
        existing.day !== receipt.day
        || Number(existing.reserved_microusd) !== receipt.reservedMicroUsd
        || Number(existing.actual_microusd) !== receipt.actualMicroUsd
        || existing.status !== receipt.status
      ) {
        throw new SettlementIntegrityError('budget settlement replayed with conflicting accounting data');
      }
      return 'duplicate';
    },
  };
}

function settlementWriter(env: Env): LlmSpendSettlementWriter | null {
  const capability = (env as unknown as Record<PropertyKey, unknown>)[LLM_SPEND_SETTLEMENT_WRITER];
  if (capability && typeof (capability as LlmSpendSettlementWriter).write === 'function') {
    return capability as LlmSpendSettlementWriter;
  }
  const db = (env as Partial<Env>).DB;
  return db && typeof db.prepare === 'function' ? createLlmSpendSettlementWriter(db) : null;
}

function autopilotSettlementWriter(env: Env): AutopilotBudgetSettlementWriter | null {
  const capability = (env as unknown as Record<PropertyKey, unknown>)[AUTOPILOT_BUDGET_SETTLEMENT_WRITER];
  if (capability && typeof (capability as AutopilotBudgetSettlementWriter).write === 'function') {
    return capability as AutopilotBudgetSettlementWriter;
  }
  const db = (env as Partial<Env>).DB;
  return db && typeof db.prepare === 'function' ? createAutopilotBudgetSettlementWriter(db) : null;
}

/** Read today's metered spend. Returns null when the meter is unreadable
 * (missing DB binding, pre-migration table) so callers can fail open. */
export async function readLlmSpend(env: Env, now = new Date()): Promise<LlmSpendTotals | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const legacy = await db
      .prepare('SELECT provider, usd FROM llm_spend WHERE day = ?')
      .bind(dayStr(now))
      .all<{ provider: string; usd: number }>();
    let settlements: { results?: Array<{ provider: string; usd: number }> } = { results: [] };
    try {
      settlements = await db
        .prepare('SELECT provider, usd FROM llm_spend_settlement_totals WHERE day = ?')
        .bind(dayStr(now))
        .all<{ provider: string; usd: number }>();
    } catch (error) {
      if (!missingSettlementProjection(error)) return null;
      // Rolling-deploy compatibility only: migration 0054 immediately creates
      // the bounded projection. Until then, preserve exact ceiling semantics
      // by reading the immutable ledger; never fall back to additive writes.
      try {
        settlements = await db
          .prepare('SELECT provider, usd FROM llm_spend_settlements WHERE day = ?')
          .bind(dayStr(now))
          .all<{ provider: string; usd: number }>();
      } catch {
        return null;
      }
    }
    const perProvider: Record<string, number> = {};
    let totalUsd = 0;
    for (const row of [...(legacy?.results ?? []), ...(settlements?.results ?? [])]) {
      const usd = Number(row.usd) || 0;
      perProvider[row.provider] = (perProvider[row.provider] ?? 0) + usd;
      totalUsd += usd;
    }
    return { day: dayStr(now), totalUsd, perProvider };
  } catch {
    return null;
  }
}

/**
 * Decide whether one more paid call to `provider` is allowed today. Checks the
 * global ceiling first, then the provider sub-ceiling when configured. Fails
 * OPEN (allowed) when the meter cannot be read — see the module doc comment.
 */
export async function checkLlmSpendCeiling(
  env: Env,
  provider: string,
  now = new Date(),
): Promise<LlmSpendDecision> {
  const allowed: LlmSpendDecision = {
    allowed: true,
    scope: 'total',
    provider,
    spentUsd: 0,
    ceilingUsd: DEFAULT_LLM_DAILY_USD_CEILING,
  };
  const spend = await readLlmSpend(env, now);
  if (!spend) return allowed;
  const totalCeiling = (await resolveUsdKnob(env, 'LLM_DAILY_USD_CEILING', DEFAULT_LLM_DAILY_USD_CEILING))
    ?? DEFAULT_LLM_DAILY_USD_CEILING;
  if (spend.totalUsd >= totalCeiling) {
    return { allowed: false, scope: 'total', provider, spentUsd: spend.totalUsd, ceilingUsd: totalCeiling };
  }
  const providerCeiling = await resolveUsdKnob(env, providerCeilingKey(provider), null);
  const providerSpend = spend.perProvider[provider] ?? 0;
  if (providerCeiling != null && providerSpend >= providerCeiling) {
    return { allowed: false, scope: 'provider', provider, spentUsd: providerSpend, ceilingUsd: providerCeiling };
  }
  return { ...allowed, spentUsd: spend.totalUsd, ceilingUsd: totalCeiling };
}

/** Throw a fail-closed LlmBudgetExceededError when the ceiling is exhausted. */
export async function assertLlmSpendWithinCeiling(
  env: Env,
  provider: string,
  now = new Date(),
): Promise<void> {
  const decision = await checkLlmSpendCeiling(env, provider, now);
  if (!decision.allowed) throw new LlmBudgetExceededError(decision);
}

export interface SettleLlmSpendInput {
  provider: string;
  requestedModel: string;
  resolvedModel?: string | null;
  providerResponseId?: string | null;
  attemptId: string;
  docId?: string | null;
  usd: number;
  occurredAt?: string;
}

/** Persist one immutable paid-response receipt through the lease-independent
 * accounting capability. Failures are terminal and visible: silently losing a
 * charge would let the hard ceiling fail open and could trigger paid failover. */
export async function settleLlmSpend(
  env: Env,
  input: SettleLlmSpendInput,
): Promise<'ignored' | 'inserted' | 'duplicate'> {
  if (!(Number.isFinite(input.usd) && input.usd > 0)) return 'ignored';
  const writer = settlementWriter(env);
  // Unit/local callers that intentionally construct an Env without a DB have
  // no durable side effects to account for. Every production runtime has DB.
  if (!writer) return 'ignored';
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const providerResponseId = input.providerResponseId?.trim() || null;
  const identity = providerResponseId
    ? [input.provider, 'response', providerResponseId]
    : [input.provider, 'attempt', input.attemptId];
  const settlementId = await sha256(JSON.stringify(identity));
  const receiptHash = await sha256(JSON.stringify({
    provider: input.provider,
    providerResponseId,
    // A provider response ID is the canonical identity across worker replay;
    // the local attempt ID matters only for the no-response-ID fallback.
    attemptId: providerResponseId ? null : input.attemptId,
    day: occurredAt.slice(0, 10),
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel ?? null,
    docId: input.docId ?? null,
    usd: input.usd,
  }));
  const receipt: LlmSpendSettlementReceipt = {
    settlementId,
    provider: input.provider,
    providerResponseId,
    attemptId: input.attemptId,
    day: occurredAt.slice(0, 10),
    occurredAt,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel ?? null,
    docId: input.docId ?? null,
    usd: input.usd,
    receiptHash,
    createdAt: new Date().toISOString(),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await writer.write(receipt);
    } catch (error) {
      if (error instanceof SettlementIntegrityError) {
        throw new LlmSpendSettlementError(error.message, error);
      }
      lastError = error;
    }
  }
  throw new LlmSpendSettlementError(
    `could not persist ${input.provider} receipt ${settlementId.slice(0, 12)}`,
    lastError,
  );
}

export async function settleAutopilotBudgetReceipt(
  env: Env,
  receipt: AutopilotBudgetSettlementReceipt,
): Promise<'inserted' | 'duplicate'> {
  const writer = autopilotSettlementWriter(env);
  if (!writer) throw new LlmSpendSettlementError('autopilot accounting writer is unavailable');
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await writer.write(receipt);
    } catch (error) {
      if (error instanceof SettlementIntegrityError) {
        throw new LlmSpendSettlementError(error.message, error);
      }
      lastError = error;
    }
  }
  throw new LlmSpendSettlementError(
    `could not persist autopilot receipt ${receipt.settlementId.slice(0, 24)}`,
    lastError,
  );
}

export interface LlmSpendSnapshot extends LlmSpendTotals {
  ceilingUsd: number;
  perProviderCeilings: Record<string, number>;
  exhausted: boolean;
}

/** Admin-diagnostics snapshot: today's per-provider dollars vs ceilings. */
export async function inspectLlmSpend(env: Env, now = new Date()): Promise<LlmSpendSnapshot | null> {
  const spend = await readLlmSpend(env, now);
  if (!spend) return null;
  const ceilingUsd = (await resolveUsdKnob(env, 'LLM_DAILY_USD_CEILING', DEFAULT_LLM_DAILY_USD_CEILING))
    ?? DEFAULT_LLM_DAILY_USD_CEILING;
  const perProviderCeilings: Record<string, number> = {};
  for (const provider of Object.keys(spend.perProvider)) {
    const providerCeiling = await resolveUsdKnob(env, providerCeilingKey(provider), null);
    if (providerCeiling != null) perProviderCeilings[provider] = providerCeiling;
  }
  return {
    ...spend,
    ceilingUsd,
    perProviderCeilings,
    exhausted: spend.totalUsd >= ceilingUsd,
  };
}
