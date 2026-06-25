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
import { recomputeTransactions, persistTransactions, HARD_FAILURE_FLAGS } from './normalizer';
import { mapFiling, type FilingRow } from '../delivery/rows';

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
  const hardFlags = Array.from(new Set(flagged.flatMap((f) => f.flags).filter((fl) => HARD_FAILURE_FLAGS.includes(fl))));
  if (hardFlags.length) return { docId, outcome: 'agree_but_hardfail', rowCount: rA.rowCount, flags: hardFlags };

  if (dryRun) {
    return { docId, outcome: 'would_publish', rowCount: flagged.length, tickers: flagged.map((f) => f.tx.ticker).filter((t): t is string => !!t).slice(0, 8) };
  }

  // Publish — agreement overrides the soft confidence cap.
  const txs = flagged.map((f) => ({ ...f.tx, source: 'primary' as const, confidence: Math.max(f.tx.confidence, 0.95) }));
  const insertedIds = await persistTransactions(env, txs);
  await run(env.DB, "UPDATE filings SET ingest_status = 'persisted', error = NULL WHERE doc_id = ?", [docId]);
  await run(env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [docId]);
  for (const txId of insertedIds) {
    try { await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId }); } catch { /* best-effort */ }
  }
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
  const valid = ['gemini', 'openai', 'anthropic', 'mistral', 'xai'];
  return valid.includes(provider) && model ? ({ provider, model } as BakeoffCandidate) : fallback;
}

interface AgreementEnv {
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  AGREEMENT_AUTOPUBLISH_MODEL_A?: string;
  AGREEMENT_AUTOPUBLISH_MODEL_B?: string;
  AGREEMENT_AUTOPUBLISH_LIMIT?: string;
}

/**
 * Autonomous pass: pick up to `limit` review docs that have NOT yet had an
 * agreement attempt, run the two configured cross-vendor models, and publish
 * the ones that agree. Each doc is attempted exactly once (agreement_attempted_at
 * is stamped regardless of outcome) so disagreements aren't re-read every minute.
 * Self-gates on AGREEMENT_AUTOPUBLISH_ENABLED; never throws (cron-safe).
 */
export async function maybeRunAgreementAutopublish(env: Env): Promise<{ attempted: number; published: number } | null> {
  const e = env as unknown as AgreementEnv;
  if (e.AGREEMENT_AUTOPUBLISH_ENABLED !== 'true') return null;
  const models: AgreementModels = {
    a: parseCandidate(e.AGREEMENT_AUTOPUBLISH_MODEL_A, { provider: 'mistral', model: 'mistral-ocr-latest' }),
    b: parseCandidate(e.AGREEMENT_AUTOPUBLISH_MODEL_B, { provider: 'gemini', model: 'gemini-3.5-flash' }),
  };
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

  let published = 0;
  for (const d of docs) {
    try {
      const res = await processAgreementDoc(env, models, d.doc_id, d.raw_object_key, false);
      if (res.outcome === 'published') published++;
    } catch (err) {
      console.warn('agreement autopublish doc failed:', d.doc_id, (err as Error).message);
    }
    // Stamp attempted regardless of outcome so we never re-read it every minute.
    try {
      await run(env.DB, 'UPDATE review_queue SET agreement_attempted_at = ? WHERE doc_id = ?', [new Date().toISOString(), d.doc_id]);
    } catch { /* best-effort */ }
  }
  if (docs.length) console.log(`agreement autopublish: attempted ${docs.length}, published ${published}`);
  return { attempted: docs.length, published };
}
