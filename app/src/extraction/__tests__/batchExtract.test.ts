import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Env, QueueMessage } from '../../shared/types';
import { withThirdPartyTelemetry } from '../../shared/thirdPartyTelemetry';
import {
  batchPrompt,
  decodeAnthropicLine,
  decodeOpenAiLine,
  decodeMistralLine,
  decodeXaiResult,
  parseJsonl,
  isBatchProvider,
  normalizeBatchChamber,
  BatchTerminalPayloadError,
  parseOpenAiBatchUsage,
  parseOpenAiBatchTimestamps,
  pollBatch,
  submitBatch,
} from '../batchExtract';
import { EXECUTIVE_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../visionLlm';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parseJsonl', () => {
  it('parses non-blank JSON lines and skips garbage', () => {
    const out = parseJsonl('{"a":1}\n\n  \nnot json\n{"b":2}');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('isBatchProvider', () => {
  it('accepts the four supported providers only', () => {
    for (const p of ['anthropic', 'openai', 'mistral', 'xai']) expect(isBatchProvider(p)).toBe(true);
    for (const p of ['gemini', 'cohere', '', null, 42]) expect(isBatchProvider(p)).toBe(false);
  });
});

describe('batch chamber prompts', () => {
  it('uses the Executive OGE prompt for Executive filings and congressional prompt otherwise', () => {
    expect(normalizeBatchChamber('executive', 'unknown')).toBe('executive');
    expect(normalizeBatchChamber(null, 'E-278T-1')).toBe('executive');
    expect(normalizeBatchChamber(null, 'S-1')).toBe('senate');
    expect(normalizeBatchChamber(null, 'H-1')).toBe('house');
    expect(batchPrompt('executive', 'object')).toContain(EXECUTIVE_SYSTEM_PROMPT);
    expect(batchPrompt('executive', 'object')).not.toContain(SYSTEM_PROMPT);
    expect(batchPrompt('house', 'array')).toContain(SYSTEM_PROMPT);
    expect(batchPrompt('senate', 'array')).toContain(SYSTEM_PROMPT);
  });

  it('embeds the Executive prompt in a submitted Executive batch request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: 'batch-executive' }));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

    await expect(submitBatch(
      { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env,
      'anthropic',
      'claude-haiku-4-5',
      [{ docId: 'E-278T-1', chamber: 'executive', bytes }],
    )).resolves.toBe('batch-executive');

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.requests[0].params.messages[0].content[1].text)
      .toContain(EXECUTIVE_SYSTEM_PROMPT);
  });
});

describe('decodeXaiResult', () => {
  it('decodes a chat_get_completion result into rows', () => {
    const item = {
      batch_request_id: 'H-7',
      batch_result: { response: { chat_get_completion: {
        choices: [{ message: { content: '{"transactions":[{"ticker":"NVDA","assetName":"Nvidia","txType":"P","amountRange":"$1,001 - $15,000"}]}' } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 20 },
          cost_in_usd_ticks: 321_000_000,
          num_server_side_tools_used: 2,
        },
      } } },
    };
    const r = decodeXaiResult(item);
    expect(r).toMatchObject({ docId: 'H-7', ok: true });
    expect(r.rows[0].ticker).toBe('NVDA');
    expect(r.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cachedTokens: 20,
      costInUsdTicks: 321_000_000,
      attachmentSearchCalls: 2,
    });
  });

  it('decodes a responses-shaped result via output_text', () => {
    const item = {
      batch_request_id: 'H-8',
      batch_result: { response: { responses: {
        output_text: '[{"ticker":"AMD","assetName":"AMD","txType":"S","amountRange":"$1,001 - $15,000"}]',
        usage: { input_tokens: 200, output_tokens: 40, input_tokens_details: { cached_tokens: 50 } },
      } } },
    };
    const r = decodeXaiResult(item);
    expect(r.rows[0].ticker).toBe('AMD');
    expect(r.usage).toEqual({ promptTokens: 200, completionTokens: 40, cachedTokens: 50 });
  });
});

describe('decodeAnthropicLine', () => {
  it('decodes a succeeded message into rows', () => {
    const line = {
      custom_id: 'H-1',
      result: {
        type: 'succeeded',
        message: {
          content: [{ type: 'text', text: '[{"ticker":"AAPL","assetName":"Apple","txType":"P","amountRange":"$1,001 - $15,000"}]' }],
          usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 100 },
        },
      },
    };
    const r = decodeAnthropicLine(line);
    expect(r).toMatchObject({ docId: 'H-1', ok: true });
    expect(r.rows[0]).toMatchObject({ ticker: 'AAPL', txType: 'P' });
    expect(r.usage).toEqual({ promptTokens: 300, completionTokens: 60, cachedTokens: 100 });
  });

  it('marks an errored line as not ok', () => {
    const r = decodeAnthropicLine({ custom_id: 'H-2', result: { type: 'errored', error: { type: 'overloaded' } } });
    expect(r).toMatchObject({ docId: 'H-2', ok: false });
    expect(r.rows).toHaveLength(0);
  });
});

describe('pollBatch Anthropic lifecycle timestamps', () => {
  it('propagates provider RFC3339 times even when the terminal batch is polled late', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
    const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/batch-late/results';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/messages/batches/batch-late')) {
        return Response.json({
          processing_status: 'ended',
          results_url: resultsUrl,
          created_at: '2026-06-01T10:00:00+00:00',
          ended_at: '2026-06-02T10:00:00Z',
        });
      }
      if (url === resultsUrl) return new Response('');
      throw new Error(`unexpected fetch: ${url}`);
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));

    await expect(withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'anthropic', 'batch-late'),
    )).resolves.toMatchObject({
      done: true,
      status: 'ended',
      submittedAt: '2026-06-01T10:00:00.000Z',
      terminalAt: '2026-06-02T10:00:00.000Z',
    });
  });

  it('fails soft on invalid RFC3339 values and never trusts a nonterminal ended_at', async () => {
    const env = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;
    const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/batch-invalid/results';
    let statusPoll = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === resultsUrl) return new Response('');
      statusPoll++;
      return Response.json(statusPoll === 1 ? {
        processing_status: 'in_progress',
        created_at: '2026-06-01T10:00:00Z',
        ended_at: '2026-06-02T10:00:00Z',
      } : {
        processing_status: 'ended',
        results_url: resultsUrl,
        created_at: '2026-02-30T10:00:00Z',
        ended_at: 'not-a-date',
      });
    }));

    const nonterminal = await pollBatch(env, 'anthropic', 'batch-running');
    expect(nonterminal.submittedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(nonterminal).not.toHaveProperty('terminalAt');
    const invalid = await pollBatch(env, 'anthropic', 'batch-invalid');
    expect(invalid).not.toHaveProperty('submittedAt');
    expect(invalid).not.toHaveProperty('terminalAt');
  });
});

