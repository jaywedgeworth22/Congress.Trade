/**
 * GOVERNOR 1 unit tests — the daily LLM USD ceiling meter.
 *
 * Pins the fail-closed contract: at/over the global ceiling (default $10) or a
 * per-provider sub-ceiling every further call is denied with error-class
 * 'budget'; below it calls pass; a broken meter fails OPEN (a D1 blip must not
 * take extraction down, and spend cannot accrue without the same D1 anyway).
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../types';
import {
  DEFAULT_LLM_DAILY_USD_CEILING,
  LlmBudgetExceededError,
  assertLlmSpendWithinCeiling,
  checkLlmSpendCeiling,
  isLlmBudgetHalt,
  llmBudgetHaltMessage,
  readLlmSpend,
  recordLlmSpend,
} from '../llmSpend';

interface SpendRow {
  provider: string;
  usd: number;
}

/** In-memory llm_spend table keyed by day, mimicking the atomic upsert. */
function spendEnv(rows: SpendRow[], vars: Record<string, string> = {}): {
  env: Env;
  rows: SpendRow[];
  failures: { reads: boolean; writes: boolean };
} {
  const failures = { reads: false, writes: false };
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async all() {
      if (failures.reads) throw new Error('D1 unavailable');
      if (/FROM llm_spend/i.test(sql)) return { results: rows.map((r) => ({ ...r })) };
      return { results: [] };
    },
    async run() {
      if (failures.writes) throw new Error('D1 unavailable');
      if (/INSERT INTO llm_spend/i.test(sql)) {
        const [, provider, usd] = this.params as [string, string, number, string];
        const existing = rows.find((r) => r.provider === provider);
        if (existing) existing.usd += usd;
        else rows.push({ provider, usd });
      }
      return { success: true, meta: { changes: 1 } };
    },
    async first() {
      return null;
    },
  });
  const env = { DB: { prepare } as unknown as D1Database, ...vars } as unknown as Env;
  return { env, rows, failures };
}

describe('checkLlmSpendCeiling', () => {
  it('allows spend below the default $10 global ceiling', async () => {
    const { env } = spendEnv([{ provider: 'openrouter', usd: 9.99 }]);
    const decision = await checkLlmSpendCeiling(env, 'openrouter');
    expect(decision.allowed).toBe(true);
    expect(decision.ceilingUsd).toBe(DEFAULT_LLM_DAILY_USD_CEILING);
  });

  it('fails closed at the global ceiling — for EVERY provider, so no failover to a pricier model can spend', async () => {
    const { env } = spendEnv([{ provider: 'openrouter', usd: 10 }]);
    const primary = await checkLlmSpendCeiling(env, 'openrouter');
    expect(primary.allowed).toBe(false);
    expect(primary.scope).toBe('total');
    // The would-be failover provider is equally halted: the ceiling is global.
    const failover = await checkLlmSpendCeiling(env, 'anthropic');
    expect(failover.allowed).toBe(false);
    expect(failover.scope).toBe('total');
  });

  it('honors a configured global ceiling override', async () => {
    const { env } = spendEnv(
      [{ provider: 'openrouter', usd: 3 }],
      { LLM_DAILY_USD_CEILING: '2.50' },
    );
    const decision = await checkLlmSpendCeiling(env, 'openrouter');
    expect(decision.allowed).toBe(false);
    expect(decision.ceilingUsd).toBe(2.5);
  });

  it('enforces a per-provider sub-ceiling without blocking other providers', async () => {
    const { env } = spendEnv(
      [{ provider: 'openrouter', usd: 4 }],
      { LLM_DAILY_USD_CEILING_OPENROUTER: '4' },
    );
    const blocked = await checkLlmSpendCeiling(env, 'openrouter');
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('provider');
    expect(blocked.ceilingUsd).toBe(4);
    const other = await checkLlmSpendCeiling(env, 'mistral');
    expect(other.allowed).toBe(true);
  });

  it('fails open when the meter is unreadable', async () => {
    const { env, failures } = spendEnv([{ provider: 'openrouter', usd: 999 }]);
    failures.reads = true;
    const decision = await checkLlmSpendCeiling(env, 'openrouter');
    expect(decision.allowed).toBe(true);
  });
});

describe('assertLlmSpendWithinCeiling + error class', () => {
  it('throws a terminal LlmBudgetExceededError with error-class budget', async () => {
    const { env } = spendEnv([{ provider: 'openrouter', usd: 25 }]);
    let caught: unknown;
    try {
      await assertLlmSpendWithinCeiling(env, 'openrouter');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmBudgetExceededError);
    expect((caught as LlmBudgetExceededError).errorClass).toBe('budget');
    expect(isLlmBudgetHalt(caught)).toBe(true);
  });

  it('budget halt messages never match the transient rate-limit regex (no retry storms)', () => {
    const message = llmBudgetHaltMessage({
      allowed: false,
      scope: 'total',
      provider: 'openrouter',
      spentUsd: 20,
      ceilingUsd: 10,
    });
    // configuredVision.isProviderRateLimit's pattern — a budget halt matching it
    // would be mistaken for a transient 429 and re-queued instead of halted.
    expect(/\b(429|402|too many requests|quota exceeded|rate[- ]?limit|payment required)\b/i.test(message)).toBe(false);
    expect(isLlmBudgetHalt(message)).toBe(true);
    expect(isLlmBudgetHalt('anthropic 429 too many requests')).toBe(false);
  });
});

describe('recordLlmSpend / readLlmSpend', () => {
  it('accumulates per-provider dollars atomically and reads them back', async () => {
    const { env } = spendEnv([]);
    await recordLlmSpend(env, 'openrouter', 0.25);
    await recordLlmSpend(env, 'openrouter', 0.5);
    await recordLlmSpend(env, 'anthropic', 1);
    const spend = await readLlmSpend(env);
    expect(spend?.totalUsd).toBeCloseTo(1.75);
    expect(spend?.perProvider.openrouter).toBeCloseTo(0.75);
    expect(spend?.perProvider.anthropic).toBeCloseTo(1);
  });

  it('ignores non-positive and non-finite amounts and never throws on meter failure', async () => {
    const { env, rows, failures } = spendEnv([]);
    await recordLlmSpend(env, 'openrouter', 0);
    await recordLlmSpend(env, 'openrouter', -1);
    await recordLlmSpend(env, 'openrouter', Number.NaN);
    expect(rows).toHaveLength(0);
    failures.writes = true;
    await expect(recordLlmSpend(env, 'openrouter', 1)).resolves.toBeUndefined();
  });
});
