import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import {
  acquireBenchmarkSettingsLease,
  assertBenchmarkSettingsLease,
  BenchmarkCallReservationError,
  BenchmarkSettingsLeaseBusyError,
  BenchmarkSettingsLeaseLostError,
  benchmarkReadIsAutonomous,
  benchmarkUsageHasProviderReportedCost,
  buildAdminRouter,
  persistBenchmarkSelectionAudit,
  releaseBenchmarkSettingsLease,
  reserveBenchmarkCalls,
} from '../routes';

const AUTH = {
  authorization: 'Bearer admin-secret',
  'content-type': 'application/json',
};

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    ADMIN_TOKEN: 'admin-secret',
    AGREEMENT_AUTOPUBLISH_MODEL_A: 'mistral:mistral-ocr-latest',
    AGREEMENT_AUTOPUBLISH_MODEL_B: 'openai:gpt-4o',
    AGREEMENT_MODEL_C: 'anthropic:claude-haiku-4-5',
    OPENAI_API_KEY: 'openai-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
    MISTRAL_API_KEY: 'mistral-key',
    DB: {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          async first<T>() {
            if (/SELECT raw_object_key FROM filings WHERE doc_id/i.test(sql)) {
              return { raw_object_key: 'raw/H-1' } as T;
            }
            return null as T | null;
          },
          async all<T>() {
            if (/FROM filings f[\s\S]*LEFT JOIN review_queue/i.test(sql)) {
              return { results: [{ doc_id: 'H-1', resolved: 1 }] as T[] };
            }
            if (/FROM transactions/i.test(sql)) {
              return { results: [{
                ticker: 'AAPL',
                asset_name: 'Apple Inc.',
                tx_date: '2026-07-01',
                tx_type: 'P',
                amount_min: 1_001,
                amount_max: 15_000,
                owner: 'self',
                asset_type: 'ST',
                is_option: 0,
                cap_gains_over_200: 0,
              }] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
    ...overrides,
  } as unknown as Env;
}

interface ReservationStatement {
  sql: string;
  params: unknown[];
  bind(...params: unknown[]): ReservationStatement;
}

function atomicReservationDb(
  delegate: D1Database,
  initialReservedCalls = 0,
  options: { fail?: boolean } = {},
): { db: D1Database; reservedCalls: () => number } {
  let reservedCalls = initialReservedCalls;
  const db = {
    prepare(sql: string) {
      if (!sql.includes('benchmark_daily_call_usage')) return delegate.prepare(sql);
      const statement: ReservationStatement = {
        sql,
        params: [],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const reservation = statements as unknown as ReservationStatement[];
      if (!reservation[0]?.sql?.includes('benchmark_daily_call_usage')) {
        return delegate.batch(statements);
      }
      if (options.fail) throw new Error('D1 reservation unavailable');
      const plannedCalls = Number(reservation[1]?.params[0]);
      const dailyCap = Number(reservation[1]?.params[4]);
      const accepted = Number.isSafeInteger(plannedCalls)
        && plannedCalls > 0
        && reservedCalls + plannedCalls <= dailyCap;
      if (accepted) reservedCalls += plannedCalls;
      return [
        { success: true, meta: { changes: initialReservedCalls > 0 ? 0 : 1 } },
        { success: true, meta: { changes: accepted ? 1 : 0 } },
        { success: true, meta: { changes: 0 }, results: [{ reserved_calls: reservedCalls }] },
      ] as unknown as D1Result[];
    },
  } as unknown as D1Database;
  return { db, reservedCalls: () => reservedCalls };
}

function settingsLeaseDb(): D1Database {
  let lease: {
    chamber: string;
    ownerToken: string;
    leaseUntil: string;
    createdAt: string;
    updatedAt: string;
  } | null = null;
  return {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async run() {
          if (/INSERT INTO benchmark_settings_leases/i.test(sql)) {
            const [chamber, ownerToken, leaseUntil, createdAt, updatedAt] = statement.params as string[];
            const accepted = lease === null || lease.leaseUntil <= createdAt;
            if (accepted) lease = { chamber, ownerToken, leaseUntil, createdAt, updatedAt };
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          if (/DELETE FROM benchmark_settings_leases/i.test(sql)) {
            const [chamber, ownerToken] = statement.params as string[];
            const accepted = lease?.chamber === chamber && lease.ownerToken === ownerToken;
            if (accepted) lease = null;
            return { success: true, meta: { changes: accepted ? 1 : 0 } } as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as D1Result;
        },
        async first<T>() {
          if (/SELECT[\s\S]*lease_until[\s\S]*FROM benchmark_settings_leases/i.test(sql) && lease) {
            return {
              owner_token: lease.ownerToken,
              lease_until: lease.leaseUntil,
            } as T;
          }
          return null as T | null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function claimableBenchmarkDb(requestProfile: Record<string, unknown>): D1Database {
  const run = {
    id: 'run-1', chamber: 'house', status: 'running',
    requested_doc_count: 1, completed_doc_count: 0, model_count: 1,
    models_json: JSON.stringify([BENCHMARK_MODELS[0]]),
    request_profile_json: JSON.stringify(requestProfile),
    started_at: '2026-07-13T12:00:00.000Z',
    completed_at: null, duration_ms: null, known_cost_usd: null,
    cost_covered_calls: 0, invoked_calls: 0, summary_json: null,
    selected_lineup_json: null, selected_at: null, selection_error: null,
    selection_audit_json: null, error: null,
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:00:00.000Z',
  };
  const document = {
    run_id: 'run-1', doc_id: 'H-1', ordinal: 0, resolved: 0, ground_truth_json: null,
  };
  let claim: { outcome: string; claim_token: string; lease_until: string } | null = null;
  return {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first<T>() {
          if (/SELECT raw_object_key FROM filings WHERE doc_id/i.test(sql)) {
            return { raw_object_key: null } as T;
          }
          if (/SELECT outcome, claim_token, lease_until/i.test(sql)) return claim as T | null;
          return (/FROM benchmark_runs/i.test(sql) ? run : null) as T | null;
        },
        async all<T>() {
          if (/FROM benchmark_run_documents/i.test(sql)) return { results: [document] as T[] };
          if (/FROM benchmark_model_results/i.test(sql)) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT INTO benchmark_model_results/i.test(sql)) {
            claim = {
              outcome: 'running',
              claim_token: String(statement.params[5]),
              lease_until: String(statement.params[6]),
            };
            return { success: true, meta: { changes: 1 } } as D1Result;
          }
          if (/UPDATE benchmark_model_results SET/i.test(sql) && claim) {
            claim = null;
            return { success: true, meta: { changes: 1 } } as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as D1Result;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

const BENCHMARK_MODELS = [
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'gemini', model: 'gemini-3.5-flash' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
];

function benchmarkMeasurement(
  provider: string,
  model: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    run_id: 'run-1', doc_id: 'H-1', provider, model, resolved_model: model,
    invoked: 1, ok: 1, outcome: 'would_publish', autonomous: 1, error: null,
    row_count: 1, avg_confidence: 0.99, latency_ms: 100, cost_usd: 0.001,
    cost_source: 'usage_priced', cost_detail_json: '{}', provider_request_id: null,
    usage_json: '{}', result_json: JSON.stringify({ rows: [], flags: [] }),
    perfect_match: 1, true_positive: 1, false_positive: 0, false_negative: 0,
    started_at: null, completed_at: null, created_at: '2026-07-13T12:00:01.000Z',
    ...overrides,
  };
}

function persistedBenchmarkDb(
  results: Array<Record<string, unknown>>,
  groundTruth: unknown[] = [],
  status: 'running' | 'completed' = 'completed',
): D1Database {
  const run = {
    id: 'run-1', chamber: 'house', status,
    requested_doc_count: 1, completed_doc_count: 1, model_count: 3,
    models_json: JSON.stringify(BENCHMARK_MODELS),
    started_at: '2026-07-13T12:00:00.000Z',
    completed_at: '2026-07-13T12:01:00.000Z', duration_ms: 60_000,
    known_cost_usd: null, cost_covered_calls: 0, invoked_calls: 0,
    summary_json: null, selected_lineup_json: null, selected_at: null,
    selection_error: null, selection_audit_json: null, error: null,
    created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:01:00.000Z',
  };
  const document = {
    run_id: 'run-1', doc_id: 'H-1', ordinal: 0, resolved: 1,
    ground_truth_json: JSON.stringify(groundTruth),
  };
  return {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        async first<T>() {
          if (/SELECT outcome, claim_token, lease_until/i.test(sql)) {
            const result = results[0];
            return result ? {
              outcome: result.outcome,
              claim_token: result.claim_token ?? 'other-worker',
              lease_until: result.lease_until ?? '2099-01-01T00:00:00.000Z',
            } as T : null;
          }
          return (/FROM benchmark_runs/i.test(sql) ? run : null) as T | null;
        },
        async all<T>() {
          if (/FROM benchmark_run_documents/i.test(sql)) return { results: [document] as T[] };
          if (/FROM benchmark_model_results/i.test(sql)) return { results: results as T[] };
          return { results: [] as T[] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe('durable benchmark admin routes', () => {
  it('uses structural publishability, not model confidence, for individual autonomy', () => {
    expect(benchmarkReadIsAutonomous('would_publish', 1)).toBe(true);
    expect(benchmarkReadIsAutonomous('would_publish', 0)).toBe(false);
    expect(benchmarkReadIsAutonomous('agree_but_hardfail', 1)).toBe(false);
  });

  it('does not emit a second benchmark cost event for provider-reported xAI cost ticks', () => {
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: 321_000_000 })).toBe(true);
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: 0 })).toBe(true);
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: -1 })).toBe(false);
    expect(benchmarkUsageHasProviderReportedCost({ costInUsdTicks: Number.NaN })).toBe(false);
    expect(benchmarkUsageHasProviderReportedCost({ promptTokens: 100, completionTokens: 20 })).toBe(false);
  });

  it('preserves a successful settings result when only its D1 receipt fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(persistBenchmarkSelectionAudit(async () => {
        throw new Error('D1 unavailable');
      })).resolves.toEqual({
        auditPersisted: false,
        warning: 'Settings were saved and verified, but the benchmark selection receipt could not be persisted.',
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('requires explicit paid-run confirmation and reports the planned call count', async () => {
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'openai', model: 'gpt-4o' }],
      }),
    }, env());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      requiresConfirmation: true,
      plannedCalls: 1,
      documentCount: 1,
      configuredModels: [{ provider: 'openai', model: 'gpt-4o', configured: true }],
    });
  });

  it('excludes model/autopublish-resolved filings from benchmark ground truth', async () => {
    const base = env();
    let selectionSql = '';
    let groundTruthQueried = false;
    const db = {
      prepare(sql: string) {
        if (/FROM filings f[\s\S]*LEFT JOIN review_queue/i.test(sql)) {
          selectionSql = sql;
          return {
            bind() { return this; },
            async all<T>() {
              // This filing is resolved only by a model receipt. The SQL's
              // admin/latest-decision provenance expression must label it 0.
              return { results: [{ doc_id: 'AUTO-1', resolved: 0 }] as T[] };
            },
          };
        }
        if (/FROM transactions t/i.test(sql)) {
          groundTruthQueried = true;
          throw new Error('model-resolved rows must not be loaded as ground truth');
        }
        return base.DB.prepare(sql);
      },
      async batch(statements: D1PreparedStatement[]) { return base.DB.batch(statements); },
    } as unknown as D1Database;

    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'xai', model: 'grok-4.3' }],
      }),
    }, env({ DB: db }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      docs: [{ docId: 'AUTO-1', resolved: false }],
      resolvedDocumentCount: 0,
    });
    expect(groundTruthQueried).toBe(false);
    expect(selectionSql).toContain("d.source = 'admin'");
    expect(selectionSql).toContain("d.action IN ('confirmed', 'manual')");
    expect(selectionSql).toContain('ORDER BY d.created_at DESC, d.id DESC');
  });

  it('atomically rejects a concurrent reservation that would exceed the daily cap', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB);
    const reservationEnv = env({
      DB: ledger.db,
      BENCHMARK_DAILY_CALL_CAP: '5',
    });

    const outcomes = await Promise.allSettled([
      reserveBenchmarkCalls(reservationEnv, 4),
      reserveBenchmarkCalls(reservationEnv, 4),
    ]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<{ usedToday: number; dailyCap: number }> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toEqual({ usedToday: 4, dailyCap: 5 });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      reason: 'cap_reached',
      usedToday: 4,
      dailyCap: 5,
    });
    expect(rejected[0]?.reason).toBeInstanceOf(BenchmarkCallReservationError);
    expect(ledger.reservedCalls()).toBe(4);
  });

  it('serializes chamber settings mutations and only lets the owner release its lease', async () => {
    const db = settingsLeaseDb();
    const now = '2026-07-13T12:00:00.000Z';
    const outcomes = await Promise.allSettled([
      acquireBenchmarkSettingsLease(db, 'house', { now, ownerToken: 'writer-a' }),
      acquireBenchmarkSettingsLease(db, 'house', { now, ownerToken: 'writer-b' }),
    ]);

    const acquired = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBenchmarkSettingsLease>>> =>
        outcome.status === 'fulfilled',
    );
    const blocked = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(acquired?.value.ownerToken).toMatch(/^writer-[ab]$/);
    expect(blocked?.reason).toBeInstanceOf(BenchmarkSettingsLeaseBusyError);
    expect(await releaseBenchmarkSettingsLease(db, {
      chamber: 'house', ownerToken: 'not-the-owner', leaseUntil: acquired!.value.leaseUntil,
    })).toBe(false);
    expect(await releaseBenchmarkSettingsLease(db, acquired!.value)).toBe(true);
    await expect(acquireBenchmarkSettingsLease(db, 'house', {
      now: '2026-07-13T12:00:01.000Z', ownerToken: 'writer-c',
    })).resolves.toMatchObject({ ownerToken: 'writer-c' });
  });

  it('fences settings mutations by owner token and lease expiry', async () => {
    const db = settingsLeaseDb();
    const original = await acquireBenchmarkSettingsLease(db, 'house', {
      now: '2026-07-13T12:00:00.000Z',
      leaseMs: 30_000,
      ownerToken: 'writer-a',
    });
    await expect(assertBenchmarkSettingsLease(
      db,
      original,
      '2026-07-13T12:00:29.999Z',
    )).resolves.toBeUndefined();
    await expect(assertBenchmarkSettingsLease(
      db,
      original,
      '2026-07-13T12:00:30.000Z',
    )).rejects.toBeInstanceOf(BenchmarkSettingsLeaseLostError);

    const successor = await acquireBenchmarkSettingsLease(db, 'house', {
      now: '2026-07-13T12:00:30.000Z',
      leaseMs: 30_000,
      ownerToken: 'writer-b',
    });
    await expect(assertBenchmarkSettingsLease(
      db,
      original,
      '2026-07-13T12:00:30.001Z',
    )).rejects.toBeInstanceOf(BenchmarkSettingsLeaseLostError);
    await expect(assertBenchmarkSettingsLease(
      db,
      successor,
      '2026-07-13T12:00:30.001Z',
    )).resolves.toBeUndefined();
  });

  it('fails closed with 503 when the paid-call reservation ledger is unavailable', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB, 0, { fail: true });
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'openai', model: 'gpt-4o' }],
        confirmPaidRun: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'benchmark daily call reservation is temporarily unavailable',
      code: 'benchmark_call_reservation_unavailable',
      plannedCalls: 1,
      dailyCap: 5,
      retryable: true,
    });
    expect(ledger.reservedCalls()).toBe(0);
  });

  it('returns the durable count when the daily cap rejects a paid run', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB, 5);
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'openai', model: 'gpt-4o' }],
        confirmPaidRun: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'benchmark daily call cap reached',
      plannedCalls: 1,
      usedToday: 5,
      dailyCap: 5,
    });
    expect(ledger.reservedCalls()).toBe(5);
  });

  it('persists an explicit initial-cell authorization with a paid run reservation', async () => {
    const base = env();
    const ledger = atomicReservationDb(base.DB);
    const response = await buildAdminRouter().request('/benchmark/runs', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        chamber: 'house',
        limit: 1,
        models: [{ provider: 'openai', model: 'gpt-4o' }],
        confirmPaidRun: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      run: {
        requestProfile: {
          paidCallAuthorization: {
            version: 1,
            scope: 'initial_model_document_cells',
            reservedCalls: 1,
            documentCount: 1,
            models: [{ provider: 'openai', model: 'gpt-4o' }],
          },
        },
      },
    });
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('does not charge the daily cap twice for an authorized initial run cell', async () => {
    const authorizedDb = claimableBenchmarkDb({
      paidCallAuthorization: {
        version: 1,
        scope: 'initial_model_document_cells',
        reservedCalls: 1,
        documentCount: 1,
        models: [{ provider: 'openai', model: 'gpt-4o' }],
      },
    });
    const ledger = atomicReservationDb(authorizedDb, 1);
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: 'run-1', outcome: 'skipped', reason: 'filing_or_raw_object_missing', invoked: false,
    });
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('requires and reserves the full legacy A+B agreement lineup before any provider call', async () => {
    const lineup = {
      a: { provider: 'openai', model: 'gpt-4o' },
      b: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    };
    const unconfirmed = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ models: lineup }),
    }, env());
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      requiresConfirmation: true,
      plannedCalls: 2,
      configuredModels: [lineup.a, lineup.b],
    });

    const base = env();
    const ledger = atomicReservationDb(base.DB, 1);
    const capped = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ models: lineup, confirmPaidRun: true }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '2' }));
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ plannedCalls: 2, usedToday: 1, dailyCap: 2 });
    expect(ledger.reservedCalls()).toBe(1);
  });

  it('returns pending instead of duplicating a paid cell held by another lease', async () => {
    const running = benchmarkMeasurement('openai', 'gpt-4o', {
      invoked: 0,
      ok: 0,
      autonomous: 0,
      outcome: 'running',
      cost_usd: null,
      cost_source: 'unknown',
      claim_token: 'other-worker',
      lease_until: '2099-01-01T00:00:00.000Z',
    });
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
    }, env({ DB: persistedBenchmarkDb([running], [], 'running') }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      runId: 'run-1',
      docId: 'H-1',
      pending: true,
      state: 'running',
      leaseUntil: '2099-01-01T00:00:00.000Z',
    });
  });

  it('does not silently retry an expired paid cell with an unknown outcome', async () => {
    const orphaned = benchmarkMeasurement('openai', 'gpt-4o', {
      invoked: 0,
      ok: 0,
      autonomous: 0,
      outcome: 'running',
      cost_usd: null,
      cost_source: 'unknown',
      claim_token: 'expired-worker',
      lease_until: '2026-01-01T00:00:00.000Z',
    });
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ runId: 'run-1', models: { a: BENCHMARK_MODELS[0] } }),
    }, env({ DB: persistedBenchmarkDb([orphaned], [], 'running') }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'benchmark_attempt_outcome_unknown',
      state: 'orphaned',
      requiresRetryConfirmation: true,
    });
  });

  it('atomically reserves another paid call before an explicitly confirmed unknown-outcome retry', async () => {
    const orphaned = benchmarkMeasurement('openai', 'gpt-4o', {
      invoked: 0,
      ok: 0,
      autonomous: 0,
      outcome: 'running',
      cost_usd: null,
      cost_source: 'unknown',
      claim_token: 'expired-worker',
      lease_until: '2026-01-01T00:00:00.000Z',
    });
    const ledger = atomicReservationDb(
      persistedBenchmarkDb([orphaned], [], 'running'),
      5,
    );
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        runId: 'run-1',
        models: { a: BENCHMARK_MODELS[0] },
        confirmRetryAfterUnknownOutcome: true,
      }),
    }, env({ DB: ledger.db, BENCHMARK_DAILY_CALL_CAP: '5' }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'benchmark daily call cap reached',
      plannedCalls: 1,
      usedToday: 5,
      dailyCap: 5,
    });
    expect(ledger.reservedCalls()).toBe(5);
  });

  it('validates explicit unknown-outcome retry confirmation', async () => {
    const response = await buildAdminRouter().request('/benchmark/dry-run/H-1', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        runId: 'run-1',
        models: { a: BENCHMARK_MODELS[0] },
        confirmRetryAfterUnknownOutcome: 'yes',
      }),
    }, env());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'confirmRetryAfterUnknownOutcome must be a boolean',
    });
  });

  it('returns an effective chamber lineup, opaque version, and credential booleans', async () => {
    const response = await buildAdminRouter().request(
      '/benchmark/settings/house',
      { headers: AUTH },
      env(),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      chamber: 'house',
      valid: true,
      writeProtected: false,
      lineup: {
        a: { provider: 'mistral', model: 'mistral-ocr-latest' },
        b: { provider: 'openai', model: 'gpt-4o' },
        c: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      },
    });
    expect(body.version).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain('openai-key');
  });

  it('keeps chamber lineup settings read-only in preview deployments', async () => {
    const response = await buildAdminRouter().request('/benchmark/settings/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2],
        sourceRunId: 'run-1', expectedVersion: 'never-read',
      }),
    }, env({
      PREVIEW_DEPLOYMENT: 'true',
      DB: {
        prepare() { throw new Error('preview guard must run before D1 or Infisical writes'); },
      } as unknown as D1Database,
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'benchmark lineup settings are read-only in preview deployments',
      code: 'preview_write_protected',
    });
  });

  it('validates history chamber filters before querying D1', async () => {
    const response = await buildAdminRouter().request(
      '/benchmark/runs?chamber=oge',
      { headers: AUTH },
      env(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid chamber' });
  });

  it('simulates a measured tier-one agreement with actual cost and parallel wall time', async () => {
    const parsed = {
      ticker: 'AAPL',
      assetName: 'Apple Inc.',
      txDate: '2026-07-01',
      txType: 'P',
      amountMin: 1_001,
      amountMax: 15_000,
      owner: 'self',
      assetType: 'ST',
      assetTypeName: 'Stock',
      isOption: false,
      capGainsOver200: false,
      rawText: 'Apple Inc.',
      confidence: 0.99,
    };
    const run = {
      id: 'run-1', chamber: 'house', status: 'completed',
      requested_doc_count: 1, completed_doc_count: 1, model_count: 3,
      models_json: JSON.stringify([
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'gemini', model: 'gemini-3.5-flash' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ]),
      started_at: '2026-07-13T12:00:00.000Z',
      completed_at: '2026-07-13T12:01:00.000Z', duration_ms: 60_000,
      known_cost_usd: 0.003, cost_covered_calls: 2, invoked_calls: 2,
      summary_json: null, selected_lineup_json: null, selected_at: null,
      selection_error: null, selection_audit_json: null, error: null,
      created_at: '2026-07-13T12:00:00.000Z', updated_at: '2026-07-13T12:01:00.000Z',
    };
    const document = {
      run_id: 'run-1', doc_id: 'H-1', ordinal: 0, resolved: 1,
      ground_truth_json: JSON.stringify([parsed]),
    };
    const measurement = (provider: string, model: string, latency: number, cost: number) => ({
      run_id: 'run-1', doc_id: 'H-1', provider, model, resolved_model: model,
      invoked: 1, ok: 1, outcome: 'would_publish', autonomous: 1, error: null,
      row_count: 1, avg_confidence: 0.99, latency_ms: latency, cost_usd: cost,
      cost_source: 'usage_priced', cost_detail_json: '{}', provider_request_id: null,
      usage_json: '{}', result_json: JSON.stringify({ rows: [parsed], flags: [] }),
      perfect_match: 1, true_positive: 1, false_positive: 0, false_negative: 0,
      started_at: null, completed_at: null, created_at: '2026-07-13T12:00:01.000Z',
    });
    const results = [
      measurement('openai', 'gpt-4o', 100, 0.001),
      measurement('gemini', 'gemini-3.5-flash', 200, 0.002),
      measurement('anthropic', 'claude-haiku-4-5', 300, 0.004),
    ];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first<T>() {
            return (/FROM benchmark_runs/i.test(sql) ? run : null) as T | null;
          },
          async all<T>() {
            if (/FROM benchmark_run_documents/i.test(sql)) return { results: [document] as T[] };
            if (/FROM benchmark_model_results/i.test(sql)) return { results: results as T[] };
            return { results: [] as T[] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const response = await buildAdminRouter().request('/benchmark/runs/run-1/simulate', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        a: { provider: 'openai', model: 'gpt-4o' },
        b: { provider: 'gemini', model: 'gemini-3.5-flash' },
        c: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      }),
    }, env({ DB: db }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      documentsSimulated: 1,
      incompleteDocuments: 0,
      tier1AutonomyRate: 1,
      cascadeAutonomyRate: 1,
      accuracyRate: 1,
      requiredCalls: 2,
      invokedCalls: 2,
      costCoveredCalls: 2,
      knownCostUsd: 0.003,
      actualCostPerDocumentUsd: 0.003,
      avgWallClockMs: 300,
      p50WallClockMs: 300,
      p95WallClockMs: 300,
    });
  });

  it('models disagreement as tier-one A+B followed by fresh tier-two A+B+C', async () => {
    const rowA = {
      ticker: 'AAPL', assetName: 'Apple Inc.', txDate: '2026-07-01', txType: 'P',
      amountMin: 1_001, amountMax: 15_000, owner: 'self', assetType: 'ST',
      assetTypeName: 'Stock', isOption: false, capGainsOver200: false,
      rawText: 'Apple', confidence: 0.99,
    };
    const rowB = { ...rowA, ticker: 'MSFT', assetName: 'Microsoft Corp.' };
    const results = [
      benchmarkMeasurement('openai', 'gpt-4o', {
        latency_ms: 100, cost_usd: 0.001,
        result_json: JSON.stringify({ rows: [rowA], flags: [] }),
      }),
      benchmarkMeasurement('gemini', 'gemini-3.5-flash', {
        latency_ms: 200, cost_usd: 0.002,
        result_json: JSON.stringify({ rows: [rowB], flags: [] }),
      }),
      benchmarkMeasurement('anthropic', 'claude-haiku-4-5', {
        latency_ms: 300, cost_usd: 0.004,
        result_json: JSON.stringify({ rows: [rowA], flags: [] }),
      }),
    ];
    const response = await buildAdminRouter().request('/benchmark/runs/run-1/simulate', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2] }),
    }, env({ DB: persistedBenchmarkDb(results, [rowA]) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      documentsSimulated: 1,
      incompleteDocuments: 0,
      requiredCalls: 5,
      invokedCalls: 5,
      costCoveredCalls: 5,
      knownCostUsd: 0.01,
      actualCostPerDocumentUsd: 0.01,
      avgWallClockMs: 900,
      p50WallClockMs: 900,
      p95WallClockMs: 900,
    });
  });

  it('excludes unavailable required readings and blocks saving their model', async () => {
    const results = [
      benchmarkMeasurement('openai', 'gpt-4o', {
        invoked: 0, ok: 0, autonomous: 0, cost_usd: null, cost_source: 'unknown',
      }),
      benchmarkMeasurement('gemini', 'gemini-3.5-flash', { cost_usd: 0.002 }),
      benchmarkMeasurement('anthropic', 'claude-haiku-4-5', { cost_usd: 0.004 }),
    ];
    const db = persistedBenchmarkDb(results);
    const simulation = await buildAdminRouter().request('/benchmark/runs/run-1/simulate', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2] }),
    }, env({ DB: db }));
    expect(simulation.status).toBe(200);
    expect(await simulation.json()).toMatchObject({
      documentsSimulated: 0,
      incompleteDocuments: 1,
      requiredCalls: 2,
      invokedCalls: 1,
      costCoveredCalls: 1,
      actualCostPerDocumentUsd: null,
    });

    const save = await buildAdminRouter().request('/benchmark/settings/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2],
        sourceRunId: 'run-1', expectedVersion: 'unused-before-validation',
      }),
    }, env({ DB: db }));
    expect(save.status).toBe(409);
    expect(await save.json()).toMatchObject({
      error: 'selected models require full invoked coverage plus at least one successful autonomous reading',
      invalidModelCoverage: [{
        model: BENCHMARK_MODELS[0],
        requiredReadings: 1,
        invokedReadings: 0,
        successfulReadings: 0,
        autonomousReadings: 0,
      }],
    });
  });

  it('blocks promotion of a model that was invoked but failed every reading', async () => {
    const results = [
      benchmarkMeasurement('openai', 'gpt-4o', {
        ok: 0, autonomous: 0, outcome: 'skipped', error: 'model_not_found',
      }),
      benchmarkMeasurement('gemini', 'gemini-3.5-flash'),
      benchmarkMeasurement('anthropic', 'claude-haiku-4-5'),
    ];
    const response = await buildAdminRouter().request('/benchmark/settings/house', {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify({
        a: BENCHMARK_MODELS[0], b: BENCHMARK_MODELS[1], c: BENCHMARK_MODELS[2],
        sourceRunId: 'run-1', expectedVersion: 'unused-before-validation',
      }),
    }, env({ DB: persistedBenchmarkDb(results) }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      invalidModelCoverage: [{
        model: BENCHMARK_MODELS[0], invokedReadings: 1, successfulReadings: 0,
      }],
    });
  });
});