describe('decodeOpenAiLine', () => {
  it('decodes a chat-completions batch output line into rows', () => {
    const line = {
      custom_id: 'H-3',
      response: { status_code: 200, body: {
        choices: [{ message: { content: '{"transactions":[{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$1,001 - $15,000"}]}' } }],
        usage: { prompt_tokens: 400, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 110 } },
      } },
    };
    const r = decodeOpenAiLine(line);
    expect(r).toMatchObject({ docId: 'H-3', ok: true });
    expect(r.rows[0]).toMatchObject({ ticker: 'MSFT', txType: 'S' });
    expect(r.usage).toEqual({ promptTokens: 400, completionTokens: 80, cachedTokens: 110 });
  });

  it('marks a line with an error object as not ok', () => {
    const r = decodeOpenAiLine({ custom_id: 'H-4', error: { message: 'bad request' } });
    expect(r.ok).toBe(false);
    expect(r.usage).toBeUndefined();
  });

  it('retains billed usage when the model output cannot be parsed', () => {
    const r = decodeOpenAiLine({
      custom_id: 'H-parse',
      response: {
        status_code: 200,
        body: {
          choices: [{ message: { content: 'not json' } }],
          usage: { prompt_tokens: 41, completion_tokens: 7 },
        },
      },
    });
    expect(r).toMatchObject({ ok: false, usage: { promptTokens: 41, completionTokens: 7 } });
  });

  it('decodes bounded HTTP and response-body errors while retaining billed usage', () => {
    const r = decodeOpenAiLine({
      custom_id: 'H-http-error',
      response: {
        status_code: 429,
        body: {
          error: {
            code: 'rate_limit_exceeded',
            message: 'x'.repeat(1_000),
          },
          usage: { prompt_tokens: 9, completion_tokens: 0 },
        },
      },
    });
    expect(r).toMatchObject({
      docId: 'H-http-error',
      ok: false,
      usage: { promptTokens: 9, completionTokens: 0 },
    });
    expect(r.error).toContain('HTTP 429');
    expect(r.error).toContain('rate_limit_exceeded');
    expect(r.error?.length).toBeLessThanOrEqual(300);
  });
});

