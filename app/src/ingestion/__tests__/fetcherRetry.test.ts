import { describe, it, expect, vi } from 'vitest';
import {
  fetchFiling,
  shouldRetryFetchStatus,
} from '../fetcher.ts';

function envForFetch(opts: {
  reviewResolved?: boolean;
  chamber?: string;
  sourceUrl?: string;
  relayUrl?: string;
  relaySecret?: string;
} = {}) {
  const updates: unknown[][] = [];
  const put = vi.fn(async (_key: string, _value: Uint8Array) => {});
  const send = vi.fn(async (msg: any) => updates.push(msg));
  const reviewResolved = opts.reviewResolved ?? false;
  return {
    env: {
      RAW_FILES: { put },
      SENATE_RELAY_URL: opts.relayUrl,
      SENATE_RELAY_SECRET: opts.relaySecret,
      DB: {
        // Branch on the SQL text: the fetcher looks up the filings row, then
        // the reviewQueueGuard checks review_queue.resolved before doing any
        // work. A single fixed mock response for both queries would make the
        // guard misfire (the filings row is a non-null object, so a
        // type-agnostic mock would always read as "resolved").
        prepare: (sql: string) => ({
          bind: () => ({
            run: async () => {},
            first: async () =>
              /review_queue/i.test(sql)
                ? (reviewResolved ? { n: 1 } : null)
                : {
                    source_url: opts.sourceUrl ?? 'http://test/doc.pdf',
                    chamber: opts.chamber ?? 'house',
                    ingest_status: 'new',
                  },
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

  it('no-ops without touching R2/DB/queue when the doc is already review-resolved', async () => {
    const { env, put, send } = envForFetch({ reviewResolved: true });
    const fetchMock = vi.fn(async () => new Response('small filing', {
      status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '12' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFiling(env, 'doc_resolved')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('senate document fetch via relay (2026-08-10 regression)', () => {
  // Imperva blocks the box's datacenter IP on efdsearch.senate.gov, so when
  // SENATE_RELAY_URL is set EVERY senate document request must go through the
  // relay's /fetch-doc — never direct. The historical backfill discovered
  // ~650 filings whose direct fetches then all 403'd; this suite pins the fix.
  const SENATE_DOC = 'https://efdsearch.senate.gov/search/view/ptr/abc-123/';
  const RELAY = 'http://relay.test:8899';

  it('routes the senate document fetch through the relay and never touches efdsearch directly', async () => {
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const fetchMock = vi.fn(async () => new Response('<html>Periodic Transaction Report</html>', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchFiling(env, 'S-doc_1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${RELAY}/fetch-doc`);
    expect(calledInit.method).toBe('POST');
    expect(JSON.parse(calledInit.body as string)).toEqual({ url: SENATE_DOC });
    expect(put).toHaveBeenCalledWith('raw/S-doc_1', expect.any(Uint8Array), {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
  });

  it('sends SENATE_RELAY_SECRET as Bearer on /fetch-doc', async () => {
    const { env } = envForFetch({
      chamber: 'senate',
      sourceUrl: SENATE_DOC,
      relayUrl: RELAY,
      relaySecret: 'relay-test-secret',
    });
    const fetchMock = vi.fn(async () => new Response('<html>Periodic Transaction Report</html>', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchFiling(env, 'S-doc_1');
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('authorization')).toBe('Bearer relay-test-secret');
  });

  it('retries through the relay (not direct) when the agreement wall leaks through', async () => {
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const wall = '<form id="agreement_form"><input name="prohibition_agreement"></form>';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(wall, { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('<html>Periodic Transaction Report</html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchFiling(env, 'S-doc_1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(`${RELAY}/fetch-doc`);
    }
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('mirrors an upstream non-OK relay status into the normal error path (no R2 write)', async () => {
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', {
      status: 404, headers: { 'content-type': 'application/json' },
    })));

    await expect(fetchFiling(env, 'S-doc_1')).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it('senate without a relay still uses the direct path (HEAD + GET on the source URL)', async () => {
    const { env } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC });
    const fetchMock = vi.fn(async () => new Response('<html>Periodic Transaction Report</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchFiling(env, 'S-doc_1');

    expect(fetchMock.mock.calls.every(([u]) => u === SENATE_DOC)).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'HEAD')).toBe(true);
  });

  it('falls back to direct eFD when /fetch-doc is a Cloudflare 502', async () => {
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === `${RELAY}/fetch-doc`) {
        return new Response('error code: 502', { status: 502 });
      }
      return new Response('<html>Periodic Transaction Report</html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchFiling(env, 'S-doc_1');

    expect(fetchMock.mock.calls[0][0]).toBe(`${RELAY}/fetch-doc`);
    expect(fetchMock.mock.calls.some(([u]) => u === SENATE_DOC)).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('does not fall back on a mirrored upstream 404 from /fetch-doc', async () => {
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const fetchMock = vi.fn(async () => new Response('{"error":"x"}', {
      status: 404, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFiling(env, 'S-doc_1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${RELAY}/fetch-doc`);
    expect(put).not.toHaveBeenCalled();
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
