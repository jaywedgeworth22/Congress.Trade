import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAdminRouter } from '../routes';
import { stableMeasuredUsageIdempotencyKey } from '../../shared/thirdPartyTelemetry';

const AUTH = { Authorization: 'Bearer test-admin' };

function makeEnv(jobOverrides: {
  provider?: string;
  model?: string;
  providerBatchId?: string;
  docIds?: string[];
  submittedAt?: string | null;
  completedAt?: string | null;
  completionCasWinner?: string;
  submissionCasWinner?: string;
  initialResultSummary?: Record<string, unknown> | string | null;
  accountingPlanCasWinner?: Record<string, unknown>;
  extractionInsertFailures?: number;
  existingExtractionRows?: Array<{ id: string; docId: string }>;
  measuredUsageDeliveryFailures?: number;
} = {}) {
  let usageJson: string | null | undefined;
  let resultSummaryJson = Object.prototype.hasOwnProperty.call(jobOverrides, 'initialResultSummary')
    ? typeof jobOverrides.initialResultSummary === 'string'
      ? jobOverrides.initialResultSummary
      : jobOverrides.initialResultSummary == null
        ? null
        : JSON.stringify(jobOverrides.initialResultSummary)
    : JSON.stringify({ state: 'accounting_pending', accountingProtocol: 1 });
  let status = 'running';
  let jobError: string | null = null;
  const extractionRunIds: string[] = [];
  const persistedExtractionRows = (jobOverrides.existingExtractionRows ?? []).map((row) => ({
    id: row.id,
    docId: row.docId,
  }));
  const extractionInsertSql: string[] = [];
  let extractionInsertFailuresRemaining = jobOverrides.extractionInsertFailures ?? 0;
  let measuredUsageDeliveryFailuresRemaining = jobOverrides.measuredUsageDeliveryFailures ?? 0;
  let accountingPlanCasWinnerPending = jobOverrides.accountingPlanCasWinner != null;
  let submittedAt = Object.prototype.hasOwnProperty.call(jobOverrides, 'submittedAt')
    ? jobOverrides.submittedAt ?? null
    : '2026-07-13T12:00:00.000Z';
  let completedAt = Object.prototype.hasOwnProperty.call(jobOverrides, 'completedAt')
    ? jobOverrides.completedAt ?? null
    : null;
  const usageEvents: unknown[] = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/SELECT result_summary FROM batch_jobs/i.test(sql)) {
        return { result_summary: resultSummaryJson } as T;
      }
      if (/SELECT status FROM batch_jobs/i.test(sql)) {
        return { status } as T;
      }
      if (/SELECT completed_at FROM batch_jobs/i.test(sql)) {
        return { completed_at: completedAt } as T;
      }
      if (/FROM batch_jobs WHERE id = \?/i.test(sql)) {
        return {
          id: 'job-123',
          provider: jobOverrides.provider ?? 'openai',
          model: jobOverrides.model ?? 'gpt-4o',
          provider_batch_id: jobOverrides.providerBatchId ?? 'batch-123',
          doc_ids: JSON.stringify(jobOverrides.docIds ?? ['H-1']),
          status,
          submitted_at: submittedAt,
          completed_at: completedAt,
          result_summary: resultSummaryJson,
        } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/FROM extraction_runs/i.test(sql) && /batch_id = \?/i.test(sql)) {
        return {
          results: persistedExtractionRows.map((row) => ({
            id: row.id,
            doc_id: row.docId,
          })) as T[],
        };
      }
      return { results: [] as T[] };
    },
    async run() {
      let changes = 1;
      if (/SET completed_at = \?/i.test(sql) && /completed_at IS NULL OR completed_at = \?/i.test(sql)) {
        const expected = this.params[2] == null ? null : String(this.params[2]);
        if (jobOverrides.completionCasWinner) {
          completedAt = jobOverrides.completionCasWinner;
        } else if (completedAt == null || completedAt === expected) {
          completedAt = String(this.params[0]);
        }
      }
      if (/SET submitted_at = \?/i.test(sql) && /submitted_at IS NULL OR submitted_at = \?/i.test(sql)) {
        const expected = this.params[2] == null ? null : String(this.params[2]);
        if (jobOverrides.submissionCasWinner) {
          submittedAt = jobOverrides.submissionCasWinner;
        } else if (submittedAt == null || submittedAt === expected) {
          submittedAt = String(this.params[0]);
        }
      }
      if (/INSERT(?: OR IGNORE)? INTO extraction_runs/i.test(sql)) {
        if (extractionInsertFailuresRemaining > 0) {
          extractionInsertFailuresRemaining--;
          throw new Error('transient extraction insert failure');
        }
        const id = String(this.params[0]);
        const docId = String(this.params[2]);
        if (/INSERT OR IGNORE/i.test(sql) && persistedExtractionRows.some((row) => row.id === id)) {
          changes = 0;
        } else {
          persistedExtractionRows.push({ id, docId });
          extractionInsertSql.push(sql);
          extractionRunIds.push(id);
          usageJson = this.params[11] == null ? null : String(this.params[11]);
        }
      }
      if (/SET status = 'settling', result_summary = \?/i.test(sql)) {
        const expectedSummary = this.params[2] == null ? null : String(this.params[2]);
        if ((status === 'submitted' || status === 'running') && resultSummaryJson === expectedSummary) {
          status = 'settling';
          resultSummaryJson = String(this.params[0]);
        } else {
          changes = 0;
        }
      } else if (/SET status = 'failed'/i.test(sql) && /status = 'settling'/i.test(sql)) {
        const expectedSummary = this.params[6] == null ? null : String(this.params[6]);
        if (status === 'settling' && resultSummaryJson === expectedSummary) {
          submittedAt = String(this.params[0]);
          completedAt = String(this.params[1]);
          resultSummaryJson = String(this.params[3]);
          jobError = String(this.params[4]);
          status = 'failed';
        } else {
          changes = 0;
        }
      } else if (/SET status = \?, submitted_at = \?, completed_at = \?/i.test(sql) && /status = 'settling'/i.test(sql)) {
        const expectedSummary = this.params[7] == null ? null : String(this.params[7]);
        if (status === 'settling' && resultSummaryJson === expectedSummary) {
          status = String(this.params[0]);
          submittedAt = String(this.params[1]);
          completedAt = String(this.params[2]);
          resultSummaryJson = String(this.params[4]);
          jobError = this.params[5] == null ? null : String(this.params[5]);
        } else {
          changes = 0;
        }
      } else if (/SET status = 'running'/i.test(sql) && /status IN \('submitted', 'running'\)/i.test(sql)) {
        if (status === 'submitted' || status === 'running') status = 'running';
        else changes = 0;
      } else if (/SET result_summary = \?/i.test(sql) && /result_summary IS NULL AND \? IS NULL/i.test(sql)) {
        if (accountingPlanCasWinnerPending && jobOverrides.accountingPlanCasWinner) {
          accountingPlanCasWinnerPending = false;
          resultSummaryJson = JSON.stringify(jobOverrides.accountingPlanCasWinner);
          changes = 0;
        } else {
          const expected = this.params[2] == null ? null : String(this.params[2]);
          if ((status === 'submitted' || status === 'running') && resultSummaryJson === expected) {
            resultSummaryJson = String(this.params[0]);
          }
          else changes = 0;
        }
      }
      return { success: true, meta: { changes } };
    },
  });
  const env = {
    ADMIN_TOKEN: 'test-admin',
    OPENAI_API_KEY: 'test-openai-key',
    XAI_API_KEY: 'test-xai-key',
    DB: { prepare } as unknown as D1Database,
    INGEST_QUEUE: {
      send: vi.fn(async (message: unknown) => {
        usageEvents.push(message);
        const label = (message as { event?: { label?: unknown } }).event?.label;
        if (typeof label === 'string'
          && label.startsWith('batch-')
          && measuredUsageDeliveryFailuresRemaining > 0) {
          measuredUsageDeliveryFailuresRemaining--;
          throw new Error('usage queue and fallback unavailable');
        }
      }),
    },
  } as never;
  return {
    env,
    usageEvents,
    getUsageJson: () => usageJson,
    getResultSummaryJson: () => resultSummaryJson,
    getStatus: () => status,
    getJobError: () => jobError,
    getExtractionRunIds: () => extractionRunIds,
    getExtractionInsertSql: () => extractionInsertSql,
    getSubmittedAt: () => submittedAt,
    getCompletedAt: () => completedAt,
  };
}

