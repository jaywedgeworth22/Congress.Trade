/**
 * src/extraction/agreement.ts
 *
 * Cross-vendor agreement → auto-publish. Shared by the admin
 * /agreement-reprocess endpoint (on-demand, dry-runnable) and the per-minute
 * cron pass (autonomous). Two independent models read a held-for-review filing;
 * when they FULLY agree on the row set, agreement substitutes for the
 * conservative 0.60 vision-confidence cap and the read is published (after the
 * normalizer resolves tickers + validates brackets). Disagreements — or hard
 * structural failures — stay in review.
 */

import type { Env } from '../shared/types';
import { all, get, run } from '../shared/db';
import { runCandidateOnDoc, type BakeoffCandidate, type CandidateDocResult } from './bakeoff';
import { arbitrationRowKey } from '../extractors/types';
import {
  recomputeTransactions,
  persistTransactions,
  HARD_FAILURE_FLAGS,
  MAX_PUBLISH_TRANSACTIONS_PER_FILING,
} from './normalizer';
import { mapFiling, type FilingRow } from '../delivery/rows';
import { flushDeliveryOutbox } from '../delivery/outbox';

export interface AgreementModels {
  a: BakeoffCandidate;
  b: BakeoffCandidate;
  /** Optional third-model consensus tier; off by default. */
  c?: BakeoffCandidate | null;
}

export type AgreementOutcome = 'published' | 'would_publish' | 'disagree' | 'agree_but_hardfail' | 'skipped';

export interface AgreementDocResult {
  docId: string;
  outcome: AgreementOutcome;
  rowCount?: number;
  inserted?: number;
  reason?: string;
  flags?: string[];
  tickers?: string[];
  rows?: Record<string, number | string>;
}

/** True when two candidate reads carry the identical row-key SET (not just count). */
export function sameRowSet(a: CandidateDocResult, b: CandidateDocResult): boolean {
  if (!a.ok || !b.ok || a.rows.length === 0) return false;
  const ka = new Set(a.rows.map(arbitrationRowKey));
  const kb = new Set(b.rows.map(arbitrationRowKey));
  if (ka.size !== kb.size) return false;
  for (const k of ka) if (!kb.has(k)) return false;
  return true;
}

/**
 * Run the agreement check on ONE document and (unless dryRun) publish on full
 * agreement. Pure-ish: all writes go through the shared normalizer/persist path.
 */
export async function processAgreementDoc(
  env: Env,
  models: AgreementModels,
  docId: string,
  rawObjectKey: string | null,
  dryRun: boolean,
): Promise<AgreementDocResult> {
  if (!rawObjectKey) return { docId, outcome: 'skipped', reason: 'no raw_object_key' };
  const obj = await env.RAW_FILES.get(rawObjectKey);
  if (!obj) return { docId, outcome: 'skipped', reason: 'R2 object missing' };
  const bytes = await obj.arrayBuffer();

  const rA = await runCandidateOnDoc(env, models.a, docId, bytes);
  const rB = await runCandidateOnDoc(env, models.b, docId, bytes);
  const rC = models.c ? await runCandidateOnDoc(env, models.c, docId, bytes) : null;

  const agree = sameRowSet(rA, rB) && (!rC || (sameRowSet(rA, rC) && sameRowSet(rB, rC)));
  if (!agree) {
    return {
      docId,
      outcome: 'disagree',
      rows: {
        [models.a.provider]: rA.ok ? rA.rowCount : 'ERR',
        [models.b.provider]: rB.ok ? rB.rowCount : 'ERR',
        ...(models.c ? { [models.c.provider]: rC && rC.ok ? rC.rowCount : 'ERR' } : {}),
      },
    };
  }

  const frow = await get<FilingRow>(
    env.DB,
    `SELECT doc_id, chamber, filer_id, filing_type, filed_date, source_url, raw_object_key,
            ingest_status, doc_kind, extractor, model_version, confidence, first_seen_at,
            source_updated_at, error FROM filings WHERE doc_id = ?`,
    [docId],
  );
  if (!frow) return { docId, outcome: 'skipped', reason: 'filing row missing' };

  const flagged = await recomputeTransactions(env, mapFiling(frow), rA.rows);
  if (flagged.length > MAX_PUBLISH_TRANSACTIONS_PER_FILING) {
    return {
      docId,
      outcome: 'agree_but_hardfail',
      rowCount: flagged.length,
      flags: ['row_limit_exceeded'],
    };
  }
  const hardFlags = Array.from(new Set(flagged.flatMap((f) => f.flags).filter((fl) => HARD_FAILURE_FLAGS.includes(fl))));
  if (hardFlags.length) return { docId, outcome: 'agree_but_hardfail', rowCount: rA.rowCount, flags: hardFlags };

  if (dryRun) {
    return { docId, outcome: 'would_publish', rowCount: flagged.length, tickers: flagged.map((f) => f.tx.ticker).filter((t): t is string => !!t).slice(0, 8) };
  }

  // Publish — agreement overrides the soft confidence cap.
  const txs = flagged.map((f) => ({ ...f.tx, source: 'primary' as const, confidence: Math.max(f.tx.confidence, 0.95) }));
  const insertedIds = await persistTransactions(env, txs, {
    publication: {
      docId,
      resolveReview: true,
      audit: {
        action: 'agreement_published',
        source: 'agreement',
        reason: 'model_agreement',
        payload: {
          rowCount: flagged.length,
          models: {
            a: `${models.a.provider}:${models.a.model}`,
            b: `${models.b.provider}:${models.b.model}`,
            ...(models.c ? { c: `${models.c.provider}:${models.c.model}` } : {}),
          },
        },
      },
    },
  });
  await flushDeliveryOutbox(env, { txIds: insertedIds, limit: Math.max(insertedIds.length, 1) }).catch((err) =>
    console.warn('agreement publish: delivery outbox flush failed', docId, (err as Error).message),
  );
  return { docId, outcome: 'published', inserted: insertedIds.length };
}

