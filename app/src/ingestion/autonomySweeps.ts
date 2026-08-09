/**
 * src/ingestion/autonomySweeps.ts
 * OWNER: ingestion agent
 *
 * Periodic, idempotent, bounded self-healing sweeps for the ingestion
 * pipeline (autonomy diagnosis 2026-08-09). Every function here is safe to
 * call repeatedly and concurrently: each is a single bounded SQL statement
 * (or a small batch of them) gated by a WHERE clause that only ever matches
 * rows genuinely stranded, so a no-op run costs one cheap query.
 *
 * Wired hourly via deno/cronLanes.ts (see 'autonomy-sweeps' lane) — no daily
 * KV date-stamp, matching the existing 'hourly-enrichment' lane's pattern:
 * these are cheap, self-limiting (LIMIT-bounded), and safe to run every hour.
 *
 * PRINCIPLES (see task diagnosis): every stuck state gets (a) a bounded
 * automatic retry with backoff [existing per-message retry paths], (b) a
 * VISIBLE terminal dead-letter state [shared/pipelineHealth.ts], and (c) an
 * idempotent self-healing sweep that re-picks up anything stranded [here].
 */

import { extractText, getDocumentProxy } from 'unpdf';
import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { fetchHouseIndex } from './houseSource.ts';

/** Provider-placeholder bookkeeping rows (tradeLatency.ts
 *  routeProviderOnlyObservationsToReview) are working-as-designed synthetic
 *  rows, never fetched by design (raw_object_key IS NULL). Every sweep below
 *  excludes them so a legitimate placeholder never gets swept as "stuck". */
const PROVIDER_MISSING_PREFIX = 'provider-missing-%';

export interface CeilingSweepResult {
  flipped: number;
}

/**
 * Fix 2.4: a filing stuck in 'extraction_pending_local' past a generous 24h
 * ceiling gets force-advanced to 'classified' + a fresh filing.extracted
 * enqueue, independent of its own per-doc delayed filing.local_wait_check
 * message (which can be lost — see queueHandlers.ts's self-reschedule fix —
 * or simply never fire if the local worker never came back). Excludes
 * already review-resolved rows so this can never revive a filing the review
 * process closed out.
 */
export async function sweepExtractionPendingLocalCeiling(
  env: Env,
  now = new Date(),
  opts: { ceilingHours?: number; limit?: number } = {},
): Promise<CeilingSweepResult> {
  const ceilingHours = opts.ceilingHours ?? 24;
  const limit = opts.limit ?? 200;
  const cutoff = new Date(now.getTime() - ceilingHours * 3600_000).toISOString();

  const rows = await all<{ doc_id: string }>(
    env.DB,
    `SELECT f.doc_id FROM filings f
      WHERE f.ingest_status = 'extraction_pending_local'
        AND f.local_wait_expires_at IS NOT NULL
        AND f.local_wait_expires_at < ?
        AND f.doc_id NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)
      LIMIT ?`,
    [cutoff, PROVIDER_MISSING_PREFIX, limit],
  );

  let flipped = 0;
  for (const row of rows) {
    const res = await run(
      env.DB,
      `UPDATE filings SET ingest_status = 'classified'
        WHERE doc_id = ? AND ingest_status = 'extraction_pending_local'`,
      [row.doc_id],
    );
    if ((res.meta?.changes ?? 0) > 0) {
      flipped += 1;
      try {
        await env.INGEST_QUEUE.send({ type: 'filing.extracted', docId: row.doc_id });
      } catch (err) {
        console.warn(`autonomySweep: ceiling-flip enqueue failed for ${row.doc_id}:`, (err as Error).message);
      }
    }
  }
  return { flipped };
}

export interface StrandedSweepResult {
  terminalized: number;
}

/** Mid-pipeline statuses that must never sit forever without a terminal
 *  escape hatch. 'needs_review' is deliberately excluded — that state is
 *  already owned by the review queue and has its own resolution paths. */
const STRANDABLE_STATUSES = ['new', 'fetched', 'classified', 'extraction_pending_local'] as const;

/**
 * Fix 1.2 (generalized) + PRINCIPLE (b)/(c): a universal backstop so no
 * filing can sit invisible mid-pipeline forever, regardless of which stage
 * or bug stranded it. Any filing still in a non-terminal status well past
 * every stage-specific retry window (10 days — safely beyond fetcher.ts's
 * own 7-day FETCH_NOT_PUBLISHED_WINDOW_MS) is terminalized to 'error' with a
 * self-documenting message, so it is visible to every "ingest_status='error'"
 * operational query and to pipelineHealth's stranded_filings check.
 * Excludes already review-resolved rows (never revive a closed-out filing)
 * and provider-placeholder rows (working as designed, never fetched).
 */
