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
export async function fetchFiling(env: Env, docId: string): Promise<void> {
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
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      await markError(env, docId, `fetcher: source ${sourceUrl} -> HTTP ${res.status}`);
      return;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.arrayBuffer();
    const key = rawKeyFor(docId);

    // Persist raw bytes verbatim; retain content-type so the classifier can use
    // it as a cheap signal without re-fetching.
    await env.RAW_FILES.put(key, body, {
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
    await markError(env, docId, `fetcher: ${message}`);
    // Re-throw so the queue consumer retries transient network failures.
    throw err;
  }
}
