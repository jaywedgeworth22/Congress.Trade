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
        // Enqueue chunks that sum to > MAX_RAW_FILING_BYTES (50MB)
        const chunk = new Uint8Array(30_000_000);
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

describe('senate document fetch (relay retired 2026-09-09)', () => {
  // History: Imperva blocks the box's datacenter IP on efdsearch.senate.gov.
  // The 2026-08-10 fix routed every senate document request through the Mac
  // relay's /fetch-doc. The Mac is now retired (board `ba810d46`) and the
  // residential IP comes from the Mango HTTP CONNECT proxy instead, so the
  // mechanism changed but the invariant did not: a senate document fetch must
  // never egress from the bare datacenter IP, and a stale SENATE_RELAY_URL
  // must never be dialled. `resolveResidentialProxyUrl` always resolves now
  // (Mango default), so these fetches are proxied; outside Deno
  // `createProxiedFetch` is a transparent pass-through, which is why the mock
  // still observes the real efdsearch URL.
  const SENATE_DOC = 'https://efdsearch.senate.gov/search/view/ptr/abc-123/';
  const RELAY = 'http://relay.test:8899';

  it('ignores a stale SENATE_RELAY_URL and fetches the document directly', async () => {
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const fetchMock = vi.fn(async () => new Response('<html>Periodic Transaction Report</html>', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchFiling(env, 'S-doc_1');

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    // The retired relay is never contacted, even though the env still names it.
    expect(fetchMock.mock.calls.every(([u]) => String(u) === SENATE_DOC)).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/fetch-doc'))).toBe(false);
    expect(put).toHaveBeenCalledWith('raw/S-doc_1', expect.any(Uint8Array), {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
  });

  it('never leaks SENATE_RELAY_SECRET onto the direct efdsearch request', async () => {
    // The bearer belonged to the relay. Now that requests go straight to the
    // Senate, attaching it would ship a fleet secret to a third-party origin.
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

    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers((init as RequestInit)?.headers ?? {});
      expect(headers.get('authorization')).toBeNull();
    }
  });

  it('negotiates a fresh session and retries directly when the agreement wall leaks through', async () => {
    // The relay used to hide this: it returned agreement-accepted bytes. Going
    // direct, the fetcher has to establish the eFD session itself (landing page
    // for the CSRF token, then POST the prohibition agreement) before retrying.
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const wall = '<form id="agreement_form"><input name="prohibition_agreement"></form>';
    let docHits = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/search/')) {
        return new Response(
          `<form><input type="hidden" name="csrfmiddlewaretoken" value="csrf-hidden"></form>`,
          { headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/' } },
        );
      }
      if (url.endsWith('/search/home/')) {
        return new Response('', { status: 302, headers: { 'set-cookie': 'sessionid=sess; Path=/' } });
      }
      docHits += 1;
      // First look at the document is the wall; after the session is accepted
      // the retry gets the real report.
      return docHits === 1
        ? new Response(wall, { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('<html>Periodic Transaction Report</html>', {
            status: 200, headers: { 'content-type': 'text/html' },
          });
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchFiling(env, 'S-doc_1');

    // The retired relay is never dialled on any leg of this flow.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/fetch-doc'))).toBe(false);
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

  it('warns that a configured SENATE_RELAY_URL is being ignored', async () => {
    // The operator has to learn the env is stale; the relay is gone and the
    // request silently changed shape.
    const { env } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Periodic Transaction Report</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })));

    await fetchFiling(env, 'S-doc_1');

    expect(warn.mock.calls.some(([msg]) => /SENATE_RELAY_URL/.test(String(msg)) && /retired/.test(String(msg)))).toBe(true);
    warn.mockRestore();
  });

  it('treats an upstream 404 as the normal error path (no R2 write)', async () => {
    const { env, put } = envForFetch({ chamber: 'senate', sourceUrl: SENATE_DOC, relayUrl: RELAY });
    const fetchMock = vi.fn(async () => new Response('{"error":"x"}', {
      status: 404, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchFiling(env, 'S-doc_1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.every(([u]) => String(u) === SENATE_DOC)).toBe(true);
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