export async function sweepStrandedFilings(
  env: Env,
  now = new Date(),
  opts: { ceilingDays?: number; limit?: number } = {},
): Promise<StrandedSweepResult> {
  const ceilingDays = opts.ceilingDays ?? 10;
  const limit = opts.limit ?? 200;
  const cutoff = new Date(now.getTime() - ceilingDays * 86_400_000).toISOString();
  const nowIso = now.toISOString();
  const statusPlaceholders = STRANDABLE_STATUSES.map(() => '?').join(',');

  const rows = await all<{ doc_id: string; ingest_status: string }>(
    env.DB,
    `SELECT f.doc_id, f.ingest_status FROM filings f
      WHERE f.ingest_status IN (${statusPlaceholders})
        AND f.first_seen_at IS NOT NULL
        AND f.first_seen_at < ?
        AND f.doc_id NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id AND rq.resolved = 1)
      LIMIT ?`,
    [...STRANDABLE_STATUSES, cutoff, PROVIDER_MISSING_PREFIX, limit],
  );

  let terminalized = 0;
  for (const row of rows) {
    const res = await run(
      env.DB,
      `UPDATE filings
          SET ingest_status = 'error',
              error = ?
        WHERE doc_id = ? AND ingest_status = ?`,
      [
        `autonomy-sweep: stranded in '${row.ingest_status}' past ${ceilingDays}d ceiling as of ${nowIso}; terminalized for visibility`,
        row.doc_id,
        row.ingest_status,
      ],
    );
    if ((res.meta?.changes ?? 0) > 0) terminalized += 1;
  }
  return { terminalized };
}

export interface FiledDateBackfillResult {
  updated: number;
  yearsFetched: string[];
}

/**
 * Fix 5.1: House's low-latency live-search detection path structurally
 * omits filed_date (only the daily bulk FD ZIP carries it); watcher.ts's own
 * passive self-heal only fires when the SAME doc is rediscovered by a later
 * scan. This targets the residual directly: for House filings still
 * filed_date-NULL past 72h, fetch the (already-exported, read-only)
 * per-year bulk index and backfill filed_date for any doc_id it resolves —
 * the exact same COALESCE-style UPDATE watcher.ts's passive path uses, so a
 * doc that already got a date some other way is never overwritten. Bounded
 * to at most 2 distinct years per run to avoid hammering the Clerk.
 */
export async function sweepFiledDateBackfill(
  env: Env,
  now = new Date(),
  opts: { staleHours?: number; limit?: number; maxYears?: number; fetchImpl?: typeof fetch } = {},
): Promise<FiledDateBackfillResult> {
  const staleHours = opts.staleHours ?? 72;
  const limit = opts.limit ?? 300;
  const maxYears = opts.maxYears ?? 2;
  const cutoff = new Date(now.getTime() - staleHours * 3600_000).toISOString();

  const stuck = await all<{ doc_id: string }>(
    env.DB,
    `SELECT doc_id FROM filings
      WHERE chamber = 'house'
        AND filed_date IS NULL
        AND ingest_status != 'error'
        AND first_seen_at IS NOT NULL
        AND first_seen_at < ?
        AND doc_id NOT LIKE ?
      LIMIT ?`,
    [cutoff, PROVIDER_MISSING_PREFIX, limit],
  );
  if (stuck.length === 0) return { updated: 0, yearsFetched: [] };

  // House pipeline doc ids are "H-{year}-{docId}" (houseDocId in
  // houseSource.ts). Group by year so each year's ZIP is fetched at most once.
  const yearsNeeded = new Set<string>();
  for (const row of stuck) {
    const m = /^H-(\d{4})-/.exec(row.doc_id);
    if (m) yearsNeeded.add(m[1]);
  }
  const years = [...yearsNeeded].slice(0, maxYears);

  const filedDateByDocId = new Map<string, string>();
  for (const year of years) {
    try {
      const index = await fetchHouseIndex(year, { fetchImpl: opts.fetchImpl });
      for (const f of index) {
        if (f.filingDate) filedDateByDocId.set(f.pipelineDocId, f.filingDate);
      }
    } catch (err) {
      console.warn(`autonomySweep: filed-date backfill fetch failed for year ${year}:`, (err as Error).message);
    }
  }

  let updated = 0;
  for (const row of stuck) {
    const filedDate = filedDateByDocId.get(row.doc_id);
    if (!filedDate) continue;
    const res = await run(
      env.DB,
      `UPDATE filings SET filed_date = ? WHERE doc_id = ? AND filed_date IS NULL`,
      [filedDate, row.doc_id],
    );
    if ((res.meta?.changes ?? 0) > 0) {
      updated += 1;
      try {
        await run(
          env.DB,
          `UPDATE disclosure_latency_candidates SET filed_date = ? WHERE doc_id = ? AND (filed_date IS NULL OR filed_date = '')`,
          [filedDate, row.doc_id],
        );
      } catch {
        /* optional table, mirrors watcher.ts's own swallow */
      }
    }
  }
  return { updated, yearsFetched: years };
}

// ---------------------------------------------------------------------------
// OGE 'undated' filing date fallback (fix 5.2)
// ---------------------------------------------------------------------------

/**
 * Best-effort printed-date extraction from OGE 278-T body text. OGE PDFs
 * commonly print a "Date of Report" / "Report Date" / "Date Signed" field
 * near a date; when no such label is found, the LAST plausible date in the
 * document is used (executive-filer signature dates are printed last). Pure
 * and unit-testable; never invents a value outside [2015-01-01, now+1day].
 */
