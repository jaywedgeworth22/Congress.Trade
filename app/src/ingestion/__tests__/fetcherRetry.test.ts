import { describe, it, expect, vi } from 'vitest';
import {
  fetchFiling,
  shouldRetryFetchStatus,
} from '../fetcher.ts';

function envForFetch() {
  const updates: unknown[][] = [];
  const put = vi.fn(async (_key: string, _value: Uint8Array) => {});
  const send = vi.fn(async (msg: any) => updates.push(msg));
  return {
    env: {
      RAW_FILES: { put },
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {},
            first: async () => ({ source_url: 'http://test/doc.pdf', chamber: 'house', ingest_status: 'new' }),
          }),
        }),
        batch: async (stmts: any[]) => { updates.push(...stmts); return []; },
      },
      INGEST_QUEUE: { send },
    } as any,
    put,
    send,
  };
}

describe('fetcherRetry', () => {
  it('happy path', async () => {
    const { env, put } = envForFetch();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('small filing', {
      status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '12' },
    })));
    await fetchFiling(env, 'doc_1');
    // R2 put() requires a known length: the body must arrive as buffered
    // bytes, never as a plain JS ReadableStream (which has no known length).
    expect(put).toHaveBeenCalledWith('raw/doc_1', expect.any(Uint8Array), {
      httpMetadata: { contentType: 'application/pdf' },
    });
  });

  it('propagates the durable queue lease signal to the source request', async () => {
    const { env } = envForFetch();
    const fetchMock = vi.fn(async () => new Response('small filing', {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': '12' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const lease = {
      signal: controller.signal,
      assertOwned: vi.fn(async () => {}),
      renew: vi.fn(async () => {}),
    };

    await fetchFiling(env, 'doc_1', 1, lease);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://test/doc.pdf',
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(lease.assertOwned).toHaveBeenCalled();
  });

  it('enforces size limit while buffering streaming bodies', async () => {
    const { env, put, send } = envForFetch();
    // Use a ReadableStream without a Content-Length to bypass the initial check
    const body = new ReadableStream({
      start(controller) {
        // Enqueue chunks that sum to > MAX_RAW_FILING_BYTES
        const chunk = new Uint8Array(20_000_000);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
      cancel() {},
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    await expect(fetchFiling(env, 'doc_1')).resolves.toBeUndefined();
    // The limit trips while buffering, before R2 is ever touched.
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('shouldRetryFetchStatus (transient 403/404 handling)', () => {
  const NOW = new Date('2026-08-01T12:00:00Z');

  it('treats 403 as transient (WAF burst response)', () => {
    expect(shouldRetryFetchStatus(403, null, NOW)).toBe(true);
    expect(shouldRetryFetchStatus(403, '2026-01-01T00:00:00Z', NOW)).toBe(true);
  });

  it('treats 404 as transient only within the not-yet-published window', () => {
    // First seen 2 days ago: House bulk index entries precede the PDF.
    expect(shouldRetryFetchStatus(404, '2026-07-30T12:00:00Z', NOW)).toBe(true);
    // Older than the 7-day window: genuinely missing, terminal.
    expect(shouldRetryFetchStatus(404, '2026-07-20T12:00:00Z', NOW)).toBe(false);
    // Unknown first_seen: terminal (don't churn on legacy rows).
    expect(shouldRetryFetchStatus(404, null, NOW)).toBe(false);
    expect(shouldRetryFetchStatus(404, 'not-a-date', NOW)).toBe(false);
  });

  it('keeps generic retryable + terminal statuses unchanged', () => {
    expect(shouldRetryFetchStatus(429, null, NOW)).toBe(true);
    expect(shouldRetryFetchStatus(503, null, NOW)).toBe(true);
    expect(shouldRetryFetchStatus(400, null, NOW)).toBe(false);
    expect(shouldRetryFetchStatus(410, null, NOW)).toBe(false);
  });
});
