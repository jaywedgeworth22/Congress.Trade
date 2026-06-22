/**
 * src/ingestion/watcher.ts
 * OWNER: ingestion agent
 *
 * Cron entrypoint logic. Runs every minute; decides via shouldPollNow whether
 * to actually poll House + Senate disclosure indexes. For each NEW filing,
 * inserts a 'new' filings row (INSERT OR IGNORE) and enqueues a
 * {type:'filing.new'} INGEST_QUEUE message. Records cadence in ingest_log and
 * updates last-poll via setLastPollAt.
 *
 * Each source is wrapped in its own try/catch: one source failing (network,
 * parse, anti-bot) must NOT block the other, and the failure is logged.
 */

import type { Env } from '../shared/types';
import { run } from '../shared/db';
import {
  getConfig,
  getLastPollAt,
  setLastPollAt,
  shouldPollNow,
} from '../shared/config';
import { fetchHouseIndex, pollHouseLiveSearch } from './houseSource';
import { fetchSenatePtrFilings } from './senateSource';

/** Env shape (read defensively — Env is the frozen foundation contract). */
type EnvWithFlags = Env & { HOUSE_LIVE_SEARCH_ENABLED?: string };

/** Live House search is on unless explicitly disabled (it is fail-soft). */
function houseLiveSearchEnabled(env: Env): boolean {
  return (env as EnvWithFlags).HOUSE_LIVE_SEARCH_ENABLED !== 'false';
}

/** One row to (maybe) insert + enqueue. */
export interface DiscoveredFiling {
  docId: string;
  chamber: 'house' | 'senate';
  sourceUrl: string;
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
  const res = await run(
    env.DB,
    `INSERT OR IGNORE INTO filings
       (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
        raw_object_key, ingest_status, doc_kind, extractor, model_version,
        confidence, first_seen_at, source_updated_at, error)
     VALUES (?, ?, NULL, 'P', NULL, ?, NULL, 'new', 'unknown', NULL, NULL,
             NULL, ?, NULL, NULL)`,
    [f.docId, f.chamber, f.sourceUrl, nowIso],
  );
  return (res.meta?.changes ?? 0) > 0;
}

/** Enqueue the canonical filing.new INGEST_QUEUE message for a discovered filing. */
export async function enqueueFilingNew(env: Env, f: DiscoveredFiling): Promise<void> {
  await env.INGEST_QUEUE.send({
    type: 'filing.new',
    docId: f.docId,
    chamber: f.chamber,
    sourceUrl: f.sourceUrl,
  });
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

/** Record a source-level failure against the source's ingest_log row. */
async function recordSourceError(env: Env, source: string, nowIso: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`watcher: ${source} source failed:`, message);
  try {
    // new_count=0 with an error message in first_seen_at slot would corrupt the
    // cadence column; instead we just emit a log row with 0 yield so the poll
    // attempt is still visible, and surface the error to the console.
    await logPoll(env, source, nowIso, 0, nowIso);
  } catch (logErr) {
    console.error(`watcher: failed to write ingest_log for ${source}:`, logErr);
  }
}

/**
 * Poll the House yearly bulk index, diff against D1, enqueue new PTRs.
 * Throws on any failure (caught by the per-source guard in runWatcher).
 */
async function pollHouse(env: Env, now: Date): Promise<void> {
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
    byDoc.set(f.pipelineDocId, {
      docId: f.pipelineDocId,
      chamber: 'house',
      sourceUrl: f.sourceUrl,
    });
  }
  if (houseLiveSearchEnabled(env)) {
    try {
      const live = await pollHouseLiveSearch(year);
      for (const f of live) {
        if (!byDoc.has(f.pipelineDocId)) {
          byDoc.set(f.pipelineDocId, {
            docId: f.pipelineDocId,
            chamber: 'house',
            sourceUrl: f.sourceUrl,
          });
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
}

/**
 * Poll the Senate efdsearch DataTables API, diff against D1, enqueue new PTRs.
 * Throws on any failure (caught by the per-source guard in runWatcher).
 */
async function pollSenate(env: Env, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const filings = await fetchSenatePtrFilings({ now });
  const discovered: DiscoveredFiling[] = filings.map((f) => ({
    docId: f.pipelineDocId,
    chamber: 'senate',
    sourceUrl: f.sourceUrl,
  }));
  const newCount = await persistAndEnqueue(env, discovered, nowIso);
  await logPoll(env, 'senate', nowIso, newCount, nowIso);
  await setLastPollAt(env, 'senate', now);
}

/**
 * Called from scheduled() on every cron tick. Internally gates on shouldPollNow
 * per source, then polls + enqueues new filings. Never throws: a failing source
 * is logged and recorded, leaving the other source unaffected.
 */
export async function runWatcher(env: Env, now: Date = new Date()): Promise<void> {
  const cfg = await getConfig(env);

  // HOUSE -----------------------------------------------------------------
  try {
    const lastHouse = await getLastPollAt(env, 'house');
    if (shouldPollNow(now, cfg, lastHouse)) {
      await pollHouse(env, now);
    }
  } catch (err) {
    await recordSourceError(env, 'house', now.toISOString(), err);
    // Still stamp last-poll so a hard-failing source doesn't hammer every tick.
    try {
      await setLastPollAt(env, 'house', now);
    } catch {
      /* ignore */
    }
  }

  // SENATE ----------------------------------------------------------------
  try {
    const lastSenate = await getLastPollAt(env, 'senate');
    if (shouldPollNow(now, cfg, lastSenate)) {
      await pollSenate(env, now);
    }
  } catch (err) {
    await recordSourceError(env, 'senate', now.toISOString(), err);
    try {
      await setLastPollAt(env, 'senate', now);
    } catch {
      /* ignore */
    }
  }
}
