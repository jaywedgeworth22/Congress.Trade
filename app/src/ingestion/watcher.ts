/**
 * src/ingestion/watcher.ts
 * OWNER: ingestion agent
 *
 * Cron entrypoint logic. Runs every minute; decides via shouldPollNow whether
 * to actually poll House + Senate disclosure indexes. For each NEW filing,
 * inserts a 'new' filings row (INSERT OR IGNORE) and enqueues a
 * {type:'filing.new'} INGEST_QUEUE message. Records cadence in ingest_log and
 * updates last-poll via setLastPollAt after successful source polls.
 *
 * Each source is wrapped in its own try/catch: one source failing (network,
 * parse, anti-bot) must NOT block the other, and the failure is logged.
 */

import type { Chamber, Env } from '../shared/types.ts';
import { batch, run } from '../shared/db.ts';
import {
  getConfig,
  getLastAttemptAt,
  getLastPollAt,
  setLastAttemptAt,
  setLastPollAt,
  shouldPollNow,
} from '../shared/config.ts';
import { fetchHouseIndex, pollHouseLiveSearch } from './houseSource.ts';
import { fetchSenatePtrFilings } from './senateSource.ts';
import { recordDisclosureLatencyCandidate, storageMissing } from './fmpDisclosureLatency.ts';
import { enqueueIngestionOutboxNow, ingestionOutboxInsertForDoc } from './outbox.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { pollOgeExecutive } from './ogeSource.ts';
import { consumeGovernedD1Writes } from '../shared/d1Budget.ts';

/** Env shape (read defensively — Env is the frozen foundation contract). */
type EnvWithFlags = Env & { HOUSE_LIVE_SEARCH_ENABLED?: string };

/** Live House search is on unless explicitly disabled (fail-soft, and
 *  Infisical-tunable so it can be toggled without a redeploy). */
async function houseLiveSearchEnabled(env: Env): Promise<boolean> {
  try {
    const live = (await resolveSecret(env, 'HOUSE_LIVE_SEARCH_ENABLED')).value;
    return (live ?? (env as EnvWithFlags).HOUSE_LIVE_SEARCH_ENABLED) !== 'false';
  } catch {
    return (env as EnvWithFlags).HOUSE_LIVE_SEARCH_ENABLED !== 'false';
  }
}

/**
 * Resolve an integer tunable (Infisical first, env var fallback — resolveSecret
 * already implements that ordering) clamped to [min, max]. Fail-soft: any
 * resolution error falls back to the env var, then the default. Never throws —
 * a secrets outage must not change polling behavior beyond using defaults.
 */
async function tunableInt(
  env: Env,
  key: keyof Env & string,
  fallback: number,
  min: number,
  max: number,
): Promise<number> {
  let raw: string | undefined;
  try {
    raw = (await resolveSecret(env, key)).value;
  } catch {
    const envValue = env[key];
    raw = typeof envValue === 'string' ? envValue : undefined;
  }
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** One row to (maybe) insert + enqueue. */
export interface DiscoveredFiling {
  docId: string;
  chamber: Chamber;
  sourceUrl: string;
  /** Official filing/report date when the source index provides it. */
  filedDate?: string | null;
  filerId?: string | null;
  filerName?: string | null;
  state?: string | null;
  district?: string | null;
  /** Curated party/portrait metadata (executive filers only — the House/Senate
   *  indexes carry neither; those columns are enriched out-of-band). */
  party?: string | null;
  photoUrl?: string | null;
}

function normalizeFilingDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return s.slice(0, 10);
}

function slugPart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function houseFilerId(first: string, last: string, stateDst: string): string | null {
  const name = slugPart([first, last].filter(Boolean).join(' '));
  if (!name) return null;
  const district = slugPart(stateDst || 'house');
  return `house-${district}-${name}`;
}