describe('OpenAI batch lifecycle timestamps', () => {
  it('uses the status-specific terminal field and parses documented Unix seconds', () => {
    const createdAt = Date.parse('2026-07-01T10:00:00.000Z') / 1_000;
    const completedAt = Date.parse('2026-07-01T11:00:00.000Z') / 1_000;
    const failedAt = Date.parse('2026-07-01T12:00:00.000Z') / 1_000;

    expect(parseOpenAiBatchTimestamps({
      status: 'completed',
      created_at: createdAt,
      completed_at: completedAt,
      failed_at: failedAt,
    })).toEqual({
      submittedAt: '2026-07-01T10:00:00.000Z',
      terminalAt: '2026-07-01T11:00:00.000Z',
    });
  });

  it('falls back only to another valid terminal field and ignores nonterminal stale fields', () => {
    const expiredAt = Date.parse('2026-07-02T11:00:00.000Z') / 1_000;
    expect(parseOpenAiBatchTimestamps({
      status: 'failed',
      created_at: 'not-a-number',
      failed_at: -1,
      expired_at: expiredAt,
    })).toEqual({ terminalAt: '2026-07-02T11:00:00.000Z' });
    expect(parseOpenAiBatchTimestamps({
      status: 'in_progress',
      completed_at: expiredAt,
    })).toEqual({});
    expect(parseOpenAiBatchTimestamps(null)).toEqual({});
    expect(parseOpenAiBatchTimestamps([])).toEqual({});
  });
});

describe('OpenAI batch aggregate usage', () => {
  it('accepts complete non-negative integer token totals and optional cached tokens', () => {
    expect(parseOpenAiBatchUsage({
      input_tokens: 300,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 120 },
    })).toEqual({ promptTokens: 300, completionTokens: 40, cachedTokens: 120 });
    expect(parseOpenAiBatchUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
    });
  });

  it.each([
    null,
    { input_tokens: 10 },
    { input_tokens: 10, output_tokens: -1 },
    { input_tokens: 10.5, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: 'invalid' },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 11 } },
  ])('fails soft for an incomplete or invalid aggregate: %j', (value) => {
    expect(parseOpenAiBatchUsage(value)).toBeUndefined();
  });
});

