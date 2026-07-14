import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAdminRouter } from '../routes';
import { stableMeasuredUsageIdempotencyKey } from '../../shared/thirdPartyTelemetry';

const AUTH = { Authorization: 'Bearer test-admin' };

function makeEnv(jobOverrides: {
  provider?: string;
  model?: string;
  providerBatchId?: string;
  submittedAt?: string | null;
  completedAt?: string | null;
  completionCasWinner?: string;
  submissionCasWinner?: string;
} = {}) {
  let usageJson: string | null | undefined;
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
      if (/SELECT completed_at FROM batch_jobs/i.test(sql)) {
        return { completed_at: completedAt } as T;
      }
      if (/FROM batch_jobs WHERE id = \?/i.test(sql)) {
        return {
          id: 'job-123',
          provider: jobOverrides.provider ?? 'openai',
          model: jobOverrides.model ?? 'gpt-4o',
          provider_batch_id: jobOverrides.providerBatchId ?? 'batch-123',
          doc_ids: '["H-1"]',
          status: 'running',
          submitted_at: submittedAt,
          completed_at: completedAt,
        } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
    async run() {
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
      if (/INSERT INTO extraction_runs/i.test(sql)) {
        usageJson = this.params[11] == null ? null : String(this.params[11]);
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    ADMIN_TOKEN: 'test-admin',
    OPENAI_API_KEY: 'test-openai-key',
    XAI_API_KEY: 'test-xai-key',
    DB: { prepare } as unknown as D1Database,
    INGEST_QUEUE: {
      send: vi.fn(async (message: unknown) => { usageEvents.push(message); }),
    },
  } as never;
  return {
    env,
    usageEvents,
    getUsageJson: () => usageJson,
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
          custom_id: ' H-1 ',
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
    const { env, usageEvents, getCompletedAt } = makeEnv({
      submittedAt: '2026-07-13T23:59:00.000Z',
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
    expect(tokenEvents).toHaveLength(4);
    for (const quantity of [11, 22]) {
      const replays = tokenEvents.filter((event) => event.quantity === quantity);
      expect(replays).toHaveLength(2);
      expect(JSON.stringify(replays[0])).toBe(JSON.stringify(replays[1]));
      expect(replays[0]?.occurredAt).toBe('2026-07-14T00:01:00.000Z');
      expect(replays[0]?.idempotencyKey).toMatch(/^ct-measured-[0-9a-f]{64}$/);
    }
    expect(new Set(tokenEvents.map((event) => event.idempotencyKey)).size).toBe(2);
    expect(tokenEvents.every((event) => event.occurredAt !== '2026-07-13T23:59:00.000Z')).toBe(true);
  });

  it('CAS-repairs malformed lifecycle timestamps without overwriting concurrent valid winners', async () => {
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
    const completionWinner = '2026-07-03T12:00:00.000Z';
    const submissionWinner = '2026-07-03T11:00:00.000Z';
    const { env, usageEvents, getSubmittedAt, getCompletedAt } = makeEnv({
      submittedAt: 'legacy-bad-submitted',
      completedAt: 'legacy-bad-completed',
      completionCasWinner: completionWinner,
      submissionCasWinner: submissionWinner,
    });

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ turnaroundMs: 3_600_000 });
    expect(getSubmittedAt()).toBe(submissionWinner);
    expect(getCompletedAt()).toBe(completionWinner);
    const measured = usageEvents
      .map((message) => message as { type?: string; event?: Record<string, unknown> })
      .find((message) => message.event?.label === 'batch-result-tokens');
    expect(measured?.event?.occurredAt).toBe(completionWinner);
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

  it.each([
    {
      label: 'blank',
      docIds: ['   '],
      invalidResultDocIdCount: 1,
      duplicateResultDocIdCount: 0,
    },
    {
      label: 'duplicate after trimming',
      docIds: ['H-duplicate', ' H-duplicate '],
      invalidResultDocIdCount: 0,
      duplicateResultDocIdCount: 1,
    },
    {
      label: 'non-string',
      docIds: [7],
      invalidResultDocIdCount: 1,
      duplicateResultDocIdCount: 0,
    },
  ])('rejects $label terminal result ids before persistence or metering', async ({
    docIds,
    invalidResultDocIdCount,
    duplicateResultDocIdCount,
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
    const { env, usageEvents, getUsageJson, getCompletedAt } = makeEnv();

    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST', headers: AUTH,
    }, env);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(502);
    expect(payload).toEqual({
      error: 'batch provider returned invalid result identities',
      resultCount: docIds.length,
      invalidResultDocIdCount,
      duplicateResultDocIdCount,
    });
    expect(JSON.stringify(payload)).not.toContain('H-duplicate');
    expect(getUsageJson()).toBeUndefined();
    expect(getCompletedAt()).toBeNull();
    expect(usageEvents.some((message) => {
      const event = (message as { event?: Record<string, unknown> }).event;
      return typeof event?.label === 'string' && event.label.startsWith('batch-result-');
    })).toBe(false);
  });
});
