/**
 * Deterministic review drain (A2) — independent of OpenRouter / autopilot halt.
 *
 * House text PDF, Senate HTML, and OGE text already extract structured rows
 * without vision. When they land in review (or were parked by an older gate),
 * re-run extract+normalize from the stored R2 copy. Never calls agreement or
 * OpenRouter, so a quota halt cannot strand free publish paths.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { extractAndNormalize, extractParsed } from './orchestrator.ts';
import { isDeterministicExtractor, normalize } from './normalizer.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';

export interface DeterministicDrainResult {
  scanned: number;
  published: number;
  stillReview: number;
  skipped: number;
  errors: number;
}

const DEFAULT_LIMIT = 15;

/**
 * Re-extract + normalize unresolved review rows for deterministic doc kinds.
 * Safe to call every minute; LIMIT-bounded; no provider LLM spend.
 */
export async function maybeRunDeterministicReviewDrain(
  env: Env,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<DeterministicDrainResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 50);
  const out: DeterministicDrainResult = {
    scanned: 0,
    published: 0,
    stillReview: 0,
    skipped: 0,
    errors: 0,
  };

  let rows: Array<{
    doc_id: string;
    raw_object_key: string | null;
    doc_kind: string | null;
    extractor: string | null;
  }>;
  try {
    rows = await all(
      env.DB,
      `SELECT f.doc_id, f.raw_object_key, f.doc_kind, f.extractor
         FROM review_queue rq
         JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0
          AND f.raw_object_key IS NOT NULL
          AND (
            LOWER(COALESCE(f.doc_kind, '')) IN ('text_pdf', 'senate_html', 'oge_html', 'oge_text')
            OR LOWER(COALESCE(f.extractor, '')) IN (
              'textpdf', 'text_pdf', 'senatehtml', 'senate_html',
              'ogetext', 'oge_text', 'oge-text'
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.doc_id = rq.doc_id
               AND t.source IN ('primary', 'manual')
               AND t.deprecated_at IS NULL
          )
        ORDER BY rq.created_at ASC
        LIMIT ?`,
      [limit],
    );
  } catch (err) {
    console.warn('deterministicDrain: selector failed:', (err as Error).message);
    return out;
  }

  for (const row of rows) {
    if (opts.signal?.aborted) break;
    out.scanned++;
    if (!isDeterministicExtractor(row.extractor, row.doc_kind)) {
      out.skipped++;
      continue;
    }
    try {
      // Prefer full extract+normalize from stored R2 (text/html extractors only).
      await extractAndNormalize(env, row.doc_id);
      const live = await all<{ n: number }>(
        env.DB,
        `SELECT COUNT(*) AS n FROM transactions
          WHERE doc_id = ? AND deprecated_at IS NULL AND source IN ('primary', 'manual')`,
        [row.doc_id],
      );
      if ((live[0]?.n ?? 0) > 0) {
        out.published++;
        await recordIngestionDecision(env.DB, {
          docId: row.doc_id,
          source: 'pipeline',
          action: 'auto_published',
          reason: 'deterministic_drain_reextract',
          payload: { extractor: row.extractor, docKind: row.doc_kind },
        }).catch(() => undefined);
      } else {
        // Fallback: extractParsed + normalize once more with explicit extractor.
        const extracted = await extractParsed(env, row.doc_id);
        if (!extracted || !isDeterministicExtractor(extracted.extractor, extracted.filing.docKind)) {
          out.stillReview++;
          continue;
        }
        const result = await normalize(env, extracted.filing, extracted.transactions, {
          extractor: extracted.extractor,
          modelVersion: extracted.modelVersion,
        });
        if (result.published) {
          out.published++;
        } else {
          out.stillReview++;
        }
      }
    } catch (err) {
      out.errors++;
      console.warn(
        'deterministicDrain: failed for',
        row.doc_id,
        (err as Error).message,
      );
    }
  }

  if (out.scanned > 0) {
    console.log('deterministicDrain:', JSON.stringify(out));
  }
  return out;
}

/**
 * A5 / C8: re-queue rejected scanned filings that still have raw bytes for
 * local vision (never OpenRouter). Bounded, idempotent, one attempt budget
 * stamp so we do not loop forever.
 */
export interface LocalVisionRequeueResult {
  requeued: number;
  skipped: number;
}

export async function sweepRejectedScannedForLocalVision(
  env: Env,
  opts: { limit?: number } = {},
): Promise<LocalVisionRequeueResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const nowIso = new Date().toISOString();
  // Only honest garbage/OCR rejects with stored raw — not provider-missing stubs.
  const candidates = await all<{ doc_id: string }>(
    env.DB,
    `SELECT f.doc_id
       FROM filings f
       LEFT JOIN review_queue rq ON rq.doc_id = f.doc_id
      WHERE f.raw_object_key IS NOT NULL
        AND f.doc_id NOT LIKE 'provider-missing-%'
        AND LOWER(COALESCE(f.doc_kind, '')) IN ('scanned_pdf', 'unknown', '')
        AND (
          f.ingest_status = 'error'
          OR (rq.resolved = 1 AND rq.resolution_kind = 'rejected')
        )
        AND (
          COALESCE(f.error, '') LIKE '%ocr_unusable%'
          OR COALESCE(f.error, '') LIKE '%local_vision_exhausted%'
          OR COALESCE(f.error, '') LIKE '%server_cpu%'
          OR COALESCE(rq.reason, '') LIKE '%ocr_unusable%'
          OR COALESCE(rq.reason, '') LIKE '%form_chrome%'
          OR COALESCE(rq.resolution_reason, '') LIKE '%ocr_unusable%'
          OR COALESCE(rq.resolution_reason, '') LIKE '%server_cpu%'
          OR COALESCE(rq.resolution_reason, '') LIKE '%form_chrome%'
        )
        AND COALESCE(f.error, '') NOT LIKE '%local_vision_requeue_once%'
      ORDER BY f.first_seen_at ASC
      LIMIT ?`,
    [limit],
  );

  let requeued = 0;
  for (const c of candidates) {
    const expires = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    try {
      await run(
        env.DB,
        `UPDATE filings
            SET ingest_status = 'extraction_pending_local',
                local_wait_expires_at = ?,
                error = COALESCE(error || ';', '') || 'local_vision_requeue_once:' || ?,
                extractor = COALESCE(NULLIF(extractor, ''), 'local_mac')
          WHERE doc_id = ?`,
        [expires, nowIso, c.doc_id],
      );
      // Re-open review if it was rejected so the queue is honest again.
      await run(
        env.DB,
        `UPDATE review_queue
            SET resolved = 0,
                resolution_kind = NULL,
                resolution_reason = NULL,
                resolved_at = NULL,
                reason = COALESCE(reason, 'local_vision_requeue')
          WHERE doc_id = ? AND resolved = 1`,
        [c.doc_id],
      ).catch(() => undefined);
      try {
        await env.INGEST_QUEUE.send({
          type: 'filing.local_wait_check',
          docId: c.doc_id,
        });
      } catch {
        // Queue may be unavailable; ceiling sweep still advances pending_local.
      }
      requeued++;
    } catch (err) {
      console.warn('localVision requeue failed:', c.doc_id, (err as Error).message);
    }
  }
  if (requeued > 0) {
    console.log('localVision requeue:', JSON.stringify({ requeued, candidates: candidates.length }));
  }
  return { requeued, skipped: candidates.length - requeued };
}
