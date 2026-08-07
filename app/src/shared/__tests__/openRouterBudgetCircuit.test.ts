import { describe, expect, it } from 'vitest';
import type { Env } from '../types.ts';
import {
  DEFAULT_OR_BUDGET_COOLDOWN_SECONDS,
  DEFAULT_OR_BUDGET_TRIP_AFTER,
  assertOpenRouterBudgetCircuitAllowsCall,
  isOpenRouterBudgetHttp,
  isOpenRouterBudgetMessage,
  noteOpenRouterBudgetFailure,
  noteOpenRouterBudgetSuccess,
  readOpenRouterBudgetCircuit,
} from '../openRouterBudgetCircuit.ts';
import { IngestRetryError } from '../../ingestion/fetcher.ts';

function kvEnv(store: Map<string, string> = new Map()): Env {
  return {
    CONFIG_KV: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null };
      },
    },
  } as unknown as Env;
}

describe('openRouterBudgetCircuit', () => {
  it('detects OpenRouter budget messages and 402/403 budget', () => {
    expect(isOpenRouterBudgetMessage('API key budget limit exceeded (weekly limit)')).toBe(true);
    expect(isOpenRouterBudgetHttp(402, '')).toBe(true);
    expect(isOpenRouterBudgetHttp(403, 'API key budget limit exceeded')).toBe(true);
    expect(isOpenRouterBudgetHttp(403, 'forbidden path')).toBe(false);
    expect(isOpenRouterBudgetHttp(401, 'invalid api key')).toBe(false);
  });

  it('allows a short burst then opens for hourly cool-down', async () => {
    const store = new Map<string, string>();
    const env = kvEnv(store);
    const t0 = 1_700_000_000_000;

    for (let i = 1; i < DEFAULT_OR_BUDGET_TRIP_AFTER; i++) {
      const trip = await noteOpenRouterBudgetFailure(env, `fail ${i}`, t0 + i);
      expect(trip.open).toBe(false);
      expect(trip.delaySeconds).toBe(5);
      await expect(assertOpenRouterBudgetCircuitAllowsCall(env, t0 + i)).resolves.toBeUndefined();
    }

    const openTrip = await noteOpenRouterBudgetFailure(
      env,
      'API key budget limit exceeded',
      t0 + DEFAULT_OR_BUDGET_TRIP_AFTER,
    );
    expect(openTrip.open).toBe(true);
    expect(openTrip.delaySeconds).toBe(DEFAULT_OR_BUDGET_COOLDOWN_SECONDS);

    await expect(
      assertOpenRouterBudgetCircuitAllowsCall(env, t0 + DEFAULT_OR_BUDGET_TRIP_AFTER + 1),
    ).rejects.toBeInstanceOf(IngestRetryError);

    const mid = await readOpenRouterBudgetCircuit(env, t0 + DEFAULT_OR_BUDGET_TRIP_AFTER + 1);
    expect(mid.openUntilMs).toBeGreaterThan(t0);

    // After cool-down, calls are allowed again.
    const after = t0 + DEFAULT_OR_BUDGET_COOLDOWN_SECONDS * 1000 + 5_000;
    await expect(assertOpenRouterBudgetCircuitAllowsCall(env, after)).resolves.toBeUndefined();
  });

  it('clears the streak on success', async () => {
    const store = new Map<string, string>();
    const env = kvEnv(store);
    const t0 = 1_700_000_000_000;
    await noteOpenRouterBudgetFailure(env, 'budget', t0);
    await noteOpenRouterBudgetSuccess(env, t0 + 1);
    const state = await readOpenRouterBudgetCircuit(env, t0 + 2);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.openUntilMs).toBeNull();
  });
});