export function extractPrintedDateFromText(text: string, now = new Date()): string | null {
  const datePattern = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/g;
  const minMs = Date.parse('2015-01-01T00:00:00Z');
  const maxMs = now.getTime() + 86_400_000;

  const toIso = (mo: string, d: string, y: string): string | null => {
    const month = Number(mo);
    const day = Number(d);
    const year = Number(y);
    if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const ms = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isFinite(ms) || ms < minMs || ms > maxMs) return null;
    return iso;
  };

  // Prefer a date near an explicit report/signature-date label.
  const labelPattern = /(date\s+of\s+report|report\s+date|date\s+signed|signature\s+date|date\s+filed)\s*[:\-]?\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/gi;
  let labelMatch: RegExpExecArray | null;
  let lastLabeled: string | null = null;
  while ((labelMatch = labelPattern.exec(text)) !== null) {
    const iso = toIso(labelMatch[2], labelMatch[3], labelMatch[4]);
    if (iso) lastLabeled = iso;
  }
  if (lastLabeled) return lastLabeled;

  // Fallback: last plausible bare date anywhere in the text.
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = datePattern.exec(text)) !== null) {
    const iso = toIso(m[1], m[2], m[3]);
    if (iso) last = iso;
  }
  return last;
}

export interface OgeUndatedBackfillResult {
  updated: number;
  attempted: number;
}

/**
 * Fix 5.2: OGE executive filings the index itself never dates (doc_id prefix
 * 'E-undated-') get one opportunistic pass at a printed date parsed straight
 * out of the already-extracted PDF text layer. Deterministic, no LLM calls —
 * text_pdf docs only (scanned_pdf has no text layer to parse; that residual
 * is the pre-existing, tracked needs_llm=true vision gap, out of scope here).
 * Only ever fills a NULL filed_date; never overwrites.
 */
export async function sweepOgeUndatedFilingDates(
  env: Env,
  opts: { limit?: number } = {},
): Promise<OgeUndatedBackfillResult> {
  const limit = opts.limit ?? 25;
  const rows = await all<{ doc_id: string; raw_object_key: string }>(
    env.DB,
    `SELECT doc_id, raw_object_key FROM filings
      WHERE doc_id LIKE 'E-undated-%'
        AND filed_date IS NULL
        AND doc_kind = 'text_pdf'
        AND raw_object_key IS NOT NULL
      LIMIT ?`,
    [limit],
  );
  let updated = 0;
  let attempted = 0;
  for (const row of rows) {
    attempted += 1;
    try {
      const obj = await env.RAW_FILES.get(row.raw_object_key);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      if (typeof (pdf as { destroy?: () => void }).destroy === 'function') {
        (pdf as { destroy: () => void }).destroy();
      }
      const flat = typeof text === 'string' ? text : (text as string[]).join('\n');
      const filedDate = extractPrintedDateFromText(flat);
      if (!filedDate) continue;
      const res = await run(
        env.DB,
        `UPDATE filings SET filed_date = ? WHERE doc_id = ? AND filed_date IS NULL`,
        [filedDate, row.doc_id],
      );
      if ((res.meta?.changes ?? 0) > 0) updated += 1;
    } catch (err) {
      console.warn(`autonomySweep: OGE undated date parse failed for ${row.doc_id}:`, (err as Error).message);
    }
  }
  return { updated, attempted };
}

export interface AutonomySweepResult {
  ceiling: CeilingSweepResult | null;
  stranded: StrandedSweepResult | null;
  filedDateBackfill: FiledDateBackfillResult | null;
  ogeUndated: OgeUndatedBackfillResult | null;
  errors: string[];
}

/**
 * Entry point wired hourly from deno/cronLanes.ts. Each sweep is isolated —
 * one failing does not block the others — and every sweep is itself bounded
 * and idempotent, so overlap between two concurrent runs is harmless (a run
 * that finds nothing left to do is a cheap no-op).
 */
export async function runAutonomySweeps(
  env: Env,
  now = new Date(),
  opts: { signal?: AbortSignal } = {},
): Promise<AutonomySweepResult> {
  const errors: string[] = [];
  const result: AutonomySweepResult = {
    ceiling: null,
    stranded: null,
    filedDateBackfill: null,
    ogeUndated: null,
    errors,
  };
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new Error('autonomy sweeps aborted');
  };

  try {
    throwIfAborted();
    result.ceiling = await sweepExtractionPendingLocalCeiling(env, now);
  } catch (err) {
    errors.push(`ceiling: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.stranded = await sweepStrandedFilings(env, now);
  } catch (err) {
    errors.push(`stranded: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.filedDateBackfill = await sweepFiledDateBackfill(env, now);
  } catch (err) {
    errors.push(`filedDateBackfill: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.ogeUndated = await sweepOgeUndatedFilingDates(env);
  } catch (err) {
    errors.push(`ogeUndated: ${(err as Error).message}`);
  }

  return result;
}
