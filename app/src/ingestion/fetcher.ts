/**
 * src/ingestion/fetcher.ts
 * OWNER: ingestion agent
 *
 * Handles {type:'filing.new'}: downloads the raw disclosure (PDF/HTML), stores
 * it in R2 (RAW_FILES) under key `raw/{docId}`, updates filings.raw_object_key +
 * ingest_status='fetched', then enqueues {type:'filing.fetched'}.
 *
 *   HOUSE PTR  -> PDF at
 *     https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{YEAR}/{DocID}.pdf
 *     (we already stored this exact url as filings.source_url at watch time).
 *   SENATE     -> GET the report sourceUrl. Electronic PTRs render as HTML;
 *     paper PTRs are an HTML shell linking to a PDF. We store the response body
 *     verbatim (HTML or PDF bytes); the classifier decides the DocKind.
 */

import type { Env } from '../shared/types';
import { get, run } from '../shared/db';

const UA = 'congress-feed/0.1 (+https://congress.trade)';

interface FilingRow {
  doc_id: string;
  chamber: string | null;
  source_url: string | null;
  ingest_status: string | null;
}

export const MAX_RAW_FILING_BYTES = 25 * 1024 * 1024;
const MAX_INGEST_BACKOFF_SECONDS = 900;

export class IngestRetryError extends Error {
  constructor(message: string, readonly delaySeconds: number) {
    super(message);
  }
}

export class FilingTooLargeError extends Error {}

/** HTTP responses that should be retried by the ingest queue. */
export function isRetryableFilingHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function retryAfterSeconds(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.max(1, Math.min(3600, Math.ceil(numeric)));
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(1, Math.min(3600, Math.ceil((at - nowMs) / 1000)));
}

/** Exponential fallback with bounded half-to-full jitter. attempt is 1-based. */
export function ingestBackoffSeconds(attempt: number, random = Math.random): number {
  const cap = Math.min(MAX_INGEST_BACKOFF_SECONDS, 5 * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.floor(cap * (0.5 + random() * 0.5)));
}

/** Queue-boundary classifier shared by later provider-backed ingest stages. */
export function classifyTransientIngestError(
  error: unknown,
  attempt: number,
): IngestRetryError | null {
  if (error instanceof IngestRetryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const transient =
    /\bHTTP\s+(408|425|429|5\d\d)\b/i.test(message) ||
    /rate[ -]?limit|quota|temporar(?:y|ily) unavailable|timeout|timed out|network|fetch failed|ECONN(?:RESET|REFUSED)|overloaded/i.test(message);
  if (!transient) return null;
  const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(message);
  const delay = retryAfterMatch
    ? retryAfterSeconds(retryAfterMatch[1]) ?? ingestBackoffSeconds(attempt)
    : ingestBackoffSeconds(attempt);
  return new IngestRetryError(message, delay);
}



/**
 * Buffer the size-guarded body into memory. R2 `put()` rejects a plain JS
 * ReadableStream because it has no known length ("Provided readable stream
 * must have a known length"), and sources like OGE's Domino server respond
 * chunked with no Content-Length — so the raw bytes must be buffered (capped
 * at MAX_RAW_FILING_BYTES) before the R2 write.
 */
export async function bufferFilingBody(
  body: ReadableStream<Uint8Array>,
  limit = MAX_RAW_FILING_BYTES,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel('filing exceeds size limit').catch(() => {});
      throw new FilingTooLargeError(`filing exceeds ${limit} byte limit`);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** R2 object key for a filing's raw original. Matches the spec: `raw/{docId}`. */
export function rawKeyFor(docId: string): string {
  return `raw/${docId}`;
}

/** Mark a filing as errored (does not throw). */
async function markError(env: Env, docId: string, message: string): Promise<void> {
  try {
    await run(
      env.DB,
      `UPDATE filings SET ingest_status = 'error', error = ? WHERE doc_id = ?`,
      [message.slice(0, 1000), docId],
    );
  } catch (e) {
    console.error(`fetcher: failed to record error for ${docId}:`, e);
  }
}

/**
 * Fetch + persist the raw bytes for a filing, then advance the pipeline.
 */
export async function fetchFiling(env: Env, docId: string, queueAttempt = 1): Promise<void> {
  const row = await get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, source_url, ingest_status FROM filings WHERE doc_id = ?`,
    [docId],
  );
  if (!row) {
    console.warn(`fetcher: no filings row for ${docId}; skipping`);
    return;
  }
  const sourceUrl = row.source_url;
  if (!sourceUrl) {
    await markError(env, docId, 'fetcher: missing source_url');
    return;
  }

  try {
    const res = await fetch(sourceUrl, {
      headers: {
        'user-agent': UA,
        accept:
          row.chamber === 'senate'
            ? 'text/html,application/xhtml+xml,application/pdf,*/*'
            : 'application/pdf,*/*',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      const message = `fetcher: source ${sourceUrl} -> HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
      await markError(env, docId, message);
      if (isRetryableFilingHttpStatus(res.status)) {
        throw new IngestRetryError(
          message,
          retryAfterSeconds(res.headers.get('retry-after')) ?? ingestBackoffSeconds(queueAttempt),
        );
      }
      return;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const contentLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RAW_FILING_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new FilingTooLargeError(`filing exceeds ${MAX_RAW_FILING_BYTES} byte limit`);
    }
    if (!res.body) throw new Error('source response body is missing');
    const key = rawKeyFor(docId);

    // Persist raw bytes verbatim; retain content-type so the classifier can use
    // it as a cheap signal without re-fetching.
    const rawBytes = await bufferFilingBody(res.body);
    await env.RAW_FILES.put(key, rawBytes, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    await run(
      env.DB,
      `UPDATE filings
          SET raw_object_key = ?, ingest_status = 'fetched', error = NULL
        WHERE doc_id = ?`,
      [key, docId],
    );

    await env.INGEST_QUEUE.send({ type: 'filing.fetched', docId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof FilingTooLargeError || /filing exceeds \d+ byte limit/i.test(message)) {
      await markError(env, docId, `fetcher: ${message}`);
      return;
    }
    if (err instanceof IngestRetryError) throw err;
    await markError(env, docId, `fetcher: ${message}`);
    // Network, R2, D1, and queue failures are transient unless explicitly
    // classified above; carry an explicit delay into the queue consumer.
    throw new IngestRetryError(`fetcher: ${message}`, ingestBackoffSeconds(queueAttempt));
  }
}