describe('pollBatch OpenAI terminal results', () => {
  it('closes a completed error-file-only batch and decodes failed documents', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-errors-only')) {
        return Response.json({ status: 'completed', error_file_id: 'file-errors' });
      }
      if (url.endsWith('/v1/files/file-errors/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-error',
          error: { message: 'request rejected' },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await expect(pollBatch(env, 'openai', 'batch-errors-only')).resolves.toMatchObject({
      done: true,
      failed: false,
      status: 'completed',
      results: [{ docId: 'H-error', ok: false, rows: [] }],
    });
  });

  it('closes a completed batch with neither result file', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.fn(async () => Response.json({ status: 'completed' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pollBatch(env, 'openai', 'batch-empty')).resolves.toEqual({
      done: true,
      failed: false,
      status: 'completed',
      results: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('merges output and error files in stable output-first order', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-mixed')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'file-output',
          error_file_id: 'file-errors',
        });
      }
      if (url.endsWith('/v1/files/file-output/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-output',
          response: {
            status_code: 200,
            body: { choices: [{ message: { content: '{"transactions":[]}' } }] },
          },
        })}\n`);
      }
      if (url.endsWith('/v1/files/file-errors/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-error',
          error: { message: 'request rejected' },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const poll = await pollBatch(env, 'openai', 'batch-mixed');
    expect(poll).toMatchObject({ done: true, failed: false, status: 'completed' });
    expect(poll.results.map((result) => [result.docId, result.ok])).toEqual([
      ['H-output', true],
      ['H-error', false],
    ]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.openai.com/v1/batches/batch-mixed',
      'https://api.openai.com/v1/files/file-output/content',
      'https://api.openai.com/v1/files/file-errors/content',
    ]);
  });

  it('fetches an identical nonempty output/error file id only once', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-same-file')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'file-shared',
          error_file_id: 'file-shared',
        });
      }
      if (url.endsWith('/v1/files/file-shared/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-once',
          error: { message: 'request rejected' },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const poll = await pollBatch(env, 'openai', 'batch-same-file');
    expect(poll.results).toHaveLength(1);
    expect(poll.results[0]).toMatchObject({ docId: 'H-once', ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects any malformed nonblank result JSONL line instead of dropping it', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const submittedAt = '2026-07-13T12:00:00.000Z';
    const terminalAt = '2026-07-13T12:01:00.000Z';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-malformed')) {
        return Response.json({
          status: 'completed',
          output_file_id: 'file-malformed',
          created_at: Date.parse(submittedAt) / 1_000,
          completed_at: Date.parse(terminalAt) / 1_000,
          usage: { input_tokens: 12, output_tokens: 3 },
          errors: {
            data: [
              { code: 'batch_expired', message: 'must not enter terminal context' },
              { code: 'unsafe / code', message: 'must not enter terminal context either' },
            ],
          },
        });
      }
      if (url.endsWith('/v1/files/file-malformed/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-valid',
          error: { message: 'request rejected' },
        })}\nnot-json\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const poll = pollBatch(env, 'openai', 'batch-malformed');
    await expect(poll).rejects.toBeInstanceOf(BatchTerminalPayloadError);
    await expect(poll).rejects.toMatchObject({
      code: 'malformed_result_jsonl',
      providerStatus: 'completed',
      context: {
        aggregateUsage: { promptTokens: 12, completionTokens: 3 },
        providerErrors: {
          count: 2,
          summaries: ['batch_expired', 'provider_error'],
        },
        returnedDocs: 1,
        observedDocIds: ['H-valid'],
        submittedAt,
        terminalAt,
      },
    });
  });

  it('preserves prior-file and pre-malformed identities when the later result file is invalid', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-late-malformed')) {
        return Response.json({
          status: 'failed',
          output_file_id: 'file-valid-output',
          error_file_id: 'file-partial-error',
          errors: {
            data: [{ code: 'batch_failed', message: 'arbitrary provider detail' }],
          },
        });
      }
      if (url.endsWith('/v1/files/file-valid-output/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-output',
          response: {
            status_code: 200,
            body: { choices: [{ message: { content: '{"transactions":[]}' } }] },
          },
        })}\n`);
      }
      if (url.endsWith('/v1/files/file-partial-error/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-error',
          error: { message: 'request rejected' },
        })}\nnot-json\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const poll = pollBatch(env, 'openai', 'batch-late-malformed');
    await expect(poll).rejects.toMatchObject({
      code: 'malformed_result_jsonl',
      providerStatus: 'failed',
      context: {
        providerErrors: { count: 1, summaries: ['batch_failed'] },
        returnedDocs: 2,
        observedDocIds: ['H-output', 'H-error'],
      },
    });
    await expect(poll).rejects.not.toMatchObject({
      context: { providerErrors: { summaries: ['arbitrary provider detail'] } },
    });
  });

  it('bounds observed identity context while retaining the exact decoded result count', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    const decodedLines = Array.from({ length: 201 }, (_, index) => JSON.stringify({
      custom_id: `H-${index + 1}`,
      error: { code: 'request_failed' },
    })).join('\n');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-context-bound')) {
        return Response.json({ status: 'completed', output_file_id: 'file-context-bound' });
      }
      if (url.endsWith('/v1/files/file-context-bound/content')) {
        return new Response(`${decodedLines}\nnot-json\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const poll = pollBatch(env, 'openai', 'batch-context-bound');
    await expect(poll).rejects.toMatchObject({
      context: {
        returnedDocs: 201,
        observedDocIdsTruncated: true,
      },
    });
    try {
      await poll;
      throw new Error('expected malformed terminal payload');
    } catch (error) {
      expect(error).toBeInstanceOf(BatchTerminalPayloadError);
      const typed = error as BatchTerminalPayloadError;
      expect(typed.context.observedDocIds).toHaveLength(200);
      expect(typed.context.observedDocIds?.[0]).toBe('H-1');
      expect(typed.context.observedDocIds?.[199]).toBe('H-200');
    }
  });

  it('counts Batch-object inline errors and retains only safe bounded codes', async () => {
    const env = { OPENAI_API_KEY: 'test-key' } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-inline-errors')) {
        return Response.json({
          status: 'failed',
          errors: {
            data: [
              { code: 'batch_expired', message: 'sensitive arbitrary message' },
              { code: 'not safe / code', message: 'another message' },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await expect(pollBatch(env, 'openai', 'batch-inline-errors')).resolves.toMatchObject({
      done: true,
      failed: true,
      status: 'failed',
      providerErrors: {
        count: 2,
        summaries: ['batch_expired', 'provider_error'],
      },
    });
  });

  it('returns completed requests from a failed batch output file for persistence and metering', async () => {
    const messages: QueueMessage[] = [];
    const env = {
      OPENAI_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: {
        send: vi.fn(async (message: QueueMessage) => {
          messages.push(message);
        }),
      },
    } as unknown as Env;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batches/batch-partial')) {
        return Response.json({
          status: 'expired',
          output_file_id: 'file-output',
          created_at: Date.parse('2026-06-01T10:00:00.000Z') / 1_000,
          expired_at: Date.parse('2026-06-02T10:00:00.000Z') / 1_000,
        });
      }
      if (url.endsWith('/v1/files/file-output/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-partial',
          response: {
            status_code: 200,
            body: {
              model: 'gpt-4o-2024-11-20',
              choices: [{
                message: {
                  content: '{"transactions":[{"ticker":"MSFT","assetName":"Microsoft","txType":"P","amountRange":"$1,001 - $15,000"}]}',
                },
              }],
              usage: {
                prompt_tokens: 41,
                completion_tokens: 7,
                prompt_tokens_details: { cached_tokens: 5 },
              },
            },
          },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));

    const result = await withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'openai', 'batch-partial'),
    );

    expect(result).toMatchObject({
      done: true,
      failed: true,
      status: 'expired',
      submittedAt: '2026-06-01T10:00:00.000Z',
      terminalAt: '2026-06-02T10:00:00.000Z',
      results: [{
        docId: 'H-partial',
        ok: true,
        resolvedModel: 'gpt-4o-2024-11-20',
        usage: { promptTokens: 41, completionTokens: 7, cachedTokens: 5 },
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messages.filter((message) => message.type === 'usage.telemetry')).toHaveLength(2);
  });
});

describe('decodeMistralLine', () => {
  it('decodes an OCR document_annotation into rows', () => {
    const line = {
      custom_id: 'H-5',
      response: { body: {
        document_annotation: JSON.stringify({ transactions: [{ ticker: 'TSLA', assetName: 'Tesla', txType: 'P', amountRange: '$1,001 - $15,000' }] }),
        usage_info: { pages_processed: 6 },
      } },
    };
    const r = decodeMistralLine(line);
    expect(r).toMatchObject({ docId: 'H-5', ok: true });
    expect(r.rows[0].ticker).toBe('TSLA');
    expect(r.usage).toEqual({ pagesProcessed: 6 });
  });

  it('also accepts the annotation directly on the line body', () => {
    const r = decodeMistralLine({ custom_id: 'H-6', body: { document_annotation: { transactions: [{ assetName: 'X', ticker: 'XOM', txType: 'P', amountRange: '$1,001 - $15,000' }] } } });
    expect(r.rows[0].ticker).toBe('XOM');
  });

  it('retains completed OCR pages exposed by a failed job output file', async () => {
    const env = {
      MISTRAL_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batch/jobs/job-partial')) {
        return Response.json({ status: 'FAILED', output_file: 'output-partial' });
      }
      if (url.endsWith('/v1/files/output-partial/content')) {
        return new Response(`${JSON.stringify({
          custom_id: 'H-partial',
          response: { body: { document_annotation: { transactions: [] }, usage_info: { pages_processed: 4 } } },
        })}\n`);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await expect(withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'mistral', 'job-partial'),
    )).resolves.toMatchObject({
      done: true,
      failed: true,
      status: 'FAILED',
      results: [{ docId: 'H-partial', ok: true, usage: { pagesProcessed: 4 } }],
    });
  });

  it('propagates provider Unix-second times even when the terminal job is polled late', async () => {
    const env = {
      MISTRAL_API_KEY: 'test-key',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
    const createdAt = Date.parse('2026-06-01T10:00:00.000Z') / 1_000;
    const completedAt = Date.parse('2026-06-02T10:00:00.000Z') / 1_000;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/batch/jobs/job-late')) {
        return Response.json({
          status: 'SUCCESS',
          output_file: 'output-late',
          created_at: createdAt,
          completed_at: completedAt,
        });
      }
      if (url.endsWith('/v1/files/output-late/content')) return new Response('');
      throw new Error(`unexpected fetch: ${url}`);
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));

    await expect(withThirdPartyTelemetry(
      env,
      () => pollBatch(env, 'mistral', 'job-late'),
    )).resolves.toMatchObject({
      done: true,
      status: 'SUCCESS',
      submittedAt: '2026-06-01T10:00:00.000Z',
      terminalAt: '2026-06-02T10:00:00.000Z',
    });
  });

  it('fails soft on invalid Unix seconds and never trusts nonterminal completed_at', async () => {
    const env = { MISTRAL_API_KEY: 'test-key' } as unknown as Env;
    const createdAt = Date.parse('2026-06-01T10:00:00.000Z') / 1_000;
    const completedAt = Date.parse('2026-06-02T10:00:00.000Z') / 1_000;
    let statusPoll = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/files/output-invalid/content')) return new Response('');
      statusPoll++;
      return Response.json(statusPoll === 1 ? {
        status: 'RUNNING',
        created_at: createdAt,
        completed_at: completedAt,
      } : {
        status: 'SUCCESS',
        output_file: 'output-invalid',
        created_at: 1.5,
        completed_at: 'not-an-integer',
      });
    }));

    const nonterminal = await pollBatch(env, 'mistral', 'job-running');
    expect(nonterminal.submittedAt).toBe('2026-06-01T10:00:00.000Z');
    expect(nonterminal).not.toHaveProperty('terminalAt');
    const invalid = await pollBatch(env, 'mistral', 'job-invalid');
    expect(invalid).not.toHaveProperty('submittedAt');
    expect(invalid).not.toHaveProperty('terminalAt');
  });
});
