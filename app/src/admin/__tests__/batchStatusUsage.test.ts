import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAdminRouter } from '../routes';

const AUTH = { Authorization: 'Bearer test-admin' };

function makeEnv(jobOverrides: { provider?: string; model?: string; providerBatchId?: string } = {}) {
  let usageJson: string | null | undefined;
  const usageEvents: unknown[] = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/FROM batch_jobs WHERE id = \?/i.test(sql)) {
        return {
          id: 'job-123',
          provider: jobOverrides.provider ?? 'openai',
          model: jobOverrides.model ?? 'gpt-4o',
          provider_batch_id: jobOverrides.providerBatchId ?? 'batch-123',
          doc_ids: '["H-1"]',
          status: 'running',
          submitted_at: '2026-07-13T12:00:00.000Z',
        } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
    async run() {
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
  return { env, usageEvents, getUsageJson: () => usageJson };
}

describe('POST /batch-status/:jobId usage accounting', () => {
  afterEach(() => vi.unstubAllGlobals());

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

    const { env, usageEvents, getUsageJson } = makeEnv();
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
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: 'ct-batch-job-123-0-tokens',
        provider: 'openai',
        service: 'llm-batch',
        label: 'batch-result-tokens',
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

    const { env, usageEvents, getUsageJson } = makeEnv();
    const response = await buildAdminRouter().request('/batch-status/job-123', {
      method: 'POST',
      headers: AUTH,
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'failed', summary: { docs: 1, ok: 1 } });
    expect(JSON.parse(getUsageJson()!)).toEqual({ promptTokens: 41, completionTokens: 7, cachedTokens: 5 });
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: 'ct-batch-job-123-0-tokens',
        label: 'batch-result-tokens',
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

    const { env, usageEvents, getUsageJson } = makeEnv({
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
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: 'ct-batch-job-123-0-cost',
        provider: 'xai',
        label: 'batch-result-provider-cost',
        costUsd: 0.0321,
        quantity: 0.0321,
        unit: 'usd',
      }),
    }));
    expect(usageEvents).toContainEqual(expect.objectContaining({
      type: 'usage.telemetry',
      event: expect.objectContaining({
        idempotencyKey: 'ct-batch-job-123-0-attachment-search',
        label: 'batch-result-attachment-search',
        quantity: 2,
        unit: 'call',
      }),
    }));
  });
});
