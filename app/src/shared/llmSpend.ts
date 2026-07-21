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
 * responds, so the meter is durable across isolates via one atomic D1 upsert
 * per call.
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

/** Read today's metered spend. Returns null when the meter is unreadable
 * (missing DB binding, pre-migration table) so callers can fail open. */
export async function readLlmSpend(env: Env, now = new Date()): Promise<LlmSpendTotals | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const res = await db
      .prepare('SELECT provider, usd FROM llm_spend WHERE day = ?')
      .bind(dayStr(now))
      .all<{ provider: string; usd: number }>();
    const perProvider: Record<string, number> = {};
    let totalUsd = 0;
    for (const row of res?.results ?? []) {
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

/**
 * Add one attempt's metered dollars to today's durable counter. One atomic D1
 * upsert per provider call — LLM calls are seconds-long, so the write cost is
 * negligible next to the spend being governed. Fail-soft: a failed meter write
 * must never fail the extraction result it accounts for.
 */
export async function recordLlmSpend(
  env: Env,
  provider: string,
  usd: number,
  now = new Date(),
): Promise<void> {
  if (!(typeof usd === 'number' && Number.isFinite(usd) && usd > 0)) return;
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return;
  try {
    await db
      .prepare(
        `INSERT INTO llm_spend (day, provider, usd, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, provider) DO UPDATE SET
           usd = usd + excluded.usd,
           updated_at = excluded.updated_at`,
      )
      .bind(dayStr(now), provider, usd, now.toISOString())
      .run();
  } catch (err) {
    console.warn('llmSpend: meter write failed', {
      provider,
      errorType: err instanceof Error ? err.name : 'unknown',
    });
  }
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