describe('POST /batch-status/:jobId usage accounting', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('persists provider usage and enqueues retry-safe measured tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return new Response(JSON.stringify({ status: 'completed', output_file_id: 'output-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/files/output-1/content')) {
        const line = {
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 30,
                prompt_tokens_details: { cached_tokens: 20 },
              },
            },
          },
        };
        return new Response(`${JSON.stringify(line)}\n`, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));

    const { env, usageEvents, getUsageJson, getCompletedAt } = makeEnv();
    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST',
      headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    expect(JSON.parse(getUsageJson()!)).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cachedTokens: 20,
    });
    const expectedKey = await stableMeasuredUsageIdempotencyKey(
      'batch-result', 'tokens', 'job-123', 'H-1',
    );
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: expectedKey,
        provider: 'openai',
        service: 'llm-batch',
        label: 'batch-result-tokens',
        occurredAt: getCompletedAt(),
        quantity: 150,
        unit: 'token',
        metadata: expect.objectContaining({
          promptTokens: 120,
          completionTokens: 30,
          cachedTokens: 20,
        }),
      }),
    }));
  });

  it('persists and meters completed results even when the provider batch expires', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'expired', output_file_id: 'output-partial' });
      }
      if (url.endsWith('/v1/files/output-partial/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 41, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } },
            },
          },
        })}\n`, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));

    const { env, usageEvents, getUsageJson, getCompletedAt } = makeEnv();
    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST',
      headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'failed', summary: { docs: 1, ok: 1 } });
    expect(JSON.parse(getUsageJson()!)).toEqual({ promptTokens: 41, completionTokens: 7, cachedTokens: 5 });
    const expectedKey = await stableMeasuredUsageIdempotencyKey(
      'batch-result', 'tokens', 'job-123', 'H-1',
    );
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: expectedKey,
        label: 'batch-result-tokens',
        occurredAt: getCompletedAt(),
        quantity: 48,
      }),
    }));
  });

  it('meters complete aggregate tokens once per poll with one stable job identity and suppresses result totals', async () => {
    const resultLine = (docId: string, promptTokens: number, completionTokens: number) => ({
      custom_id: docId,
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: '{"transactions":[]}' } }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        },
      },
    });
    let contentPoll = 0;
    let statusPoll = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        const replay = statusPoll++ > 0;
        return Response.json({
          status: 'completed',
          output_file_id: 'output-aggregate',
          completed_at: Date.parse('2026-07-14T00:01:00.000Z') / 1_000,
          usage: {
            input_tokens: replay ? 900 : 300,
            output_tokens: replay ? 90 : 60,
            input_tokens_details: { cached_tokens: replay ? 300 : 100 },
          },
        });
      }
      if (url.endsWith('/v1/files/output-aggregate/content')) {
        const first = resultLine('H-A', 10, 1);
        const second = resultLine('H-B', 20, 2);
        const rows = contentPoll++ === 0 ? [first, second] : [second, first];
        return new Response(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getResultSummaryJson, getCompletedAt } = makeEnv({
      docIds: ['H-A', 'H-B'],
    });
    const router = buildAdminRouter();

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await router.request('/batch-status/job-123', {
        method: 'POST', headers: AUTH,
      }, env);
      expect(response.status).toBe(200);
    }

    const measuredEvents = usageEvents.flatMap((message) => {
      const candidate = message as { type?: string; event?: Record<string, unknown> };
      return candidate.type === 'usage.telemetry' ? [candidate.event ?? {}] : [];
    });
    const aggregateEvents = measuredEvents.filter((event) => event.label === 'batch-job-tokens');
    expect(aggregateEvents).toHaveLength(1);
    expect(new Set(aggregateEvents.map((event) => event.idempotencyKey)).size).toBe(1);
    expect(aggregateEvents[0]).toMatchObject({
      provider: 'openai',
      service: 'llm-batch',
      label: 'batch-job-tokens',
      occurredAt: getCompletedAt(),
      quantity: 360,
      unit: 'token',
      metadata: {
        promptTokens: 300,
        completionTokens: 60,
        cachedTokens: 100,
        success: true,
      },
    });
    expect(aggregateEvents[0]?.idempotencyKey).toMatch(/^ct-measured-[0-9a-f]{64}$/);
    expect(measuredEvents.some((event) => event.label === 'batch-result-tokens')).toBe(false);
    const resultSummaryJson = getResultSummaryJson();
    expect(resultSummaryJson).toBeTypeOf('string');
    expect(JSON.parse(resultSummaryJson ?? 'null')).toMatchObject({
      docs: 2,
      aggregateUsage: { promptTokens: 300, completionTokens: 60, cachedTokens: 100 },
    });
  });

  it.each([
    ['incomplete', { input_tokens: 300 }],
    ['invalid', { input_tokens: 300, output_tokens: 60, input_tokens_details: { cached_tokens: 301 } }],
  ])('fails soft from %s aggregate usage to per-result token accounting', async (_label, usage) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed', output_file_id: 'output-fallback', usage });
      }
      if (url.endsWith('/v1/files/output-fallback/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getResultSummaryJson } = makeEnv();

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    const labels = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return typeof event?.label === 'string' ? [event.label] : [];
    });
    expect(labels).toContain('batch-result-tokens');
    expect(labels).not.toContain('batch-job-tokens');
    const resultSummaryJson = getResultSummaryJson();
    expect(resultSummaryJson).toBeTypeOf('string');
    expect(JSON.parse(resultSummaryJson ?? 'null')).not.toHaveProperty('aggregateUsage');
  });

  it.each([
    {
      label: 'without persisted rows',
      existingExtractionRows: [],
      expectedInserts: 2,
    },
    {
      label: 'with a random-id partial row',
      existingExtractionRows: [{ id: '550e8400-e29b-41d4-a716-446655440000', docId: 'H-A' }],
      expectedInserts: 1,
    },
  ])('suppresses ambiguous measured units for an unversioned legacy batch $label', async ({
    existingExtractionRows,
    expectedInserts,
  }) => {
    const resultLine = (docId: string, promptTokens: number, completionTokens: number) => ({
      custom_id: docId,
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: '{"transactions":[]}' } }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-legacy-partial',
          usage: { input_tokens: 300, output_tokens: 60 },
        });
      }
      if (url.endsWith('/v1/files/output-legacy-partial/content')) {
        return new Response(`${[
          resultLine('H-A', 10, 1),
          resultLine('H-B', 20, 2),
        ].map((row) => JSON.stringify(row)).join('\n')}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getResultSummaryJson,
      getExtractionRunIds,
    } = makeEnv({
      docIds: ['H-A', 'H-B'],
      initialResultSummary: null,
      existingExtractionRows,
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    const measured = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event ? [event] : [];
    });
    expect(measured.filter((event) => event.label === 'batch-result-tokens')).toHaveLength(0);
    expect(measured.some((event) => event.label === 'batch-job-tokens')).toBe(false);
    expect(getExtractionRunIds()).toHaveLength(expectedInserts);
    expect(getExtractionRunIds().every((id) => /^ct-batch-run-[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toMatchObject({
      accountingProtocol: 1,
      accountingPlan: { version: 1, tokenMode: 'per-result' },
      legacyAccounting: 'per_result_compat',
      legacyAccountingAmbiguous: true,
      legacyAccountingAmbiguousDocs: 2,
      measuredUsageStatus: 'suppressed_unknown',
    });
  });

  it('keeps aggregate accounting retryable when Queue and R2 durability are exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-usage-retry',
          usage: { input_tokens: 40, output_tokens: 8 },
        });
      }
      if (url.endsWith('/v1/files/output-usage-retry/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 4, completion_tokens: 1 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getStatus,
      getExtractionRunIds,
      getResultSummaryJson,
    } = makeEnv({ measuredUsageDeliveryFailures: 1 });
    const router = buildAdminRouter();

    const first = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toEqual({ error: 'batch measured usage could not be persisted' });
    expect(getStatus()).toBe('settling');
    expect(getExtractionRunIds()).toHaveLength(0);
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toMatchObject({
      state: 'settling',
      accountingPlan: { version: 1, tokenMode: 'aggregate' },
      terminalDecision: { kind: 'valid' },
    });

    const retry = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    expect(retry.status).toBe(200);
    expect(getExtractionRunIds()).toHaveLength(1);
    const attempts = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event?.label === 'batch-job-tokens' ? [event] : [];
    });
    expect(attempts).toHaveLength(2);
    expect(JSON.stringify(attempts[0])).toBe(JSON.stringify(attempts[1]));
  });

  it('reuses one deterministic row while retrying an identical per-result event after durability exhaustion', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed', output_file_id: 'output-per-result-retry' });
      }
      if (url.endsWith('/v1/files/output-per-result-retry/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getStatus,
      getExtractionRunIds,
      getExtractionInsertSql,
    } = makeEnv({
      initialResultSummary: {
        state: 'accounting_planned',
        accountingProtocol: 1,
        accountingPlan: { version: 1, tokenMode: 'per-result' },
      },
      measuredUsageDeliveryFailures: 1,
    });
    const router = buildAdminRouter();

    const first = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    expect(first.status).toBe(503);
    expect(getStatus()).toBe('settling');
    expect(getExtractionRunIds()).toHaveLength(1);

    const retry = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    await expect(retry.json()).resolves.toMatchObject({ status: 'completed' });
    expect(getStatus()).toBe('completed');
    expect(getExtractionRunIds()).toHaveLength(1);
    expect(getExtractionInsertSql()).toHaveLength(1);
    const attempts = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event?.label === 'batch-result-tokens' ? [event] : [];
    });
    expect(attempts).toHaveLength(2);
    expect(JSON.stringify(attempts[0])).toBe(JSON.stringify(attempts[1]));
    expect(attempts[0]?.idempotencyKey).toMatch(/^ct-measured-[0-9a-f]{64}$/);
    expect(attempts[0]).toMatchObject({ quantity: 15, unit: 'token' });
  });

  it('pins a valid outcome before side effects and rejects a malformed loser until canonical retry resumes', async () => {
    const resultLine = (docId: string, promptTokens: number) => ({
      custom_id: docId,
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: '{"transactions":[]}' } }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
        },
      },
    });
    let outputPoll = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-outcome-race',
          usage: { input_tokens: 30, output_tokens: 2 },
        });
      }
      if (url.endsWith('/v1/files/output-outcome-race/content')) {
        outputPoll++;
        if (outputPoll === 2) return new Response('not-json\n');
        const rows = outputPoll === 1
          ? [resultLine('H-A', 10), resultLine('H-B', 20)]
          : [resultLine('H-B', 20), resultLine('H-A', 10)];
        return new Response(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const {
      env,
      usageEvents,
      getStatus,
      getResultSummaryJson,
      getExtractionRunIds,
    } = makeEnv({
      docIds: ['H-A', 'H-B'],
      measuredUsageDeliveryFailures: 1,
    });
    const router = buildAdminRouter();

    const first = await router.request('/batch-status/job-123', { method: 'POST', headers: AUTH }, env);
    expect(first.status).toBe(503);
    expect(getStatus()).toBe('settling');
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toMatchObject({
      state: 'settling',
      terminalDecision: { kind: 'valid', finalStatus: 'completed' },
    });
    expect(getExtractionRunIds()).toHaveLength(0);

    const malformedLoser = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    await expect(malformedLoser.json()).resolves.toMatchObject({
      status: 'settling',
      settlementInProgress: true,
      terminalDecision: 'valid',
    });
    expect(getStatus()).toBe('settling');
    expect(getExtractionRunIds()).toHaveLength(0);

    const resumed = await router.request('/batch-status/job-123', { method: 'POST', headers: AUTH }, env);
    await expect(resumed.json()).resolves.toMatchObject({ status: 'completed' });
    expect(getStatus()).toBe('completed');
    expect(getExtractionRunIds()).toHaveLength(2);
    const aggregateAttempts = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event?.label === 'batch-job-tokens' ? [event] : [];
    });
    expect(aggregateAttempts).toHaveLength(2);
    expect(JSON.stringify(aggregateAttempts[0])).toBe(JSON.stringify(aggregateAttempts[1]));
    expect(aggregateAttempts.every((event) => (
      (event.metadata as { success?: unknown } | undefined)?.success === true
    ))).toBe(true);
  });

  it('resumes a persisted invalid winner without fetching or writing a now-valid loser', async () => {
    let providerPolls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        providerPolls++;
        return Response.json({
          status: 'completed',
          output_file_id: 'output-invalid-winner',
          usage: { input_tokens: 20, output_tokens: 2 },
        });
      }
      if (url.endsWith('/v1/files/output-invalid-winner/content')) {
        return new Response(`${JSON.stringify({
          custom_id: ' H-1 ',
          response: {
            status_code: 200,
            body: { choices: [{ message: { content: '{"transactions":[]}' } }] },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const {
      env,
      usageEvents,
      getStatus,
      getResultSummaryJson,
      getExtractionRunIds,
    } = makeEnv({ measuredUsageDeliveryFailures: 1 });
    const router = buildAdminRouter();

    const first = await router.request('/batch-status/job-123', { method: 'POST', headers: AUTH }, env);
    expect(first.status).toBe(503);
    expect(getStatus()).toBe('settling');
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toMatchObject({
      terminalDecision: { kind: 'invalid', reason: 'invalid_result_identity' },
    });

    const resumed = await router.request('/batch-status/job-123', { method: 'POST', headers: AUTH }, env);
    await expect(resumed.json()).resolves.toMatchObject({
      status: 'failed',
      summary: { terminalPayloadError: 'invalid_result_identity' },
    });
    expect(providerPolls).toBe(1);
    expect(getStatus()).toBe('failed');
    expect(getExtractionRunIds()).toHaveLength(0);
    const aggregateAttempts = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event?.label === 'batch-job-tokens' ? [event] : [];
    });
    expect(aggregateAttempts).toHaveLength(2);
    expect(JSON.stringify(aggregateAttempts[0])).toBe(JSON.stringify(aggregateAttempts[1]));
    expect(aggregateAttempts.every((event) => (
      (event.metadata as { success?: unknown } | undefined)?.success === false
    ))).toBe(true);
  });

  it.each([
    {
      label: 'per-result',
      winner: { state: 'accounting_planned', accountingPlan: { version: 1, tokenMode: 'per-result' } },
    },
    {
      label: 'aggregate',
      winner: {
        state: 'accounting_planned',
        accountingPlan: {
          version: 1,
          tokenMode: 'aggregate',
          aggregateUsage: { promptTokens: 500, completionTokens: 50 },
        },
      },
    },
  ])('rewrites an unversioned concurrent $label winner to legacy suppression', async ({ winner }) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-plan-race',
          usage: { input_tokens: 500, output_tokens: 50 },
        });
      }
      if (url.endsWith('/v1/files/output-plan-race/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getResultSummaryJson } = makeEnv({
      accountingPlanCasWinner: winner,
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    const measured = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event ? [event] : [];
    });
    expect(measured.filter((event) => event.label === 'batch-result-tokens')).toHaveLength(0);
    expect(measured.some((event) => event.label === 'batch-job-tokens')).toBe(false);
    const summary = JSON.parse(getResultSummaryJson() ?? 'null') as Record<string, unknown>;
    expect(summary.accountingPlan).toEqual({ version: 1, tokenMode: 'per-result' });
    expect(summary).toMatchObject({
      accountingProtocol: 1,
      legacyAccounting: 'per_result_compat',
      legacyAccountingAmbiguous: true,
      measuredUsageStatus: 'suppressed_unknown',
    });
    expect(summary).not.toHaveProperty('aggregateUsage');
  });

  it('honors a protocol-marked concurrent per-result accounting winner', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-current-plan-winner',
          usage: { input_tokens: 500, output_tokens: 50 },
        });
      }
      if (url.endsWith('/v1/files/output-current-plan-winner/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getResultSummaryJson } = makeEnv({
      accountingPlanCasWinner: {
        state: 'accounting_planned',
        accountingProtocol: 1,
        accountingPlan: { version: 1, tokenMode: 'per-result' },
      },
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    const measured = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event?.label === 'batch-result-tokens' ? [event] : [];
    });
    expect(measured).toHaveLength(1);
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).not.toHaveProperty('legacyAccounting');
  });

  it('rewrites a protocol-marked legacy aggregate marker to suppressed per-result accounting', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed', output_file_id: 'output-corrupt-marker' });
      }
      if (url.endsWith('/v1/files/output-corrupt-marker/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getResultSummaryJson } = makeEnv({
      initialResultSummary: {
        state: 'accounting_planned',
        accountingProtocol: 1,
        legacyAccounting: 'per_result_compat',
        accountingPlan: {
          version: 1,
          tokenMode: 'aggregate',
          aggregateUsage: { promptTokens: 500, completionTokens: 50 },
        },
      },
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    expect(usageEvents.some((message) => (
      (message as { event?: { label?: unknown } }).event?.label === 'batch-job-tokens'
    ))).toBe(false);
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toMatchObject({
      accountingPlan: { version: 1, tokenMode: 'per-result' },
      legacyAccounting: 'per_result_compat',
      measuredUsageStatus: 'suppressed_unknown',
    });
  });

  it('emits no measured units or extraction rows when an accounting plan cannot be claimed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-plan-blocked',
          usage: { input_tokens: 500, output_tokens: 50 },
        });
      }
      if (url.endsWith('/v1/files/output-plan-blocked/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getExtractionRunIds } = makeEnv({
      accountingPlanCasWinner: { invalid: true },
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(503);
    expect(getExtractionRunIds()).toHaveLength(0);
    expect(usageEvents.some((message) => {
      const label = (message as { event?: { label?: unknown } }).event?.label;
      return label === 'batch-result-tokens' || label === 'batch-job-tokens';
    })).toBe(false);
  });

  it('records xAI batch exact spend and attachment-search usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-xai')) {
        return Response.json({ state: { num_pending: 0, num_requests: 1, num_error: 0 } });
      }
      if (url.includes('/v1/batches/batch-xai/results')) {
        return Response.json({
          results: [{
            batch_request_id: 'H-1',
            batch_result: {
              response: {
                responses: {
                  output_text: '{"transactions":[]}',
                  usage: {
                    input_tokens: 200,
                    output_tokens: 40,
                    input_tokens_details: { cached_tokens: 50 },
                    cost_in_usd_ticks: 321_000_000,
                    num_server_side_tools_used: 2,
                  },
                },
              },
            },
          }],
          pagination_token: null,
        });
      }
      return new Response('not found', { status: 404 });
    }));

    const { env, usageEvents, getUsageJson, getCompletedAt } = makeEnv({
      provider: 'xai',
      model: 'grok-4.3',
      providerBatchId: 'batch-xai',
    });
    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST',
      headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    expect(JSON.parse(getUsageJson()!)).toMatchObject({
      costInUsdTicks: 321_000_000,
      attachmentSearchCalls: 2,
    });
    const expectedCostKey = await stableMeasuredUsageIdempotencyKey(
      'batch-result', 'cost', 'job-123', 'H-1',
    );
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: expectedCostKey,
        provider: 'xai',
        label: 'batch-result-provider-cost',
        occurredAt: getCompletedAt(),
        costUsd: 0.0321,
        quantity: 0.0321,
        unit: 'usd',
      }),
    }));
    const expectedAttachmentKey = await stableMeasuredUsageIdempotencyKey(
      'batch-result', 'attachment-search', 'job-123', 'H-1',
    );
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: expectedAttachmentKey,
        label: 'batch-result-attachment-search',
        occurredAt: getCompletedAt(),
        quantity: 2,
        unit: 'call',
      }),
    }));
  });

  it('keeps doc-keyed telemetry and the persisted terminal period stable across shuffled retries', async () => {
    const resultLine = (docId: string, promptTokens: number, completionTokens: number) => ({
      custom_id: docId,
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: '{"transactions":[]}' } }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          },
        },
      },
    });
    let contentPoll = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-shuffled',
          created_at: Date.parse('2026-07-13T23:59:00.000Z') / 1_000,
          completed_at: Date.parse('2026-07-14T00:01:00.000Z') / 1_000,
        });
      }
      if (url.endsWith('/v1/files/output-shuffled/content')) {
        const first = resultLine('H-A', 10, 1);
        const second = resultLine('H-B', 20, 2);
        const rows = contentPoll++ === 0 ? [first, second] : [second, first];
        return new Response(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getCompletedAt,
      getExtractionRunIds,
      getExtractionInsertSql,
    } = makeEnv({
      submittedAt: '2026-07-13T23:59:00.000Z',
      docIds: ['H-A', 'H-B'],
    });
    const router = buildAdminRouter();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const firstResponse = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    expect(firstResponse.status).toBe(200);
    expect(getCompletedAt()).toBe('2026-07-14T00:01:00.000Z');

    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const replayResponse = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    expect(replayResponse.status).toBe(200);

    const tokenEvents = usageEvents.flatMap((message) => {
      const candidate = message as { type?: string; event?: Record<string, unknown> };
      return candidate.type === 'usage.telemetry'
        && candidate.event?.label === 'batch-result-tokens'
        ? [candidate.event]
        : [];
    });
    expect(tokenEvents).toHaveLength(2);
    for (const quantity of [11, 22]) {
      const replays = tokenEvents.filter((event) => event.quantity === quantity);
      expect(replays).toHaveLength(1);
      expect(replays[0]?.occurredAt).toBe('2026-07-14T00:01:00.000Z');
      expect(replays[0]?.idempotencyKey).toMatch(/^ct-measured-[0-9a-f]{64}$/);
    }
    expect(new Set(tokenEvents.map((event) => event.idempotencyKey)).size).toBe(2);
    expect(tokenEvents.every((event) => event.occurredAt !== '2026-07-13T23:59:00.000Z')).toBe(true);
    const extractionRunIds = getExtractionRunIds();
    expect(extractionRunIds).toHaveLength(2);
    expect(new Set(extractionRunIds).size).toBe(2);
    expect(extractionRunIds.every((id) => /^ct-batch-run-[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(getExtractionInsertSql()).toHaveLength(2);
    expect(getExtractionInsertSql().every((sql) => /INSERT OR IGNORE INTO extraction_runs/i.test(sql))).toBe(true);
  });

  it('keeps the job retryable when a terminal result row cannot be persisted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed', output_file_id: 'output-retryable-insert' });
      }
      if (url.endsWith('/v1/files/output-retryable-insert/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getStatus,
      getExtractionRunIds,
    } = makeEnv({ extractionInsertFailures: 1 });
    const router = buildAdminRouter();

    const failedInsert = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(failedInsert.status).toBe(503);
    await expect(failedInsert.json()).resolves.toEqual({ error: 'batch results could not be persisted' });
    expect(getStatus()).toBe('settling');
    expect(getExtractionRunIds()).toHaveLength(0);
    expect(usageEvents.some((message) => {
      const label = (message as { event?: { label?: unknown } }).event?.label;
      return label === 'batch-result-tokens' || label === 'batch-job-tokens';
    })).toBe(false);

    const retry = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ status: 'completed' });
    expect(getExtractionRunIds()).toHaveLength(1);
    expect(usageEvents.some((message) => (
      (message as { event?: { label?: unknown } }).event?.label === 'batch-result-tokens'
    ))).toBe(true);
  });

  it('repairs malformed lifecycle timestamps inside the fenced terminal commit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-cas',
          created_at: Date.parse('2026-07-01T10:00:00.000Z') / 1_000,
          completed_at: Date.parse('2026-07-01T11:00:00.000Z') / 1_000,
        });
      }
      if (url.endsWith('/v1/files/output-cas/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getSubmittedAt, getCompletedAt } = makeEnv({
      submittedAt: 'legacy-bad-submitted',
      completedAt: 'legacy-bad-completed',
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ turnaroundMs: 3_600_000 });
    expect(getSubmittedAt()).toBe('2026-07-01T10:00:00.000Z');
    expect(getCompletedAt()).toBe('2026-07-01T11:00:00.000Z');
    const measured = usageEvents
      .map((message) => message as { type?: string; event?: Record<string, unknown> })
      .find((message) => message.event?.label === 'batch-result-tokens');
    expect(measured?.event?.occurredAt).toBe('2026-07-01T11:00:00.000Z');
  });

  it('repairs malformed lifecycle timestamps from provider-authored values', async () => {
    const providerSubmittedAt = '2026-07-01T10:00:00.000Z';
    const providerCompletedAt = '2026-07-01T11:00:00.000Z';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-provider-time',
          created_at: Date.parse(providerSubmittedAt) / 1_000,
          completed_at: Date.parse(providerCompletedAt) / 1_000,
        });
      }
      if (url.endsWith('/v1/files/output-provider-time/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, getSubmittedAt, getCompletedAt } = makeEnv({
      submittedAt: 'legacy-bad-submitted',
      completedAt: 'legacy-bad-completed',
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ turnaroundMs: 3_600_000 });
    expect(getSubmittedAt()).toBe(providerSubmittedAt);
    expect(getCompletedAt()).toBe(providerCompletedAt);
  });

  it('keeps a valid persisted completion ahead of a different provider terminal time', async () => {
    const persistedSubmittedAt = '2026-07-04T10:00:00.000Z';
    const persistedCompletedAt = '2026-07-04T11:00:00.000Z';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-persisted-time',
          created_at: Date.parse('2026-07-01T10:00:00.000Z') / 1_000,
          completed_at: Date.parse('2026-07-01T11:00:00.000Z') / 1_000,
        });
      }
      if (url.endsWith('/v1/files/output-persisted-time/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, usageEvents, getCompletedAt } = makeEnv({
      submittedAt: persistedSubmittedAt,
      completedAt: persistedCompletedAt,
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ turnaroundMs: 3_600_000 });
    expect(getCompletedAt()).toBe(persistedCompletedAt);
    const measured = usageEvents
      .map((message) => message as { event?: Record<string, unknown> })
      .find((message) => message.event?.label === 'batch-result-tokens');
    expect(measured?.event?.occurredAt).toBe(persistedCompletedAt);
  });

  it('falls back to zero duration when provider submission is later than completion', async () => {
    const providerCompletedAt = '2026-07-01T11:00:00.000Z';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-inconsistent-time',
          created_at: Date.parse('2026-07-01T12:00:00.000Z') / 1_000,
          completed_at: Date.parse(providerCompletedAt) / 1_000,
        });
      }
      if (url.endsWith('/v1/files/output-inconsistent-time/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, getSubmittedAt, getCompletedAt } = makeEnv({
      submittedAt: 'legacy-bad-submitted',
      completedAt: 'legacy-bad-completed',
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ turnaroundMs: 0, turnaroundMin: 0 });
    expect(getSubmittedAt()).toBe(providerCompletedAt);
    expect(getCompletedAt()).toBe(providerCompletedAt);
  });

  it.each(['not-json', 'null'])('meters trusted aggregate usage before durably failing malformed terminal payload %s', async (line) => {
    const providerSubmittedAt = '2026-07-13T12:00:00.000Z';
    const providerCompletedAt = '2026-07-13T12:03:00.000Z';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'output-malformed',
          created_at: Date.parse(providerSubmittedAt) / 1_000,
          completed_at: Date.parse(providerCompletedAt) / 1_000,
          usage: {
            input_tokens: 90,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 20 },
          },
        });
      }
      if (url.endsWith('/v1/files/output-malformed/content')) {
        return new Response(`${line}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getStatus,
      getJobError,
      getResultSummaryJson,
      getCompletedAt,
      getExtractionRunIds,
    } = makeEnv();

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'failed',
      summary: {
        docs: 0,
        expectedDocs: 1,
        returnedDocs: 0,
        missingDocs: 1,
        providerStatus: 'completed',
        terminalPayloadError: 'malformed_result_jsonl',
        errorCount: 2,
      },
    });
    expect(getStatus()).toBe('failed');
    expect(getJobError()).toBe('malformed_result_jsonl');
    expect(getResultSummaryJson()).toContain('malformed_result_jsonl');
    expect(getCompletedAt()).toBe(providerCompletedAt);
    expect(getExtractionRunIds()).toHaveLength(0);
    const aggregateEvents = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event?.label === 'batch-job-tokens' ? [event] : [];
    });
    expect(aggregateEvents).toHaveLength(1);
    expect(aggregateEvents[0]).toMatchObject({
      occurredAt: providerCompletedAt,
      quantity: 100,
      metadata: {
        promptTokens: 90,
        completionTokens: 10,
        cachedTokens: 20,
        success: false,
      },
    });
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toMatchObject({
      accountingProtocol: 1,
      accountingPlan: {
        version: 1,
        tokenMode: 'aggregate',
        aggregateUsage: { promptTokens: 90, completionTokens: 10, cachedTokens: 20 },
      },
      aggregateUsage: { promptTokens: 90, completionTokens: 10, cachedTokens: 20 },
    });
  });

  it('retains prior-file identities and safe Batch errors when a later result file is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'failed',
          output_file_id: 'output-before-malformed',
          error_file_id: 'error-malformed',
          errors: { data: [{ code: 'batch_expired' }, { code: 'rate_limit_exceeded' }] },
        });
      }
      if (url.endsWith('/v1/files/output-before-malformed/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-1',
          error: { code: 'request_failed' },
        })}\n`);
      }
      if (url.endsWith('/v1/files/error-malformed/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-2',
          error: { code: 'request_failed' },
        })}\nnot-json\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, getExtractionRunIds } = makeEnv({ docIds: ['H-1', 'H-2', 'H-3'] });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      summary: {
        returnedDocs: 2,
        recognizedDocs: 2,
        missingDocs: 1,
        terminalPayloadError: 'malformed_result_jsonl',
        providerErrorCount: 2,
        providerErrors: ['batch_expired', 'rate_limit_exceeded'],
        errorCount: 4,
      },
    });
    expect(getExtractionRunIds()).toHaveLength(0);
  });

  it('keeps terminal result-file HTTP failures retryable without settling the app job', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed', output_file_id: 'output-transient' });
      }
      if (url.endsWith('/v1/files/output-transient/content')) {
        return new Response('temporary outage', { status: 503 });
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getStatus,
      getResultSummaryJson,
      getCompletedAt,
      getExtractionRunIds,
    } = makeEnv();

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(502);
    expect(getStatus()).toBe('running');
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toEqual({
      state: 'accounting_pending',
      accountingProtocol: 1,
    });
    expect(getCompletedAt()).toBeNull();
    expect(getExtractionRunIds()).toHaveLength(0);
    expect(usageEvents.some((message) => {
      const label = (message as { event?: { label?: unknown } }).event?.label;
      return label === 'batch-result-tokens' || label === 'batch-job-tokens';
    })).toBe(false);
  });

  it('rejects noncanonical stored document ids before polling the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { env, getStatus } = makeEnv({ docIds: [' H-1 '] });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'job has invalid document ids' });
    expect(getStatus()).toBe('running');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'blank',
      docIds: ['   '],
      invalidResultDocIdCount: 1,
      duplicateResultDocIdCount: 0,
      expectedMissingDocs: 1,
    },
    {
      label: 'whitespace-mutated duplicate',
      docIds: ['H-duplicate', ' H-duplicate '],
      invalidResultDocIdCount: 1,
      duplicateResultDocIdCount: 0,
      expectedMissingDocs: 1,
    },
    {
      label: 'non-string',
      docIds: [7],
      invalidResultDocIdCount: 1,
      duplicateResultDocIdCount: 0,
      expectedMissingDocs: 1,
    },
    {
      label: 'duplicate expected id',
      docIds: ['H-1', 'H-1'],
      invalidResultDocIdCount: 0,
      duplicateResultDocIdCount: 1,
      expectedMissingDocs: 0,
    },
  ])('rejects $label terminal result ids before persistence or metering', async ({
    docIds,
    invalidResultDocIdCount,
    duplicateResultDocIdCount,
    expectedMissingDocs,
  }) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed', output_file_id: 'output-invalid' });
      }
      if (url.endsWith('/v1/files/output-invalid/content')) {
        return new Response(`${docIds.map((custom_id) => JSON.stringify({
          custom_id,
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          },
        })).join('\n')}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getUsageJson,
      getResultSummaryJson,
      getCompletedAt,
      getStatus,
      getJobError,
      getExtractionRunIds,
    } = makeEnv();

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'failed',
      summary: {
        docs: 0,
        expectedDocs: 1,
        returnedDocs: docIds.length,
        missingDocs: expectedMissingDocs,
        providerStatus: 'completed',
        terminalPayloadError: 'invalid_result_identity',
        errorCount: invalidResultDocIdCount + duplicateResultDocIdCount + expectedMissingDocs,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('H-duplicate');
    expect(getUsageJson()).toBeUndefined();
    expect(getStatus()).toBe('failed');
    expect(getJobError()).toBe('invalid_result_identity');
    expect(getCompletedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getResultSummaryJson()).toContain('invalid_result_identity');
    expect(getExtractionRunIds()).toHaveLength(0);
    expect(usageEvents.some((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return typeof event?.label === 'string' && event.label.startsWith('batch-result-');
    })).toBe(false);
  });

  it('pins aggregate usage and provider lifecycle timestamps across invalid-identity settlement retries', async () => {
    const providerSubmittedAt = '2026-07-13T15:00:00.000Z';
    const providerCompletedAt = '2026-07-13T15:02:00.000Z';
    let pollCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        const replay = pollCount++ > 0;
        return Response.json({
          status: 'completed',
          output_file_id: 'output-invalid-aggregate',
          created_at: Date.parse(providerSubmittedAt) / 1_000,
          completed_at: Date.parse(providerCompletedAt) / 1_000,
          usage: {
            input_tokens: replay ? 900 : 90,
            output_tokens: replay ? 100 : 10,
          },
        });
      }
      if (url.endsWith('/v1/files/output-invalid-aggregate/content')) {
        return new Response(`${JSON.stringify({
          custom_id: ' H-1 ',
          response: {
            status_code: 200,
            body: { choices: [{ message: { content: '{"transactions":[]}' } }] },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getResultSummaryJson,
      getSubmittedAt,
      getCompletedAt,
    } = makeEnv({ submittedAt: null });
    const router = buildAdminRouter();

    const first = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      status: 'failed',
      summary: { terminalPayloadError: 'invalid_result_identity' },
    });
    const replay = await router.request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    await expect(replay.json()).resolves.toMatchObject({ status: 'failed', alreadyFinished: true });

    const aggregateEvents = usageEvents.flatMap((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return event?.label === 'batch-job-tokens' ? [event] : [];
    });
    expect(aggregateEvents).toHaveLength(1);
    expect(aggregateEvents[0]).toMatchObject({ quantity: 100, occurredAt: providerCompletedAt });
    expect(getSubmittedAt()).toBe(providerSubmittedAt);
    expect(getCompletedAt()).toBe(providerCompletedAt);
    expect(JSON.parse(getResultSummaryJson() ?? 'null')).toMatchObject({
      terminalPayloadError: 'invalid_result_identity',
      accountingPlan: {
        version: 1,
        tokenMode: 'aggregate',
        aggregateUsage: { promptTokens: 90, completionTokens: 10 },
      },
      aggregateUsage: { promptTokens: 90, completionTokens: 10 },
    });
  });

  it('rejects a validly-shaped result outside the submitted document set before writes or measured usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed', output_file_id: 'output-unknown' });
      }
      if (url.endsWith('/v1/files/output-unknown/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-unknown',
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: '{"transactions":[]}' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
          },
        })}\n`);
      }
      return new Response('not found', { status: 404 });
    }));
    const {
      env,
      usageEvents,
      getUsageJson,
      getResultSummaryJson,
      getCompletedAt,
      getStatus,
      getExtractionRunIds,
    } = makeEnv({
      docIds: ['H-1'],
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      summary: {
        docs: 0,
        expectedDocs: 1,
        returnedDocs: 1,
        missingDocs: 1,
        terminalPayloadError: 'unknown_result_identity',
        errorCount: 2,
      },
    });
    expect(getUsageJson()).toBeUndefined();
    expect(getResultSummaryJson()).toContain('unknown_result_identity');
    expect(getCompletedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getStatus()).toBe('failed');
    expect(getExtractionRunIds()).toHaveLength(0);
    expect(usageEvents.some((message) => {
      const label = (message as { event?: { label?: unknown } }).event?.label;
      return label === 'batch-result-tokens' || label === 'batch-job-tokens';
    })).toBe(false);
  });

  it('closes a completed no-file batch with durable expected and missing-result summary counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({ status: 'completed' });
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, getResultSummaryJson } = makeEnv({ docIds: ['H-1', 'H-2'] });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    const payload = await response.json() as { summary?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.summary).toMatchObject({
      docs: 0,
      expectedDocs: 2,
      returnedDocs: 0,
      missingDocs: 2,
      providerStatus: 'completed',
      errorCount: 2,
      errors: [
        'H-1: missing provider result',
        'H-2: missing provider result',
      ],
    });
    const resultSummaryJson = getResultSummaryJson();
    expect(resultSummaryJson).toBeTypeOf('string');
    expect(JSON.parse(resultSummaryJson ?? 'null')).toEqual(payload.summary);
  });

  it('counts and safely summarizes Batch-object inline errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-123')) {
        return Response.json({
          status: 'failed',
          errors: {
            data: [
              { code: 'batch_expired', message: 'must not be persisted' },
              { code: 'unsafe / code', message: 'must not be persisted either' },
            ],
          },
        });
      }
      return new Response('not found', { status: 404 });
    }));
    const { env, getResultSummaryJson } = makeEnv();

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    const payload = await response.json() as { summary?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.summary).toMatchObject({
      providerStatus: 'failed',
      providerErrorCount: 2,
      providerErrors: ['batch_expired', 'provider_error'],
      missingDocs: 1,
      errorCount: 3,
      errors: [
        'provider batch error: batch_expired',
        'provider batch error: provider_error',
        'H-1: missing provider result',
      ],
    });
    expect(getResultSummaryJson()).not.toContain('must not be persisted');
  });
});
