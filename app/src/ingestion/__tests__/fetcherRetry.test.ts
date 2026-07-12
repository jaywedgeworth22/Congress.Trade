import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import {
  classifyTransientIngestError,
  fetchFiling,
  IngestRetryError,
  isRetryableFilingHttpStatus,
  retryAfterSeconds,
} from '../fetcher';

function envForFetch() {
  const updates: unknown[][] = [];
  const put = vi.fn(async (_key: string, _value: ArrayBuffer) => {
    // accept buffer
  });
  const send = vi.fn(async () => {});
  const env = {
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[], bind(...params: unknown[]) { this.params = params; return this; },
        async first<T>() {
          if (/FROM filings/i.test(sql)) return {
            doc_id: 'doc_1', chamber: 'house', source_url: 'https://example.com/doc.pdf', ingest_status: 'new',
          } as T;
          return null as T | null;
        },
        async run() { updates.push(this.params); return { success: true, meta: { changes: 1 } }; },
      }),
    } as unknown as D1Database,
    RAW_FILES: { put },
    INGEST_QUEUE: { send, sendBatch: vi.fn() },
  } as unknown as Env;
  return { env, put, send, updates };
}

describe('filing fetch retry status policy', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('retries timeout, early-data, rate-limit, and server responses', () => {
    for (const status of [408, 425, 429, 500, 503]) expect(isRetryableFilingHttpStatus(status)).toBe(true);
  });
  it('does not retry terminal client responses', () => {
    for (const status of [400, 401, 404, 422]) expect(isRetryableFilingHttpStatus(status)).toBe(false);
  });

  it('honors Retry-After and classifies later-stage provider throttles', () => {
    expect(retryAfterSeconds('120')).toBe(120);
    expect(retryAfterSeconds('Wed, 01 Jul 2026 00:02:00 GMT', Date.parse('2026-07-01T00:00:00Z'))).toBe(120);
    expect(classifyTransientIngestError(new Error('provider HTTP 429 retry-after: 45'), 3))
      .toMatchObject({ delaySeconds: 45 });
  });

  it('streams a normal response into R2 and advances the queue', async () => {
    const { env, put, send } = envForFetch();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('small filing', {
      status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '12' },
    })));
    await fetchFiling(env, 'doc_1');
    expect(put).toHaveBeenCalledWith('raw/doc_1', expect.any(ArrayBuffer), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    expect(send).toHaveBeenCalledWith({ type: 'filing.fetched', docId: 'doc_1' });
  });

  it('records an oversized Content-Length as terminal without queue retry', async () => {
    const { env, put, send, updates } = envForFetch();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('too large', {
      status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '99999999' },
    })));
    await expect(fetchFiling(env, 'doc_1')).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(updates.some((params) => String(params[0]).includes('exceeds'))).toBe(true);
  });

  it('records a chunked oversized upstream body without retrying the queue', async () => {
    const { env, put, send, updates } = envForFetch();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1));
        controller.close();
      },
      cancel() {},
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    await expect(fetchFiling(env, 'doc_1')).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(updates.some((params) => String(params[0]).includes('exceeds'))).toBe(true);
  });

  it('throws a typed delayed retry for a retryable HTTP response', async () => {
    const { env } = envForFetch();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', {
      status: 429, headers: { 'retry-after': '75' },
    })));
    await expect(fetchFiling(env, 'doc_1', 2)).rejects.toMatchObject({
      constructor: IngestRetryError, delaySeconds: 75,
    });
  });
});
