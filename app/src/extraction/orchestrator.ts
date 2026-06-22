/**
 * src/extraction/orchestrator.ts
 * OWNER: integration (wires ingestion -> extraction -> normalizer)
 *
 * Consumes {type:'filing.extracted'} (emitted by the classifier). Loads the
 * classified filing + its raw R2 object, routes it to the first extractor in
 * buildExtractorPipeline() whose canHandle() returns true, runs extraction, and
 * hands the parsed rows to normalize() which validates, persists, and fans out
 * delivery.
 *
 * This closes the seam the foundation left as a no-op in index.ts: the
 * classifier emits filing.extracted, and THIS function is what index.ts invokes
 * for that message.
 */

import type { Env, Filing, DocKind, Chamber } from '../shared/types';
import { get, run } from '../shared/db';
import { buildExtractorPipeline } from '../extractors/types';
import { normalize } from './normalizer';

interface FilingRow {
  doc_id: string;
  chamber: string | null;
  filer_id: string | null;
  filing_type: string | null;
  filed_date: string | null;
  source_url: string | null;
  raw_object_key: string | null;
  ingest_status: string | null;
  doc_kind: string | null;
  extractor: string | null;
  model_version: string | null;
  confidence: number | null;
  first_seen_at: string | null;
  source_updated_at: string | null;
  error: string | null;
}

/** Map a snake_case D1 filings row to the camelCase Filing contract. */
function rowToFiling(r: FilingRow): Filing {
  return {
    docId: r.doc_id,
    chamber: (r.chamber as Chamber) ?? 'house',
    filerId: r.filer_id,
    filingType: r.filing_type ?? 'P',
    filedDate: r.filed_date,
    sourceUrl: r.source_url ?? '',
    rawObjectKey: r.raw_object_key,
    ingestStatus: (r.ingest_status as Filing['ingestStatus']) ?? 'classified',
    docKind: (r.doc_kind as DocKind) ?? 'unknown',
    extractor: r.extractor,
    modelVersion: r.model_version,
    confidence: r.confidence,
    firstSeenAt: r.first_seen_at ?? new Date().toISOString(),
    sourceUpdatedAt: r.source_updated_at,
    error: r.error,
  };
}

async function markError(env: Env, docId: string, message: string): Promise<void> {
  await run(
    env.DB,
    "UPDATE filings SET ingest_status = 'error', error = ? WHERE doc_id = ?",
    [message.slice(0, 500), docId],
  );
}

/**
 * Extract + normalize a classified filing.
 *
 * Throws on extractor failure (e.g. transient LLM error) AFTER recording the
 * error on the filing, so the queue consumer can retry per wrangler.toml. A
 * filing whose docKind has no matching extractor is routed to review rather
 * than retried forever.
 */
export async function extractAndNormalize(env: Env, docId: string): Promise<void> {
  const row = await get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, filer_id, filing_type, filed_date, source_url,
            raw_object_key, ingest_status, doc_kind, extractor, model_version,
            confidence, first_seen_at, source_updated_at, error
       FROM filings WHERE doc_id = ?`,
    [docId],
  );
  if (!row) {
    console.warn(`orchestrator: no filings row for ${docId}; skipping`);
    return;
  }

  const filing = rowToFiling(row);

  if (!filing.rawObjectKey) {
    await markError(env, docId, 'orchestrator: missing raw_object_key');
    return;
  }

  const obj = await env.RAW_FILES.get(filing.rawObjectKey);
  if (!obj) {
    await markError(env, docId, `orchestrator: R2 object ${filing.rawObjectKey} not found`);
    return;
  }

  const bytes = await obj.arrayBuffer();
  const html =
    filing.docKind === 'senate_html'
      ? new TextDecoder('utf-8').decode(new Uint8Array(bytes))
      : undefined;

  // Route to the first extractor that can handle this docKind.
  const pipeline = buildExtractorPipeline(env);
  const extractor = pipeline.find((e) => e.canHandle(filing));

  if (!extractor) {
    // Unknown / unsupported doc form (e.g. an ambiguous scan): surface it for a
    // human rather than dropping it. normalize([]) writes a review_queue row and
    // marks the filing needs_review.
    await normalize(env, filing, [], { extractor: 'none', modelVersion: null });
    return;
  }

  let result;
  try {
    result = await extractor.extract({ filing, bytes, html });
  } catch (err) {
    const message = `orchestrator: ${extractor.name} failed: ${(err as Error).message}`;
    await markError(env, docId, message);
    // Re-throw so the queue retries transient failures (LLM rate limits etc.).
    throw err;
  }

  await normalize(env, filing, result.transactions, {
    extractor: result.extractor,
    modelVersion: result.modelVersion ?? null,
  });
}
