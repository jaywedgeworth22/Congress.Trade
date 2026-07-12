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

import type { Env } from '../shared/types';
import { batch, run } from '../shared/db';
import {
  getConfig,
  getLastPollAt,
  setLastPollAt,
  shouldPollNow,
} from '../shared/config';
import { fetchHouseIndex, pollHouseLiveSearch } from './houseSource';
import { fetchSenatePtrFilings } from './senateSource';
import { recordDisclosureLatencyCandidate, storageMissing } from './fmpDisclosureLatency';
import { enqueueIngestionOutboxNow, ingestionOutboxInsertForDoc } from './outbox';
import { resolveSecret } from '../secrets/infisical';

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

/** One row to (maybe) insert + enqueue. */
export interface DiscoveredFiling {
  docId: string;
  chamber: 'house' | 'senate';
  sourceUrl: string;
  /** Official filing/report date when the source index provides it. */
  filedDate?: string | null;
  filerId?: string | null;
  filerName?: string | null;
  state?: string | null;
  district?: string | null;
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
  if (f.filerId && f.filerName) {
    await run(
      env.DB,
      `INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, party, state, district, committees)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
      [f.filerId, f.chamber, f.filerName, f.state ?? null, f.district ?? null],
    );
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
    await run(env.DB, 'UPDATE filings SET filed_date = COALESCE(filed_date, ?) WHERE doc_id = ?', [
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
        'UPDATE disclosure_latency_candidates SET filed_date = COALESCE(filed_date, ?) WHERE doc_id = ?',
        [filedDate, f.docId],
      );
    } catch (err) {
      if (!storageMissing(err)) throw err;
    }
  }
  if (f.filerId) {
    await run(env.DB, 'UPDATE filings SET filer_id = COALESCE(filer_id, ?) WHERE doc_id = ?', [
      f.filerId,
      f.docId,
    ]);
    await run(env.DB, 'UPDATE transactions SET filer_id = COALESCE(filer_id, ?) WHERE doc_id = ?', [
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

  // Intraday overlay: catch same-day PTRs that the daily XML hasn't picked up
  // yet. Fail-soft — a flaky/anti-bot live endpoint must never break the stable
  // bulk path. INSERT OR IGNORE de-dupes the overlap with the bulk rows above.
  const byDoc = new Map<string, DiscoveredFiling>();
  for (const f of ptrs) {
    byDoc.set(f.pipelineDocId, houseDiscovery(f));
  }
  if (await houseLiveSearchEnabled(env)) {
    try {
      const live = await pollHouseLiveSearch(year);
      for (const f of live) {
        if (!byDoc.has(f.pipelineDocId)) {
          byDoc.set(f.pipelineDocId, houseDiscovery(f));
        }
      }
    } catch (err) {
      console.warn('watcher: house live search failed (bulk index still used):', (err as Error).message);
    }
  }

  const discovered: DiscoveredFiling[] = Array.from(byDoc.values());
  const newCount = await persistAndEnqueue(env, discovered, nowIso);
  await logPoll(env, 'house', nowIso, newCount, nowIso);
  await setLastPollAt(env, 'house', now);
  await recordSourceAttempt(env, 'house', nowIso, 'success', newCount, null);
  return newCount;
}

/**
 * Poll the Senate efdsearch DataTables API, diff against D1, enqueue new PTRs.
 * Throws on any failure (caught by the per-source guard in runWatcher).
 */
async function pollSenate(env: Env, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const filings = await fetchSenatePtrFilings({ now, kv: env.CONFIG_KV });
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
}

export async function runWatcher(env: Env, now: Date = new Date()): Promise<WatcherResult> {
  const cfg = await getConfig(env);
  const result: WatcherResult = { house: 'skipped', senate: 'skipped' };

  // HOUSE -----------------------------------------------------------------
  try {
    const lastHouse = await getLastPollAt(env, 'house');
    if (shouldPollNow(now, cfg, lastHouse)) {
      await pollHouse(env, now);
      result.house = 'success';
    }
  } catch (err) {
    await recordSourceError(env, 'house', now.toISOString(), err);
    result.house = 'failure';
  }

  // SENATE ----------------------------------------------------------------
  try {
    const lastSenate = await getLastPollAt(env, 'senate');
    if (shouldPollNow(now, cfg, lastSenate)) {
      await pollSenate(env, now);
      result.senate = 'success';
    }
  } catch (err) {
    await recordSourceError(env, 'senate', now.toISOString(), err);
    result.senate = 'failure';
  }
  return result;
}
