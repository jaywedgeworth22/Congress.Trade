/**
 * src/backfill/houseCrawler.ts
 * OWNER: backfill agent
 *
 * House HISTORICAL backfill crawler — the PRIMARY-fidelity counterpart to the
 * low-fidelity seed dataset (src/backfill/seed.ts).
 *
 * The seed dataset only backfilled Senate (the House aggregate mirror is gone),
 * so House history is missing from `transactions`. This crawler walks the US
 * House Clerk's per-year bulk financial-disclosure indexes (the {YEAR}FD.ZIP
 * files, parsed by ingestion/houseSource.ts) and feeds every Periodic
 * Transaction Report (PTR) into the EXISTING live ingestion pipeline by emitting
 * the SAME `filing.new` INGEST_QUEUE message the cron watcher emits. Each filing
 * therefore flows fetch -> classify -> extract -> normalize identically to a
 * live one and lands in the same `transactions` table with source='primary'.
 *
 * LOAD NOTE: enqueuing a `filing.new` message causes the queue consumer to fetch
 * that PTR's PDF from disclosures-clerk.house.gov (fetcher stage). So `maxFilings`
 * is a real cap on load against the gov server in a single run — bound it on the
 * first run, then widen. Text-layer PDFs extract for free; scanned/image PDFs are
 * sent to Gemini OCR (costs an API call), which is a further reason to bound runs.
 *
 * Idempotency: filings rows are INSERT OR IGNORE on doc_id and we only enqueue
 * when D1's meta.changes reports a genuinely-new row, so re-running a year (or
 * the whole range) never double-enqueues an already-seen PTR.
 */

import type { Env } from '../shared/types';
import { run } from '../shared/db';
import { fetchHouseIndex, type HouseFiling } from '../ingestion/houseSource';

// ---------------------------------------------------------------------------
// Public contract (mirrors the *BackfillOptions/*BackfillResult conventions in
// src/backfill/seed.ts: optional bounds, dryRun, fail-soft `errors`, injectable
// impl for tests).
// ---------------------------------------------------------------------------

export interface HouseBackfillOptions {
  /** First disclosure year to crawl (inclusive). Defaults to 2014. */
  fromYear?: number;
  /** Last disclosure year to crawl (inclusive). Defaults to the current UTC year. */
  toYear?: number;
  /** Global cap on `filing.new` messages enqueued in this run. Defaults to Infinity. */
  maxFilings?: number;
  /** If true, discover + persist nothing-new is still counted, but never enqueue. */
  dryRun?: boolean;
  /**
   * Injectable index fetcher (tests). Defaults to the real
   * {@link fetchHouseIndex}. Mirrors how seed.ts accepts `fetchImpl` so the
   * year-range / filtering / cap logic is unit-testable with no network.
   */
  fetchIndexImpl?: (year: number | string) => Promise<HouseFiling[]>;
}

export interface HouseBackfillResult {
  /** Effective first year crawled. */
  fromYear: number;
  /** Effective last year crawled. */
  toYear: number;
  /** PTR filings rows touched (INSERT OR IGNORE attempted), across all years. */
  discovered: number;
  /** `filing.new` messages actually enqueued (genuinely-new, under the cap). */
  enqueued: number;
  /** PTRs skipped (already-seen duplicate, dryRun, or over the maxFilings cap). */
  skipped: number;
  /** Per-year enqueued counts (keyed by year string). */
  byYear: Record<string, number>;
  /** Soft, per-year errors. A failing year is recorded and does not abort the run. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Crawl the House Clerk yearly bulk indexes from `fromYear` to `toYear`
 * (inclusive), filter each year's filings to PTRs, persist a `filings` row for
 * each, and enqueue a `filing.new` message for every genuinely-new PTR (subject
 * to the global `maxFilings` cap). Fails soft per-year.
 *
 * The persist + enqueue logic is a 1:1 mirror of ingestion/watcher.ts's
 * persistAndEnqueue(): identical 15-column INSERT OR IGNORE, identical
 * meta.changes "genuinely new" gate, identical filing.new message shape — so a
 * historical PTR is indistinguishable from a live one to the rest of the
 * pipeline.
 */
export async function runHouseHistoricalBackfill(
  env: Env,
  opts: HouseBackfillOptions = {},
): Promise<HouseBackfillResult> {
  const toYear = opts.toYear ?? new Date().getUTCFullYear();
  const fromYear = opts.fromYear ?? 2014;
  const maxFilings = opts.maxFilings ?? Number.POSITIVE_INFINITY;
  const dryRun = opts.dryRun ?? false;
  const fetchIndex = opts.fetchIndexImpl ?? fetchHouseIndex;

  const result: HouseBackfillResult = {
    fromYear,
    toYear,
    discovered: 0,
    enqueued: 0,
    skipped: 0,
    byYear: {},
    errors: [],
  };

  for (let year = fromYear; year <= toYear; year++) {
    const yearKey = String(year);
    result.byYear[yearKey] = result.byYear[yearKey] ?? 0;

    let filings: HouseFiling[];
    try {
      filings = await fetchIndex(year);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${year}: ${msg}`);
      continue; // fail soft — move to the next year.
    }

    // Same filing-type test the watcher uses: PTR === FilingType 'P', exposed as
    // the precomputed `isPtr` flag on HouseFiling.
    const ptrs = filings.filter((f) => f.isPtr);

    for (const f of ptrs) {
      // Derive docId + sourceUrl exactly as watcher.ts does: the canonical
      // pipeline doc id `H-{year}-{DocID}` (houseDocId) and the direct PTR PDF
      // url (housePtrPdfUrl), both precomputed on HouseFiling.
      const docId = f.pipelineDocId;
      const sourceUrl = f.sourceUrl;

      const nowIso = new Date().toISOString();
      // INSERT OR IGNORE: only writes when doc_id is unseen. D1 meta.changes is
      // the "genuinely new" signal (no read-back race). Column list/order/values
      // are identical to watcher.ts persistAndEnqueue().
      const res = await run(
        env.DB,
        `INSERT OR IGNORE INTO filings
           (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
            raw_object_key, ingest_status, doc_kind, extractor, model_version,
            confidence, first_seen_at, source_updated_at, error)
         VALUES (?, ?, NULL, 'P', NULL, ?, NULL, 'new', 'unknown', NULL, NULL,
                 NULL, ?, NULL, NULL)`,
        [docId, 'house', sourceUrl, nowIso],
      );
      result.discovered += 1;

      const changed = (res.meta?.changes ?? 0) > 0;
      // Skip when: not new (dup), dryRun, or we've hit the global enqueue cap.
      if (!changed || dryRun || result.enqueued >= maxFilings) {
        result.skipped += 1;
        continue;
      }

      await env.INGEST_QUEUE.send({
        type: 'filing.new',
        docId,
        chamber: 'house',
        sourceUrl,
      });
      result.enqueued += 1;
      result.byYear[yearKey] += 1;
    }
  }

  return result;
}