/**
 * Mint a stable synthetic filer id for a Senate PTR. The Senate feed (unlike the
 * House index) carries no district code, so we key on the disclosed name only.
 * Returns null when no name is available, leaving filer_id NULL rather than
 * minting a meaningless id.
 *
 * Mirrors houseFilerId so insertFilingIfNew writes the `filers` row and
 * back-fills filer_id on filings + transactions. Previously pollSenate set only
 * filerName (never filerId), so insertFilingIfNew's `if (f.filerId && f.filerName)`
 * guard skipped the filers row and every Senate trade surfaced with no member
 * attribution in the feed/API/SSE/exports.
 */
export function senateFilerId(fullName: string | null): string | null {
  const name = slugPart(fullName ?? '');
  return name ? `senate-${name}` : null;
}

function splitStateDistrict(stateDst: string): { state: string | null; district: string | null } {
  const m = /^([A-Z]{2})(\d{1,2})$/i.exec((stateDst || '').trim());
  if (!m) return { state: null, district: null };
  return { state: m[1].toUpperCase(), district: String(Number(m[2])) };
}

function houseDiscovery(f: { pipelineDocId: string; sourceUrl: string; filingDate: string; first: string; last: string; stateDst: string }): DiscoveredFiling {
  const sd = splitStateDistrict(f.stateDst);
  const fullName = [f.first, f.last].filter(Boolean).join(' ').trim() || null;
  return {
    docId: f.pipelineDocId,
    chamber: 'house',
    sourceUrl: f.sourceUrl,
    filedDate: f.filingDate,
    filerId: houseFilerId(f.first, f.last, f.stateDst),
    filerName: fullName,
    state: sd.state,
    district: sd.district,
  };
}

/**
 * INSERT OR IGNORE one discovered filing as a 'new' row. Returns true iff the
 * row was GENUINELY new — D1's `meta.changes` > 0 means a row was actually
 * written (we'd never seen this doc_id), with no read-back race.
 *
 * This is the single source of truth for the filings-row write, shared by the
 * cron watcher (below) and the historical House backfill crawler
 * (src/backfill/houseCrawler.ts) so the INSERT column list never drifts.
 */
