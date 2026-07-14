import { describe, expect, it } from 'vitest';
import {
  beginBenchmarkRun,
  claimBenchmarkMeasurement,
  recordBenchmarkSelection,
  releaseBenchmarkMeasurementClaim,
  saveBenchmarkMeasurement,
  summarizeBenchmarkMeasurements,
  type BenchmarkRunDetail,
} from '../persistence';

interface CapturedStatement {
  sql: string;
  params: unknown[];
}

function captureDb(): { db: D1Database; statements: CapturedStatement[] } {
  const statements: CapturedStatement[] = [];
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async run() {
        statements.push({ sql, params });
        return { success: true, meta: { changes: 1 } } as unknown as D1Result;
      },
    };
    return statement;
  };
  const db = {
    prepare,
    async batch(prepared: D1PreparedStatement[]) {
      const results: D1Result[] = [];
      for (const statement of prepared) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
  return { db, statements };
}

type Result = BenchmarkRunDetail['results'][number];

function result(over: Partial<Result> = {}): Result {
  return {
    runId: 'run-1',
    docId: 'doc-1',
    provider: 'openai',
    model: 'gpt-test',
    resolvedModel: 'gpt-test-2026-07-01',
    invoked: true,
    ok: true,
    outcome: 'would_publish',
    autonomous: true,
    error: null,
    rowCount: 2,
    avgConfidence: 0.95,
    latencyMs: 100,
    costUsd: 0.001,
    costSource: 'usage_priced',
    costDetail: null,
    providerRequestId: null,
    usage: null,
    result: null,
    perfectMatch: true,
    truePositive: 2,
    falsePositive: 0,
    falseNegative: 0,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

describe('benchmark persistence', () => {
  it('requires explicit confirmation before retrying an expired paid cell', async () => {
    let row: { outcome: string; claim_token: string | null; lease_until: string } | null = null;
    const db = {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { params = values; return statement; },
          async run() {
            if (/UPDATE benchmark_model_results[\s\S]*SET claim_token = NULL/.test(sql)) {
              const accepted = row?.claim_token === String(params[5]);
              if (accepted && row) row = { ...row, claim_token: null, lease_until: String(params[0]) };
              return { success: true, meta: { changes: accepted ? 1 : 0 } } as unknown as D1Result;
            }
            if (/INSERT INTO benchmark_model_results/.test(sql)) {
              const now = String(params[4]);
              if (!row || (params[8] === 1 && row.outcome === 'running' && row.lease_until <= now)) {
                row = {
                  outcome: 'running',
                  claim_token: String(params[5]),
                  lease_until: String(params[6]),
                };
                return { success: true, meta: { changes: 1 } } as unknown as D1Result;
              }
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          },
          async first<T>() { return row as T | null; },
        };
        return statement;
      },
    } as unknown as D1Database;

    const first = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:00:00.000Z', leaseMs: 60_000,
    });
    expect(first).toMatchObject({ claimed: true, state: 'claimed' });

    const concurrent = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:00:30.000Z', leaseMs: 60_000,
    });
    expect(concurrent).toEqual({
      claimed: false,
      claimToken: null,
      leaseUntil: '2026-07-13T12:01:00.000Z',
      state: 'running',
      reclaimedUnknownOutcome: false,
    });

    const orphaned = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:01:00.000Z', leaseMs: 60_000,
    });
    expect(orphaned).toEqual({
      claimed: false,
      claimToken: null,
      leaseUntil: '2026-07-13T12:01:00.000Z',
      state: 'orphaned',
      reclaimedUnknownOutcome: false,
    });

    const reclaimed = await claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:01:00.000Z', leaseMs: 60_000,
      allowRetryAfterUnknownOutcome: true,
    });
    expect(reclaimed).toMatchObject({
      claimed: true,
      state: 'claimed',
      reclaimedUnknownOutcome: true,
    });
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
    if (!reclaimed.claimToken) throw new Error('expected reclaimed benchmark claim token');

    await expect(releaseBenchmarkMeasurementClaim(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      claimToken: reclaimed.claimToken, preserveUnknownOutcome: true,
      now: '2026-07-13T12:01:00.000Z',
    })).resolves.toBe(true);
    await expect(claimBenchmarkMeasurement(db, {
      runId: 'run-1', docId: 'doc-1', provider: 'openai', model: 'gpt-test',
      now: '2026-07-13T12:01:00.001Z', leaseMs: 60_000,
    })).resolves.toMatchObject({ claimed: false, state: 'orphaned' });
  });

  it('deletes only the matching fresh uninvoked claim when reservation fails', async () => {
    const { db, statements } = captureDb();
    await expect(releaseBenchmarkMeasurementClaim(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      claimToken: 'claim-1',
      preserveUnknownOutcome: false,
    })).resolves.toBe(true);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/DELETE FROM benchmark_model_results/);
    expect(statements[0]?.sql).toMatch(/outcome = 'running' AND invoked = 0 AND claim_token = \?/);
    expect(statements[0]?.params).toEqual([
      'run-1', 'doc-1', 'openai', 'gpt-test', 'claim-1',
    ]);
  });

  it('starts a chamber-scoped run and snapshots its ordered documents', async () => {
    const { db, statements } = captureDb();
    const run = await beginBenchmarkRun(db, {
      id: 'run-1',
      chamber: 'executive',
      models: [
        { provider: 'openai', model: 'gpt-test' },
        { provider: 'anthropic', model: 'claude-test' },
      ],
      documents: [
        { docId: 'doc-1', resolved: true, groundTruth: [{ ticker: 'AAPL' }] },
        { docId: 'doc-2', resolved: false },
      ],
      startedAt: '2026-07-13T12:00:00.000Z',
      requestProfile: { version: 'benchmark-v1', serviceTier: 'default' },
    });

    expect(run).toMatchObject({
      id: 'run-1',
      chamber: 'executive',
      status: 'running',
      requestedDocCount: 2,
      selectedLineup: null,
      requestProfile: { version: 'benchmark-v1', serviceTier: 'default' },
    });
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain('INSERT INTO benchmark_runs');
    expect(statements[0].params).toContain('{"version":"benchmark-v1","serviceTier":"default"}');
    expect(statements[1]).toMatchObject({
      params: ['run-1', 'doc-1', 0, 1, '[{"ticker":"AAPL"}]'],
    });
    expect(statements[2]).toMatchObject({ params: ['run-1', 'doc-2', 1, 0, null] });
  });

  it('persists auditable usage-priced cost without treating missing cost as zero', async () => {
    const { db, statements } = captureDb();
    await saveBenchmarkMeasurement(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      resolvedModel: 'gpt-test-2026-07-01',
      invoked: true,
      ok: true,
      outcome: 'would_publish',
      autonomous: true,
      rowCount: 2,
      latencyMs: 325,
      costUsd: 0.001234,
      costSource: 'usage_priced',
      costDetail: {
        rateCardVersion: '2026-07-13',
        billedUsage: { inputTokens: 100, outputTokens: 20 },
      },
      usage: { promptTokens: 100, completionTokens: 20 },
      perfectMatch: true,
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      createdAt: '2026-07-13T12:00:01.000Z',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('ON CONFLICT (run_id, doc_id, provider, model)');
    expect(statements[0].params).toContain(0.001234);
    expect(statements[0].params).toContain('usage_priced');
    expect(statements[0].params).toContain('gpt-test-2026-07-01');
  });

  it('uses a lease token to prevent stale workers from overwriting a benchmark cell', async () => {
    const { db, statements } = captureDb();
    await saveBenchmarkMeasurement(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      invoked: true,
      ok: true,
      outcome: 'would_publish',
      autonomous: true,
      rowCount: 1,
      costUsd: 0.001,
      costSource: 'usage_priced',
      claimToken: 'claim-1',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("AND claim_token = ? AND outcome = 'running'");
    expect(statements[0].params.at(-1)).toBe('claim-1');
  });

  it('rejects a dollar value whose source is unknown', async () => {
    const { db } = captureDb();
    await expect(saveBenchmarkMeasurement(db, {
      runId: 'run-1',
      docId: 'doc-1',
      provider: 'openai',
      model: 'gpt-test',
      invoked: true,
      ok: false,
      autonomous: false,
      rowCount: 0,
      costUsd: 0,
      costSource: 'unknown',
    })).rejects.toThrow('unknown cost source requires costUsd=null');
  });

  it('records the selected A/B/C lineup with a non-secret settings receipt', async () => {
    const { db, statements } = captureDb();
    await recordBenchmarkSelection(db, 'run-1', {
      lineup: {
        a: { provider: 'openai', model: 'gpt-test' },
        b: { provider: 'anthropic', model: 'claude-test' },
        c: null,
      },
      selectedAt: '2026-07-13T12:05:00.000Z',
      audit: { chamber: 'house', keys: ['AGREEMENT_HOUSE_MODEL_A', 'AGREEMENT_HOUSE_MODEL_B'] },
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('selected_lineup_json');
    expect(statements[0].params[0]).toBe(
      '{"a":{"provider":"openai","model":"gpt-test"},"b":{"provider":"anthropic","model":"claude-test"},"c":null}',
    );
    expect(String(statements[0].params[3])).toContain('AGREEMENT_HOUSE_MODEL_A');
  });
});

describe('summarizeBenchmarkMeasurements', () => {
  const models = [
    { provider: 'openai', model: 'gpt-test' },
    { provider: 'anthropic', model: 'claude-test' },
  ];

  it('reports actual latency percentiles and a cost/doc only at full coverage', () => {
    const summary = summarizeBenchmarkMeasurements(models, 2, [
      result({ docId: 'doc-1', latencyMs: 100, costUsd: 0.001 }),
      result({ docId: 'doc-2', latencyMs: 300, costUsd: 0.003, perfectMatch: false, truePositive: 1, falsePositive: 1, falseNegative: 1 }),
      result({ docId: 'doc-1', provider: 'anthropic', model: 'claude-test', latencyMs: 200, costUsd: 0.002 }),
      result({ docId: 'doc-2', provider: 'anthropic', model: 'claude-test', latencyMs: 400, costUsd: 0.004 }),
    ]);

    expect(summary).toMatchObject({
      documentCount: 2,
      invokedCalls: 4,
      coveredInvocations: 4,
      costCoverageRate: 1,
      knownCostUsd: 0.01,
      actualCostPerDocumentUsd: 0.005,
      avgLatencyMs: 250,
      p50LatencyMs: 200,
      p95LatencyMs: 400,
    });
    expect(summary.models[0]).toMatchObject({
      provider: 'openai',
      docsMeasured: 2,
      perfectMatches: 1,
      perfectMatchRate: 0.5,
      avgLatencyMs: 200,
      p50LatencyMs: 100,
      p95LatencyMs: 300,
      knownCostUsd: 0.004,
      actualCostPerDocumentUsd: 0.002,
    });
  });

  it('keeps known spend visible but nulls actual cost/doc when any invoked call is unpriced', () => {
    const summary = summarizeBenchmarkMeasurements(models, 1, [
      result({ costUsd: 0.001 }),
      result({
        provider: 'anthropic',
        model: 'claude-test',
        costUsd: null,
        costSource: 'unknown',
      }),
      result({
        provider: 'anthropic',
        model: 'claude-test',
        docId: 'not-invoked',
        invoked: false,
        latencyMs: 0,
        costUsd: null,
        costSource: 'unknown',
      }),
    ]);

    expect(summary).toMatchObject({
      invokedCalls: 2,
      coveredInvocations: 1,
      costCoverageRate: 0.5,
      knownCostUsd: 0.001,
      actualCostPerDocumentUsd: null,
      avgLatencyMs: 100,
    });
    expect(summary.models[1]).toMatchObject({
      providerCalls: 1,
      unavailableDocs: 1,
      docsOk: 1,
      failures: 0,
      autonomousDocs: 1,
      autonomyRate: 1,
      coveredInvocations: 0,
      costCoverageRate: 0,
      knownCostUsd: 0,
      actualCostPerDocumentUsd: null,
    });
  });
});
