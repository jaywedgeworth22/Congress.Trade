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

import type { Env, Filing, DocKind, Chamber, ParsedTx } from '../shared/types';
import { get, run } from '../shared/db';
import { buildExtractorPipeline, type ExtractorResult } from '../extractors/types';
import { normalize } from './normalizer';
import { enqueueAgreementCheck } from './agreement';
import { reportAiUsage } from '../shared/telemetry';

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

function isProviderRateLimit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b(429|too many requests|quota exceeded|rate[- ]?limit)\b/i.test(message);
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
  const extracted = await extractParsed(env, docId);
  if (!extracted) return; // missing row / raw object: already recorded as error.

  const result = await normalize(env, extracted.filing, extracted.transactions, {
    extractor: extracted.extractor,
    modelVersion: extracted.modelVersion ?? null,
  });

  // Fast path: a doc that just landed in review gets a cross-vendor agreement
  // check enqueued immediately (self-gates on the flag; the per-minute cron is
  // the backstop). Best-effort — a failure here must not fail the extraction.
  if (result.needsReview) {
    try {
      await enqueueAgreementCheck(env, extracted.filing.docId, extracted.filing.rawObjectKey);
    } catch (err) {
      console.warn('inline agreement enqueue failed:', docId, (err as Error).message);
    }
  }
}

/** Result of re-running extraction (no normalize/persist). */
export interface ExtractedFiling {
  filing: Filing;
  transactions: ParsedTx[];
  extractor: string;
  modelVersion: string | null;
}

/**
 * Run only the extraction half: load the filing + its raw R2 object and route it
 * to the matching extractor, returning the parsed rows WITHOUT normalizing or
 * persisting. Returns null (after recording an error on the filing) when the row
 * or raw object is missing. Shared by extractAndNormalize() and the admin
 * reprocess path, which re-extracts from the already-stored R2 raw — so it never
 * re-fetches from the source — then recomputes confidence in place.
 */
export async function extractParsed(env: Env, docId: string): Promise<ExtractedFiling | null> {
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
    return null;
  }

  const filing = rowToFiling(row);

  if (!filing.rawObjectKey) {
    await markError(env, docId, 'orchestrator: missing raw_object_key');
    return null;
  }

  const obj = await env.RAW_FILES.get(filing.rawObjectKey);
  if (!obj) {
    await markError(env, docId, `orchestrator: R2 object ${filing.rawObjectKey} not found`);
    return null;
  }

  const bytes = await obj.arrayBuffer();

  // Complexity signal for cascade tiering: raw byte length. Recorded as soon as
  // bytes are in hand (independent of whether extraction later succeeds).
  // Best-effort — a failure here must never fail extraction.
  try {
    await run(env.DB, 'UPDATE filings SET raw_bytes = ? WHERE doc_id = ?', [bytes.byteLength, docId]);
  } catch (err) {
    console.warn('orchestrator: failed to record raw_bytes:', docId, (err as Error).message);
  }

  

  const html =
    filing.docKind === 'senate_html'
      ? new TextDecoder('utf-8').decode(new Uint8Array(bytes))
      : undefined;

  // Route to the first extractor that can handle this docKind.
  const pipeline = buildExtractorPipeline(env);
  const extractor = pipeline.find((e) => e.canHandle(filing));

  if (!extractor) {
    // Unknown / unsupported doc form (e.g. an ambiguous scan): no extractor, no
    // parsed rows. Callers decide what to do (normalize([]) routes to review).
    return { filing, transactions: [], extractor: 'none', modelVersion: null };
  }

  let result;
  try {
    result = await extractor.extract({ filing, bytes, html });
  } catch (err) {
    const cast = err as Error & { usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } };
    if (cast.usage) {
      // Fire-and-forget telemetry even on failed parses (tokens were consumed)
      reportAiUsage(env, {
        provider: 'gemini', // extractParsed primarily uses VisionLlmExtractor
        model: cast.usage.promptTokens ? 'gemini-3.5-flash' : 'unknown', // fallback, actual model isn't on the error
        component: 'orchestrator',
        ...cast.usage,
      }).catch(() => {});
    }

    const detail = (err as Error).message;
    const message = isProviderRateLimit(err)
      ? `orchestrator: ${extractor.name} temporarily unavailable: provider quota/rate limit. Reprocess this filing later.`
      : `orchestrator: ${extractor.name} failed: ${detail}`;
    await markError(env, docId, message);
    // Re-throw so the queue retries transient failures, including a rate limit
    // that's still exhausted after visionLlm's in-request fetchWithRetry backoff
    // (a few seconds) — the queue's own retry cadence (max_retries in
    // wrangler.toml) covers a longer provider quota window than a single
    // message attempt can.
    throw err;
  }

  if (result.usage && result.modelVersion) {
    reportAiUsage(env, {
      // orchestrator mainly runs Gemini (visionLlm), but we can infer provider
      // broadly if we assume Gemini based on the pipeline.
      provider: 'gemini',
      model: result.modelVersion,
      component: 'orchestrator',
      ...result.usage,
    }).catch(() => {});
  }

  // Complexity signal for cascade tiering: page count, when the extractor
  // cheaply exposed it (e.g. TextPdfExtractor reads pdf.numPages off the
  // document proxy it already parsed for text — no extra page merge). Not
  // part of the ExtractorResult contract, so read it via an optional-property
  // cast rather than widening that interface. Best-effort — a failure here
  // must never fail extraction.
  try {
    const pageCount = (result as ExtractorResult & { pageCount?: number | null }).pageCount ?? null;
    if (pageCount !== null) {
      await run(env.DB, 'UPDATE filings SET page_count = ? WHERE doc_id = ?', [pageCount, docId]);
    }
  } catch (err) {
    console.warn('orchestrator: failed to record page_count:', docId, (err as Error).message);
  }

  return {
    filing,
    transactions: result.transactions,
    extractor: result.extractor,
    modelVersion: result.modelVersion ?? null,
  };
}