export async function insertFilingIfNew(
  env: Env,
  f: DiscoveredFiling,
  nowIso: string,
): Promise<boolean> {
  // GOVERNOR 2: discovery upserts are a known storm writer (a source that
  // suddenly returns thousands of "new" rows, or a crawler loop). Past the
  // per-invocation governed-write cap this discovery is DEFERRED, not written:
  // the doc is rediscovered on the next poll, so nothing is lost — the storm
  // just degrades to bounded batches per invocation.
  if (consumeGovernedD1Writes(env, 'ingestion-discovery', 1) < 1) {
    console.warn('insertFilingIfNew deferred: D1 write governor cap reached', f.docId);
    return false;
  }
  if (f.filerId && f.filerName) {
    if (f.party || f.photoUrl) {
      // Sources that curate party/portrait metadata (the OGE executive index)
      // upsert it so pre-existing filer rows — created before the metadata was
      // curated — pick the fields up on the next poll, not just new rows.
      await run(
        env.DB,
        `INSERT INTO filers (bioguide_id, chamber, full_name, party, state, district, committees, photo_url)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(bioguide_id) DO UPDATE SET
           party = COALESCE(excluded.party, party),
           photo_url = COALESCE(excluded.photo_url, photo_url)
         WHERE (excluded.party IS NOT NULL AND (filers.party IS NULL OR filers.party != excluded.party))
            OR (excluded.photo_url IS NOT NULL AND (filers.photo_url IS NULL OR filers.photo_url != excluded.photo_url))`,
        [f.filerId, f.chamber, f.filerName, f.party ?? null, f.state ?? null, f.district ?? null, f.photoUrl ?? null],
      );
    } else {
      await run(
        env.DB,
        `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, party, state, district, committees)
         VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
        [f.filerId, f.chamber, f.filerName, f.state ?? null, f.district ?? null],
      );
    }
  }
  const filedDate = normalizeFilingDate(f.filedDate);
  const [res] = await batch(env.DB, [
    [
      `INSERT OR IGNORE INTO filings
       (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
        raw_object_key, ingest_status, doc_kind, extractor, model_version,
        confidence, first_seen_at, source_updated_at, error)
     VALUES (?, ?, ?, 'P', ?, ?, NULL, 'new', 'unknown', NULL, NULL,
             NULL, ?, NULL, NULL)`,
      [f.docId, f.chamber, f.filerId ?? null, filedDate, f.sourceUrl, nowIso],
    ],
    ingestionOutboxInsertForDoc(f.docId, nowIso),
  ]);
  // Backfill filed_date when a later, richer discovery of the same doc supplies
  // one. A House PTR first seen via the intraday live search carries no
  // FilingDate (the live-search HTML omits it -> filed_date NULL); the daily bulk
  // ZIP later surfaces the same doc WITH a date, so COALESCE it in then instead
  // of leaving the row permanently dateless.
  if (filedDate) {
    await run(env.DB, 'UPDATE filings SET filed_date = ? WHERE doc_id = ? AND filed_date IS NULL', [
      filedDate,
      f.docId,
    ]);
    // Same backfill on the latency candidate row: recordDisclosureLatencyCandidate
    // only runs for genuinely-new discoveries (see persistAndEnqueue), so a
    // duplicate discovery that finally supplies a filed_date (e.g. the bulk ZIP
    // confirming a live-search-only doc) would otherwise leave
    // disclosure_latency_candidates.filed_date permanently NULL, breaking the
    // FMP matcher's filer/date fallback for that filing. disclosure_latency_candidates
    // is an optional table (migration 0021); swallow a missing-table error the
    // same way recordDisclosureLatencyCandidate does rather than aborting the
    // whole discovery on a deployment where it hasn't been applied yet.
    try {
      await run(
        env.DB,
        'UPDATE disclosure_latency_candidates SET filed_date = ? WHERE doc_id = ? AND filed_date IS NULL',
        [filedDate, f.docId],
      );
    } catch (err) {
      if (!storageMissing(err)) throw err;
    }
  }
  if (f.filerId) {
    await run(env.DB, 'UPDATE filings SET filer_id = ? WHERE doc_id = ? AND filer_id IS NULL', [
      f.filerId,
      f.docId,
    ]);
    await run(env.DB, 'UPDATE transactions SET filer_id = ? WHERE doc_id = ? AND filer_id IS NULL', [
      f.filerId,
      f.docId,
    ]);
  }
  return (res.meta?.changes ?? 0) > 0;
}

/** Enqueue the canonical filing.new INGEST_QUEUE message for a discovered filing. */
export async function enqueueFilingNew(env: Env, f: DiscoveredFiling): Promise<boolean> {
  return enqueueIngestionOutboxNow(env, f.docId);
}

/**
 * Insert discovered filings with INSERT OR IGNORE and enqueue a filing.new
 * message for each GENUINELY-new row. Returns the count of new filings.
 */
async function persistAndEnqueue(
  env: Env,
  filings: DiscoveredFiling[],
  nowIso: string,
): Promise<number> {
  let newCount = 0;
  for (const f of filings) {
    if (await insertFilingIfNew(env, f, nowIso)) {
      await recordDisclosureLatencyCandidate(env, f, nowIso);
      await enqueueFilingNew(env, f);
      newCount += 1;
    }
  }
  return newCount;
}

/** Write one ingest_log row recording the cadence + yield of a poll. */
async function logPoll(
  env: Env,
  source: string,
  polledAtIso: string,
  newCount: number,
  firstSeenAtIso: string,
): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO ingest_log (source, polled_at, new_count, first_seen_at)
       VALUES (?, ?, ?, ?)`,
    [source, polledAtIso, newCount, firstSeenAtIso],
  );
}

export type SourceAttemptOutcome = 'success' | 'failure';

async function recordSourceAttempt(
  env: Env,
  source: 'house' | 'senate',
  attemptedAt: string,
  outcome: SourceAttemptOutcome,
  newCount: number,
  error: string | null,
): Promise<void> {
  try {
    await run(
      env.DB,
      `INSERT INTO source_attempts (source, attempted_at, outcome, new_count, error)
       VALUES (?, ?, ?, ?, ?)`,
      [source, attemptedAt, outcome, newCount, error?.slice(0, 1000) ?? null],
    );
  } catch (err) {
    // Deploys briefly run new code before /api/admin/migrate. Do not convert a
    // source success/failure into a different result solely because the new
    // observability table is not present yet.
    console.warn('watcher: failed to record source attempt:', source, (err as Error).message);
  }
}

/**
 * A source failure is "transient" when it reflects a recoverable upstream or
 * platform condition rather than a bug: anti-bot blocks (403), rate limits
 * (429), and transient D1/Workers platform limits. These recur on a normal
 * cadence (e.g. the Senate efdsearch 403), so logging them at `error` floods
 * observability and buries genuine errors. We log them at `warn` instead; the
 * daily bulk/backfill path keeps history complete regardless.
 */
export function isTransientSourceError(message: string): boolean {
  return (
    /HTTP 403\b/.test(message) ||
    /HTTP 429\b/.test(message) ||
    /Network connection lost/i.test(message) ||
    /D1 DB is overloaded/i.test(message) ||
    /Too many API requests by single Worker invocation/i.test(message) ||
    /object to be reset/i.test(message)
  );
}

/** Record a source-level failure without presenting it as a successful poll. */
async function recordSourceError(env: Env, source: 'house' | 'senate', nowIso: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (isTransientSourceError(message)) {
    console.warn(`watcher: ${source} source degraded (transient, bulk path still authoritative):`, message);
  } else {
    console.error(`watcher: ${source} source failed:`, message);
  }
  await recordSourceAttempt(env, source, nowIso, 'failure', 0, message);
}

/** Days into January during which the previous year's House index is ALSO
 *  polled (tunable via HOUSE_PRIOR_YEAR_OVERLAP_DAYS; 0 disables). */
const DEFAULT_HOUSE_PRIOR_YEAR_OVERLAP_DAYS = 14;
/** How often, at most, the prior-year ZIP is fetched during the overlap window
 *  (the regular poll cadence is 5 min; one prior-year fetch/hour is plenty and
 *  polite to the Clerk host). */
const HOUSE_PRIOR_YEAR_FETCH_INTERVAL_MS = 3600_000;
const HOUSE_PRIOR_YEAR_KV_KEY = 'house_prior_year:last_fetch_at';

/** KV counter + escalation threshold for consecutive live-search failures.
 *  The overlay fails SOFT by design (bulk index still authoritative), but a
 *  persistent failure silently degrades House discovery from intraday to
 *  daily — production data showed every filing landing only in the ~13:00 UTC
 *  bulk-XML window. Escalate to console.error (Sentry-visible) once per
 *  sustained outage window instead of warn-spam that nobody sees. */
const HOUSE_LIVE_SEARCH_FAILS_KV_KEY = 'house_live_search:consecutive_failures';
const HOUSE_LIVE_SEARCH_ESCALATE_EVERY = 12;

/**
 * True when `now` (in ET, the Clerk's clock) falls within the first
 * `overlapDays` days of January — the window where filings submitted in late
 * December can still be appearing in the PRIOR year's index after we've rolled
 * to polling the new year. Exported for tests.
 */
export function inHousePriorYearWindow(now: Date, overlapDays: number): boolean {
  if (overlapDays <= 0) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const lookup = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return lookup('month') === 1 && lookup('day') <= overlapDays;
}

/**
 * Poll the House yearly bulk index, diff against D1, enqueue new PTRs.
 * Throws on any failure (caught by the per-source guard in runWatcher).
 */
async function pollHouse(env: Env, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const year = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(now),
  );
  const all = await fetchHouseIndex(year);
  const ptrs = all.filter((f) => f.isPtr);

  const byDoc = new Map<string, DiscoveredFiling>();
  for (const f of ptrs) {
    byDoc.set(f.pipelineDocId, houseDiscovery(f));
  }

  // YEAR-BOUNDARY GAP: for the first N days of a new ET year, also sweep the
  // PRIOR year's index (hourly, not every poll). A PTR filed Dec 30 can enter
  // the {YEAR-1}FD index days later — after we've switched to polling {YEAR} —
  // and would otherwise never be discovered. Fail-soft: a prior-year fetch
  // problem must not fail the current-year poll.
  const overlapDays = await tunableInt(
    env,
    'HOUSE_PRIOR_YEAR_OVERLAP_DAYS',
    DEFAULT_HOUSE_PRIOR_YEAR_OVERLAP_DAYS,
    0,
    31,
  );
  if (inHousePriorYearWindow(now, overlapDays)) {
    try {
      const lastIso = env.CONFIG_KV ? await env.CONFIG_KV.get(HOUSE_PRIOR_YEAR_KV_KEY) : null;
      const lastMs = lastIso ? Date.parse(lastIso) : NaN;
      if (!Number.isFinite(lastMs) || now.getTime() - lastMs >= HOUSE_PRIOR_YEAR_FETCH_INTERVAL_MS) {
        const prior = (await fetchHouseIndex(year - 1)).filter((f) => f.isPtr);
        for (const f of prior) {
          if (!byDoc.has(f.pipelineDocId)) byDoc.set(f.pipelineDocId, houseDiscovery(f));
        }
        if (env.CONFIG_KV) await env.CONFIG_KV.put(HOUSE_PRIOR_YEAR_KV_KEY, nowIso);
      }
    } catch (err) {
      console.warn('watcher: house prior-year index poll failed (current year unaffected):', (err as Error).message);
    }
  }

  // Intraday overlay: catch same-day PTRs that the daily XML hasn't picked up
  // yet. Fail-soft — a flaky/anti-bot live endpoint must never break the stable
  // bulk path. INSERT OR IGNORE de-dupes the overlap with the bulk rows above.
  if (await houseLiveSearchEnabled(env)) {
    let liveErr: Error | null = null;
    try {
      const live = await pollHouseLiveSearch(year);
      for (const f of live) {
        if (!byDoc.has(f.pipelineDocId)) {
          byDoc.set(f.pipelineDocId, houseDiscovery(f));
        }
      }
    } catch (err) {
      liveErr = err as Error;
    }
    // Consecutive-failure counter — fully isolated in its own try/catch. A KV
    // blip here must never (a) fall into the poll's failure path and record a
    // live-search *success* as a failure, nor (b) escape and abort the
    // authoritative bulk persist/enqueue below. The observability overlay is
    // strictly best-effort; the bulk path is not.
    let fails = liveErr ? 1 : 0;
    try {
      if (env.CONFIG_KV) {
        if (!liveErr) {
          const prevFails = parseInt((await env.CONFIG_KV.get(HOUSE_LIVE_SEARCH_FAILS_KV_KEY)) ?? '0', 10) || 0;
          if (prevFails !== 0) await env.CONFIG_KV.put(HOUSE_LIVE_SEARCH_FAILS_KV_KEY, '0');
        } else {
          fails = (parseInt((await env.CONFIG_KV.get(HOUSE_LIVE_SEARCH_FAILS_KV_KEY)) ?? '0', 10) || 0) + 1;
          await env.CONFIG_KV.put(HOUSE_LIVE_SEARCH_FAILS_KV_KEY, String(fails));
        }
      }
    } catch (counterErr) {
      console.warn(
        'watcher: house live-search failure-counter update failed (ignored):',
        (counterErr as Error).message,
      );
    }
    if (liveErr) {
      if (fails % HOUSE_LIVE_SEARCH_ESCALATE_EVERY === 0) {
        console.error(
          `watcher: house live search has failed ${fails} consecutive polls — intraday House discovery is degraded to the daily bulk index:`,
          liveErr.message,
        );
      } else {
        console.warn('watcher: house live search failed (bulk index still used):', liveErr.message);
      }
    }
  }

  const discovered: DiscoveredFiling[] = Array.from(byDoc.values());
  const newCount = await persistAndEnqueue(env, discovered, nowIso);
  await logPoll(env, 'house', nowIso, newCount, nowIso);
  await setLastPollAt(env, 'house', now);
  await recordSourceAttempt(env, 'house', nowIso, 'success', newCount, null);
  return newCount;
}

/** Default / max lookback windows for the Senate submitted-date filter.
 *  Tunable via SENATE_LOOKBACK_DAYS / SENATE_MAX_LOOKBACK_DAYS. */
const DEFAULT_SENATE_LOOKBACK_DAYS = 7;
const DEFAULT_SENATE_MAX_LOOKBACK_DAYS = 30;
/** Hard ceiling on the tunable max so a typo'd knob can't request years of
 *  DataTables pages in a single cron tick. */
const SENATE_LOOKBACK_HARD_CAP_DAYS = 365;
const SENATE_DEEP_SWEEP_KV_KEY = 'senate_deep_sweep:lastdate';

/**
 * Effective lookback (days) for a Senate discovery poll.
 *
 * The base window (default 7d) only works while polling is healthy. Two
 * recovery mechanisms widen it, both bounded by maxDays:
 *   - GAP CATCH-UP: when the last SUCCESSFUL senate poll is older than the
 *     base window (an anti-bot 403 stretch, a deploy break, a parser
 *     regression), the window covers the whole outage + 1 day of margin.
 *     Previously a >7-day outage meant every filing submitted before the
 *     recovery was PERMANENTLY missed — there was no sweep that ever looked
 *     back further.
 *   - DAILY DEEP SWEEP: once per UTC day the poll uses the full maxDays
 *     window regardless of health, so slow-listed/backdated submissions and
 *     any silent same-window misses self-heal within a day.
 * Exported for tests.
 */
export function computeSenateLookbackDays(
  now: Date,
  lastSuccessAt: Date | null,
  baseDays: number,
  maxDays: number,
  deepSweepDue: boolean,
): number {
  const max = Math.max(baseDays, maxDays);
  if (deepSweepDue || !lastSuccessAt) return max;
  const gapDays = Math.ceil((now.getTime() - lastSuccessAt.getTime()) / 86_400_000) + 1;
  return Math.min(max, Math.max(baseDays, gapDays));
}

/**
 * Poll the Senate efdsearch DataTables API, diff against D1, enqueue new PTRs.
 * Throws on any failure (caught by the per-source guard in runWatcher).
 */
async function pollSenate(env: Env, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const baseDays = await tunableInt(
    env,
    'SENATE_LOOKBACK_DAYS',
    DEFAULT_SENATE_LOOKBACK_DAYS,
    1,
    SENATE_LOOKBACK_HARD_CAP_DAYS,
  );
  const maxDays = await tunableInt(
    env,
    'SENATE_MAX_LOOKBACK_DAYS',
    DEFAULT_SENATE_MAX_LOOKBACK_DAYS,
    baseDays,
    SENATE_LOOKBACK_HARD_CAP_DAYS,
  );
  const today = nowIso.slice(0, 10);
  let deepSweepDue = false;
  if (env.CONFIG_KV) {
    try {
      deepSweepDue = (await env.CONFIG_KV.get(SENATE_DEEP_SWEEP_KV_KEY)) !== today;
    } catch {
      /* KV read failure -> stay on the regular window */
    }
  }
  const lastSuccessAt = await getLastPollAt(env, 'senate');
  const lookbackDays = computeSenateLookbackDays(now, lastSuccessAt, baseDays, maxDays, deepSweepDue);
  const since = new Date(now.getTime() - lookbackDays * 86_400_000);
  const filings = await fetchSenatePtrFilings({ now, since, kv: env.CONFIG_KV });
  const discovered: DiscoveredFiling[] = filings.map((f) => {
    const filerName = f.fullName || [f.first, f.last].filter(Boolean).join(' ').trim() || null;
    return {
      docId: f.pipelineDocId,
      chamber: 'senate' as const,
      sourceUrl: f.sourceUrl,
      filedDate: f.filedDate,
      filerId: senateFilerId(filerName),
      filerName,
    };
  });
  const newCount = await persistAndEnqueue(env, discovered, nowIso);
  await logPoll(env, 'senate', nowIso, newCount, nowIso);
  await setLastPollAt(env, 'senate', now);
  await recordSourceAttempt(env, 'senate', nowIso, 'success', newCount, null);
  // Stamp the deep sweep ONLY after a fully successful poll: a 403 day must
  // not consume the day's widened window.
  if (deepSweepDue && env.CONFIG_KV) {
    try {
      await env.CONFIG_KV.put(SENATE_DEEP_SWEEP_KV_KEY, today, { expirationTtl: 172800 });
    } catch {
      /* best-effort; worst case tomorrow's first poll widens again */
    }
  }
  return newCount;
}

/**
 * Called from scheduled() on every cron tick. Internally gates on shouldPollNow
 * per source, then polls + enqueues new filings. Never throws: a failing source
 * is logged and recorded, leaving the other source unaffected.
 */
export interface WatcherResult {
  house: SourceAttemptOutcome | 'skipped';
  senate: SourceAttemptOutcome | 'skipped';
  executive: SourceAttemptOutcome | 'skipped';
}

/**
 * Poll the OGE President/VP index for new executive 278-T filings. Self-gated
 * to a slow cadence inside pollOgeExecutive (filings land every few weeks);
 * returns the count of genuinely-new filings, or null when disabled/not due.
 */
export async function pollExecutive(
  env: Env,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<number | null> {
  const nowIso = now.toISOString();
  const filings = await pollOgeExecutive(env, now, fetch, opts);
  if (filings === null) return null;
  const newCount = await persistAndEnqueue(env, filings, nowIso);
  await setLastPollAt(env, 'oge', now);
  await logPoll(env, 'oge', nowIso, newCount, nowIso);
  return newCount;
}

export async function runWatcher(env: Env, now: Date = new Date()): Promise<WatcherResult> {
  const cfg = await getConfig(env);
  const result: WatcherResult = { house: 'skipped', senate: 'skipped', executive: 'skipped' };

  // HOUSE -----------------------------------------------------------------
  try {
    const lastHouse = await getLastPollAt(env, 'house');
    if (shouldPollNow(now, cfg, lastHouse)) {
      const lastAttempt = await getLastAttemptAt(env, 'house');
      const elapsedSec = lastAttempt ? (now.getTime() - lastAttempt.getTime()) / 1000 : Infinity;
      const lastAttemptFailed = lastAttempt && (!lastHouse || lastHouse.getTime() < lastAttempt.getTime());
      if (lastAttemptFailed && elapsedSec < 600) {
        // Skip this poll tick to respect failure backoff
      } else {
        await setLastAttemptAt(env, 'house', now);
        await pollHouse(env, now);
        result.house = 'success';
      }
    }
  } catch (err) {
    await recordSourceError(env, 'house', now.toISOString(), err);
    result.house = 'failure';
  }

  // SENATE ----------------------------------------------------------------
  try {
    const lastSenate = await getLastPollAt(env, 'senate');
    if (shouldPollNow(now, cfg, lastSenate)) {
      const lastAttempt = await getLastAttemptAt(env, 'senate');
      const elapsedSec = lastAttempt ? (now.getTime() - lastAttempt.getTime()) / 1000 : Infinity;
      const lastAttemptFailed = lastAttempt && (!lastSenate || lastSenate.getTime() < lastAttempt.getTime());
      if (lastAttemptFailed && elapsedSec < 600) {
        // Skip this poll tick to respect failure backoff
      } else {
        await setLastAttemptAt(env, 'senate', now);
        await pollSenate(env, now);
        result.senate = 'success';
      }
    }
  } catch (err) {
    await recordSourceError(env, 'senate', now.toISOString(), err);
    result.senate = 'failure';
  }

  // EXECUTIVE (OGE 278-T) ---------------------------------------------------
  // Entirely fail-soft and self-gated to a slow cadence; an OGE outage must
  // never affect House/Senate polling above.
  try {
    const polled = await pollExecutive(env, now);
    if (polled !== null) result.executive = 'success';
  } catch (err) {
    console.warn('watcher: executive (OGE) source failed:', (err as Error).message);
    result.executive = 'failure';
  }
  return result;
}
