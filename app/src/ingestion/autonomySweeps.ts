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
import { checkPipelineHealth } from '../shared/pipelineHealth.ts';
import { sendPushover } from '../shared/pushover.ts';
import { fetchHouseIndex } from './houseSource.ts';
import {
  maybeRunDeterministicReviewDrain,
  sweepRejectedScannedForLocalVision,
  type DeterministicDrainResult,
  type LocalVisionRequeueResult,
} from '../extraction/deterministicDrain.ts';
import { reconcileResolvedReviewStatus } from './reviewStatusReconcile.ts';

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
 *
 * Year extraction is `H-(\d{4})-` (houseDocId in houseSource.ts). Live
 * diagnosis for #1577 (2026-08-17) confirmed that regex matches every
 * official House pipeline id; do not loosen it to invent dates for
 * `provider-missing-*` stubs or `not_found` frontier-probe phantoms.
 * Those ids are absent from the Clerk index, so NULL is the honest value.
 * `not_found` is excluded so the hourly sweep does not re-fetch the ZIP
 * for the 2026-07-30 sequential-probe burst (H-2026-20035076..20035975).
 */
export async function sweepFiledDateBackfill(
  env: Env,
  now = new Date(),
  opts: { staleHours?: number; limit?: number; maxYears?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<FiledDateBackfillResult> {
  const staleHours = opts.staleHours ?? 72;
  const limit = opts.limit ?? 300;
  const maxYears = opts.maxYears ?? 1;
  const cutoff = new Date(now.getTime() - staleHours * 3600_000).toISOString();

  const stuck = await all<{ doc_id: string }>(
    env.DB,
    `SELECT doc_id FROM filings
      WHERE chamber = 'house'
        AND filed_date IS NULL
        AND ingest_status != 'error'
        AND ingest_status != 'not_found'
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
    if (opts.signal?.aborted) break;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const index = await fetchHouseIndex(year, {
        fetchImpl: opts.fetchImpl,
        relayUrl: env.HOUSE_RELAY_URL || env.INGEST_RELAY_URL,
        signal: controller.signal,
      });
      for (const f of index) {
        if (f.filingDate) filedDateByDocId.set(f.pipelineDocId, f.filingDate);
      }
    } catch (err) {
      console.warn(`autonomySweep: filed-date backfill fetch failed for year ${year}:`, (err as Error).message);
    } finally {
      clearTimeout(timeoutId);
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
      if (typeof (pdf as unknown as { destroy?: () => void }).destroy === 'function') {
        (pdf as unknown as { destroy: () => void }).destroy();
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

export interface ResolvedDesyncSweepResult {
  scanned: number;
  reconciled: number;
}

/**
 * Reconcile filings whose review_queue row says resolved=1 while
 * filings.ingest_status is still non-terminal.
 *
 * WHY THIS EXISTS (the blind spot the #1579 verifier caught): every other
 * safety net here — the classifier/fetcher no-op guard, the ceiling sweep, the
 * stranded sweep, and pipelineHealth's stranded_filings check — deliberately
 * excludes `resolved = 1` rows so a closed-out filing is never revived. That
 * assumes resolved=1 implies a terminal ingest_status. Production disproved it:
 * 562 rows (268 extraction_pending_local + 114 classified + 180 needs_review)
 * are ALL resolved=1 yet frozen at a pre-resolution status, so they were
 * invisible to every sweep AND to the health check built to surface them.
 *
 * This sweep owns exactly that population: it does NOT re-open, re-fetch, or
 * re-extract anything (the review outcome stands) — it only stamps the terminal
 * status from review_queue.resolution_kind / ingestion_decisions.  Provider-
 * missing placeholder rows are excluded.  Idempotent and bounded.
 */
export async function sweepResolvedStatusDesync(
  env: Env,
  now = new Date(),
  opts: { limit?: number } = {},
): Promise<ResolvedDesyncSweepResult> {
  const result = await reconcileResolvedReviewStatus(env, {
    apply: true,
    limit: opts.limit ?? 500,
    now,
  });
  return { scanned: result.scanned, reconciled: result.updated };
}

export interface AutonomySweepResult {
  ceiling: CeilingSweepResult | null;
  stranded: StrandedSweepResult | null;
  resolvedDesync: ResolvedDesyncSweepResult | null;
  filedDateBackfill: FiledDateBackfillResult | null;
  ogeUndated: OgeUndatedBackfillResult | null;
  livenessAlarms: LivenessAlarmResult | null;
  errors: string[];
}

export interface LivenessAlarmResult {
  evaluated: number;
  bad: number;
  notified: string[];
  recovered: string[];
}

export interface LocalVisionHostedFallbackResult {
  enqueued: number;
}

/**
 * local_mac_1 is supplemental.  Docs parked as local_vision_exhausted must
 * fall through to the hosted LLM path once, not sit suppressed forever.
 */
export async function sweepLocalVisionHostedFallback(
  env: Env,
  opts: { limit?: number } = {},
): Promise<LocalVisionHostedFallbackResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await all<{ doc_id: string; error: string | null }>(
    env.DB,
    `SELECT f.doc_id, f.error
       FROM filings f
       JOIN review_queue rq ON rq.doc_id = f.doc_id
      WHERE COALESCE(rq.resolved, 0) = 0
        AND (
          COALESCE(rq.reason, '') LIKE '%local_vision_exhausted%'
          OR COALESCE(f.error, '') LIKE '%local_vision_exhausted%'
        )
        AND COALESCE(f.error, '') NOT LIKE '%hosted_fallback_enqueued%'
        AND f.raw_object_key IS NOT NULL
      LIMIT ?`,
    [limit],
  );
  let enqueued = 0;
  for (const row of rows) {
    try {
      await env.INGEST_QUEUE.send({ type: 'filing.extracted', docId: row.doc_id });
      const stamp = `${row.error ? `${row.error}; ` : ''}hosted_fallback_enqueued`;
      await run(
        env.DB,
        `UPDATE filings SET error = ? WHERE doc_id = ?`,
        [stamp.slice(0, 1000), row.doc_id],
      );
      enqueued += 1;
    } catch (err) {
      console.warn('hosted fallback enqueue failed', row.doc_id, (err as Error).message);
    }
  }
  return { enqueued };
}

const LIVENESS_ALARM_CHECK_IDS = new Set([
  'polling_house',
  'polling_senate',
  'polling_executive',
  'latency_probes',
  'senate_relay',
  'autopilot_halt',
  'extraction_provider',
  'extraction_backlog',
]);
const LIVENESS_ALARM_KV_PREFIX = 'liveness-alarm:';
const LIVENESS_RENOTIFY_MS = 6 * 3_600_000;

interface LivenessAlarmEpisode {
  status: string;
  notifiedAt: string;
}

/**
 * Owner directive 2026-08-10: polling can never be silently off for any
 * chamber, and latency monitoring can never be silently off. The
 * polling_house/senate/executive + latency_probes pipelineHealth checks make
 * silence VISIBLE; this sweep makes it LOUD — a Pushover to the owner's
 * phone, not just a row on an admin page nobody is staring at.
 *
 * Episode semantics (matches the fleet's one-notification-per-episode
 * precedent): notify on ok->bad transition, re-notify at most every 6h while
 * still bad, send a recovery note and clear the episode on bad->ok. Episodes
 * live in CONFIG_KV so restarts/redeploys never replay an alarm storm.
 */
export async function sweepLivenessAlarms(
  env: Env,
  now = new Date(),
  deps: {
    checkHealth?: typeof checkPipelineHealth;
    push?: typeof sendPushover;
  } = {},
): Promise<LivenessAlarmResult> {
  const checkHealth = deps.checkHealth ?? checkPipelineHealth;
  const push = deps.push ?? sendPushover;
  const result: LivenessAlarmResult = { evaluated: 0, bad: 0, notified: [], recovered: [] };

  const health = await checkHealth(env, now);
  const nowIso = now.toISOString();
  for (const check of health.checks) {
    if (!LIVENESS_ALARM_CHECK_IDS.has(check.id)) continue;
    result.evaluated += 1;
    const kvKey = `${LIVENESS_ALARM_KV_PREFIX}${check.id}`;
    let episode: LivenessAlarmEpisode | null = null;
    try {
      episode = await env.CONFIG_KV.get<LivenessAlarmEpisode>(kvKey, 'json');
    } catch {}

    const isBad = check.status === 'stalled' || check.status === 'degraded';
    if (isBad) {
      result.bad += 1;
      const statusChanged = !episode || episode.status !== check.status;
      const lastNotifiedMs = episode ? Date.parse(episode.notifiedAt) : NaN;
      const renotifyDue = !Number.isFinite(lastNotifiedMs)
        || now.getTime() - lastNotifiedMs >= LIVENESS_RENOTIFY_MS;
      if (statusChanged || renotifyDue) {
        // sendPushover NEVER throws — it returns {sent:false, reason} on
        // unconfigured creds / HTTP failure / API rejection. The episode is
        // recorded ONLY on confirmed delivery, so an undelivered alarm
        // retries on the next hourly sweep instead of silently counting as
        // notified — a silently-dead alarm channel would recreate the exact
        // failure class this sweep exists to kill.
        try {
          const delivered = await push(env, {
            title: `CT ${check.status === 'stalled' ? 'DOWN' : 'DEGRADED'}: ${check.id.replace(/_/g, ' ')}`,
            message: check.detail,
            priority: check.status === 'stalled' ? 1 : 0,
            url: 'https://congress.trade/api/health',
            urlTitle: 'Pipeline health',
          });
          if (delivered.sent) {
            result.notified.push(check.id);
            await env.CONFIG_KV.put(kvKey, JSON.stringify({ status: check.status, notifiedAt: nowIso }));
          } else {
            console.error('sweepLivenessAlarms: alarm NOT delivered for', check.id, '-', delivered.reason ?? 'unknown reason');
          }
        } catch (err) {
          console.error('sweepLivenessAlarms: pushover failed for', check.id, (err as Error).message);
        }
      }
    } else if (check.status === 'ok' && episode) {
      // bad -> ok: say so once, then clear the episode. 'unknown' (signal
      // collection failed this cycle) deliberately does NOT clear or notify —
      // a DB blip mid-outage must not send a lying "recovered" note and then
      // re-alarm when collection resumes.
      try {
        const delivered = await push(env, {
          title: `CT recovered: ${check.id.replace(/_/g, ' ')}`,
          message: check.detail,
          priority: 0,
        });
        if (delivered.sent) {
          result.recovered.push(check.id);
          await env.CONFIG_KV.delete(kvKey);
        } else {
          console.error('sweepLivenessAlarms: recovery NOT delivered for', check.id, '-', delivered.reason ?? 'unknown reason');
        }
      } catch (err) {
        console.error('sweepLivenessAlarms: recovery pushover failed for', check.id, (err as Error).message);
      }
    }
  }
  return result;
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
): Promise<AutonomySweepResult & {
  deterministicDrain: DeterministicDrainResult | null;
  localVisionRequeue: LocalVisionRequeueResult | null;
  hostedFallback: LocalVisionHostedFallbackResult | null;
}> {
  const errors: string[] = [];
  const result: AutonomySweepResult & {
    deterministicDrain: DeterministicDrainResult | null;
    localVisionRequeue: LocalVisionRequeueResult | null;
    hostedFallback: LocalVisionHostedFallbackResult | null;
  } = {
    ceiling: null,
    stranded: null,
    resolvedDesync: null,
    filedDateBackfill: null,
    ogeUndated: null,
    livenessAlarms: null,
    deterministicDrain: null,
    localVisionRequeue: null,
    hostedFallback: null,
    errors,
  };
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new Error('autonomy sweeps aborted');
  };

  // A2 first: free deterministic publish must not wait on OR-halted autopilot.
  try {
    throwIfAborted();
    result.deterministicDrain = await maybeRunDeterministicReviewDrain(env, {
      signal: opts.signal,
    });
    try {
      const { maybePublishFromStoredRuns } = await import('../extraction/storedRunPublish.ts');
      await maybePublishFromStoredRuns(env, { signal: opts.signal });
    } catch (storedErr) {
      errors.push(`storedRunPublish: ${(storedErr as Error).message}`);
    }
  } catch (err) {
    errors.push(`deterministicDrain: ${(err as Error).message}`);
  }

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
    result.resolvedDesync = await sweepResolvedStatusDesync(env, now);
  } catch (err) {
    errors.push(`resolvedDesync: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.filedDateBackfill = await sweepFiledDateBackfill(env, now, { signal: opts.signal });
  } catch (err) {
    errors.push(`filedDateBackfill: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.ogeUndated = await sweepOgeUndatedFilingDates(env);
  } catch (err) {
    errors.push(`ogeUndated: ${(err as Error).message}`);
  }

  // A5/C8: one-shot local-vision requeue for rejected scanned+raw garbage OCR.
  try {
    throwIfAborted();
    result.localVisionRequeue = await sweepRejectedScannedForLocalVision(env);
  } catch (err) {
    errors.push(`localVisionRequeue: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.hostedFallback = await sweepLocalVisionHostedFallback(env);
  } catch (err) {
    errors.push(`hostedFallback: ${(err as Error).message}`);
  }

  try {
    throwIfAborted();
    result.livenessAlarms = await sweepLivenessAlarms(env, now);
  } catch (err) {
    errors.push(`livenessAlarms: ${(err as Error).message}`);
  }

  return result;
}