// ---------------------------------------------------------------------------
// Autonomous per-minute pass (called from the cron)
// ---------------------------------------------------------------------------

/** Parse "provider:model" or fall back. e.g. "mistral:mistral-ocr-latest". */
function parseCandidate(s: string | undefined, fallback: BakeoffCandidate): BakeoffCandidate {
  if (!s) return fallback;
  const [provider, ...rest] = s.split(':');
  const model = rest.join(':');
  const valid = ['gemini', 'openai', 'anthropic', 'mistral', 'xai', 'llamaparse'];
  return valid.includes(provider) && model ? ({ provider, model } as BakeoffCandidate) : fallback;
}

interface AgreementEnv {
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  AGREEMENT_AUTOPUBLISH_MODEL_A?: string;
  AGREEMENT_AUTOPUBLISH_MODEL_B?: string;
  AGREEMENT_AUTOPUBLISH_LIMIT?: string;
}

/** Resolve the configured A/B agreement models (with sensible defaults). */
function resolveModels(e: AgreementEnv): AgreementModels {
  return {
    a: parseCandidate(e.AGREEMENT_AUTOPUBLISH_MODEL_A, { provider: 'mistral', model: 'mistral-ocr-latest' }),
    b: parseCandidate(e.AGREEMENT_AUTOPUBLISH_MODEL_B, { provider: 'gemini', model: 'gemini-3.5-flash' }),
  };
}

/**
 * Hand ONE review doc to the agreement pipeline asynchronously: enqueue an
 * `agreement.check` message and stamp the attempt. The slow model work runs in
 * the queue consumer (handleAgreementCheck), where per-message duration is
 * generous — unlike the cron's scheduled-handler waitUntil, which cancels long
 * work. Self-gates on the flag. The attempt is stamped only AFTER a successful
 * enqueue so a send failure lets the cron backstop retry next minute. Returns
 * true when a check was enqueued.
 */
export async function enqueueAgreementCheck(env: Env, docId: string, rawObjectKey: string | null): Promise<boolean> {
  const e = env as unknown as AgreementEnv;
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return false;
  
  const now = new Date().toISOString();
  let dbUpdated = false;
  try {
    await run(env.DB, 'UPDATE review_queue SET agreement_attempted_at = ? WHERE doc_id = ?', [now, docId]);
    dbUpdated = true;
  } catch (err) {
    console.warn('enqueueAgreementCheck DB stamp failed:', docId, (err as Error).message);
  }

  try {
    await env.INGEST_QUEUE.send({ type: 'agreement.check', docId, rawObjectKey });
    return true;
  } catch (err) {
    console.warn('enqueueAgreementCheck send failed:', docId, (err as Error).message);
    if (dbUpdated) {
      try {
        await run(env.DB, 'UPDATE review_queue SET agreement_attempted_at = NULL WHERE doc_id = ?', [docId]);
      } catch (rollbackErr) {
        console.error('enqueueAgreementCheck rollback failed:', docId, (rollbackErr as Error).message);
      }
    }
    return false;
  }
  return true;
}

/**
 * Queue-consumer handler for an `agreement.check` message: resolve the
 * configured models and run the (slow) agreement read + publish for one doc.
 * Self-gates on the flag so a disabled deploy drains queued checks as no-ops.
 */
export async function handleAgreementCheck(env: Env, docId: string, rawObjectKey: string | null): Promise<void> {
  const e = env as unknown as AgreementEnv;
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return;
  const res = await processAgreementDoc(env, resolveModels(e), docId, rawObjectKey, false);
  console.log(`agreement.check ${docId}: ${res.outcome}${res.inserted ? ` (+${res.inserted} tx)` : ''}`);
}

/**
 * Autonomous per-minute backstop: pick up to `limit` review docs that have NOT
 * yet had an agreement attempt and ENQUEUE an agreement.check for each (fast —
 * no model work, so it never gets canceled like inline cron work does). Each doc
 * is attempted exactly once (agreement_attempted_at is stamped on enqueue) so a
 * doc is never re-read every minute. The newly-reviewed fast path lives in the
 * orchestrator (enqueueAgreementCheck right when a doc hits review); this cron
 * is the safety net that catches anything that path missed. Self-gates on
 * AGREEMENT_AUTOPUBLISH_ENABLED; never throws (cron-safe).
 */
export async function maybeRunAgreementAutopublish(env: Env): Promise<{ attempted: number; enqueued: number } | null> {
  const e = env as unknown as AgreementEnv;
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return null;
  const limit = Math.min(Math.max(parseInt(e.AGREEMENT_AUTOPUBLISH_LIMIT || '3', 10) || 3, 1), 10);

  let docs: Array<{ doc_id: string; raw_object_key: string | null }>;
  try {
    docs = await all<{ doc_id: string; raw_object_key: string | null }>(
      env.DB,
      `SELECT f.doc_id, f.raw_object_key
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0 AND rq.agreement_attempted_at IS NULL AND f.raw_object_key IS NOT NULL
        ORDER BY rq.created_at DESC LIMIT ?`,
      [limit],
    );
  } catch {
    return null; // migration not applied yet
  }

  let enqueued = 0;
  for (const d of docs) {
    if (await enqueueAgreementCheck(env, d.doc_id, d.raw_object_key)) enqueued++;
  }
  if (docs.length) console.log(`agreement autopublish: enqueued ${enqueued}/${docs.length} checks`);
  return { attempted: docs.length, enqueued };
}
