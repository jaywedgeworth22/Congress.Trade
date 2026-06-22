/**
 * src/admin/routes.ts
 * OWNER: admin agent
 *
 * Admin Hono router (mounted under /api/admin). Endpoints:
 *   GET   /poll-config              -> current PollConfig
 *   PUT   /poll-config              -> update schedule / aggressiveMode (setConfig)
 *   GET   /poll-config/aggressive   -> aggressiveMode toggle convenience read
 *   GET   /review-queue             -> list unresolved review items
 *   POST  /review/:docId            -> {decision:'confirm'|'reject', edits?}
 *   GET   /sources/health           -> ingest_log aggregates per source
 *   GET   /subscriptions            -> admin list of subscriptions
 *
 * AUTH (deny-by-default once provisioned). A request is authorized if EITHER:
 *   1. Bearer token — env.ADMIN_TOKEN is set and the request carries a matching
 *      `Authorization: Bearer <ADMIN_TOKEN>` (good for curl / cron / automation); OR
 *   2. Cloudflare Access — an Access application fronts /api/admin/* and the
 *      `Cf-Access-Jwt-Assertion` JWT verifies against the team keys with an
 *      `aud` matching ACCESS_AUD and an authenticated email on ADMIN_EMAILS
 *      (good for humans signing in with Google/SSO — no token to paste).
 *
 *   The surface stays OPEN only when NEITHER mechanism is configured (local dev
 *   / unprovisioned deploys); a one-time console warning then flags the gap.
 *   Provision `wrangler secret put ADMIN_TOKEN`, and/or set ADMIN_EMAILS +
 *   ACCESS_AUD + ACCESS_TEAM_DOMAIN (with an Access app in front), to lock down.
 */

import { Hono } from 'hono';
import type { Env, PollConfig, PollWindow, TxType } from '../shared/types';
import { all, get, run } from '../shared/db';
import { getConfig, setConfig } from '../shared/config';
import { uuid } from '../shared/ids';
import { listSubscriptions } from '../delivery/subscriptions';
import { runSeedBackfillFromEnv } from '../backfill/seed';
import { runHouseHistoricalBackfill } from '../backfill/houseCrawler';
import { extractParsed } from '../extraction/orchestrator';
import { normalize, recomputeTransactions, CONFIDENCE_THRESHOLD } from '../extraction/normalizer';
import type { Chamber } from '../shared/types';
import { verifyAccessJwt, certsUrl, parseEmailAllowlist } from './access';
import { getLogoDisplay, setLogoDisplay } from '../shared/settings';
import {
  DEFAULT_CANDIDATES,
  runCandidateOnDoc,
  summarizeModels,
  type BakeoffCandidate,
  type CandidateDocResult,
  type Provider,
} from '../extraction/bakeoff';
import { runEnrichment, getDailyUsed } from '../enrichment/service';

// Optional secrets/vars; not declared on Env (frozen). Read defensively.
type EnvWithAdmin = Env & {
  /** Shared bearer token for automation. */
  ADMIN_TOKEN?: string;
  /** Comma/space-separated email allowlist for Cloudflare Access sign-in. */
  ADMIN_EMAILS?: string;
  /** Access team name ("myteam") or hostname ("myteam.cloudflareaccess.com"). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag. */
  ACCESS_AUD?: string;
};

let warnedOpenAdmin = false;

/**
 * Admin auth — authorized if a valid bearer token OR an allowlisted, verified
 * Cloudflare Access identity is presented. Open only when neither is configured.
 */
async function isAuthorized(
  env: EnvWithAdmin,
  headers: { authorization?: string; accessJwt?: string },
): Promise<boolean> {
  const token = env.ADMIN_TOKEN;
  const allow = parseEmailAllowlist(env.ADMIN_EMAILS);
  const aud = env.ACCESS_AUD;
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const tokenConfigured = !!token;
  const accessConfigured = !!(aud && teamDomain && allow.size > 0);

  if (!tokenConfigured && !accessConfigured) {
    if (!warnedOpenAdmin) {
      warnedOpenAdmin = true;
      console.warn(
        'admin: neither ADMIN_TOKEN nor Cloudflare Access (ADMIN_EMAILS + ' +
          'ACCESS_AUD + ACCESS_TEAM_DOMAIN) is configured — the admin API is OPEN. ' +
          'Run `wrangler secret put ADMIN_TOKEN` and/or set the Access vars to lock it down.',
      );
    }
    return true; // nothing configured -> open (dev)
  }

  // 1) Bearer token (automation / curl).
  if (tokenConfigured && headers.authorization === `Bearer ${token}`) return true;

  // 2) Cloudflare Access identity (humans). Verify signature + aud + allowlist.
  if (accessConfigured && headers.accessJwt) {
    const res = await verifyAccessJwt(headers.accessJwt, {
      aud: aud as string,
      allow,
      jwksUrl: certsUrl(teamDomain as string),
    });
    if (res.ok) return true;
    console.warn(`admin: Cloudflare Access JWT rejected — ${res.reason}`);
  }

  return false;
}

/** Validate a PollWindow[] schedule shape. Returns an error string or null. */
function validateSchedule(schedule: unknown): string | null {
  if (!Array.isArray(schedule)) return 'schedule must be an array';
  if (schedule.length === 0) return 'schedule must have at least one window';
  for (const [i, w] of schedule.entries()) {
    if (typeof w !== 'object' || w === null) return `schedule[${i}] must be an object`;
    const win = w as Record<string, unknown>;
    if (
      !Array.isArray(win.daysOfWeek) ||
      !win.daysOfWeek.every((d) => typeof d === 'number' && d >= 0 && d <= 6)
    ) {
      return `schedule[${i}].daysOfWeek must be numbers in [0,6]`;
    }
    if (typeof win.startHourET !== 'number' || win.startHourET < 0 || win.startHourET > 24) {
      return `schedule[${i}].startHourET must be a number in [0,24]`;
    }
    if (typeof win.endHourET !== 'number' || win.endHourET < 0 || win.endHourET > 24) {
      return `schedule[${i}].endHourET must be a number in [0,24]`;
    }
    if (win.startHourET >= win.endHourET) {
      return `schedule[${i}].startHourET must be < endHourET`;
    }
    if (typeof win.intervalSec !== 'number' || win.intervalSec <= 0) {
      return `schedule[${i}].intervalSec must be a positive number`;
    }
  }
  return null;
}

interface ReviewRow {
  doc_id: string;
  reason: string | null;
  payload: string | null;
  created_at: string | null;
  resolved: number | null;
}

interface EditedTx {
  filerId?: string | null;
  txDate?: string | null;
  owner?: string | null;
  assetName?: string;
  ticker?: string | null;
  assetType?: string | null;
  txType?: TxType;
  amountMin?: number | null;
  amountMax?: number | null;
  isOption?: boolean;
  capGainsOver200?: boolean;
  rawText?: string;
  confidence?: number;
}

// --- Member photo enrichment (name -> bioguide -> unitedstates/images CDN) ---

const LEGISLATOR_SOURCES = [
  'https://unitedstates.github.io/congress-legislators/legislators-current.json',
  'https://unitedstates.github.io/congress-legislators/legislators-historical.json',
];

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * Normalize a member name for matching: lowercase, strip punctuation, drop
 * middle initials (single letters) and suffixes. "Ron L Wyden" -> "ron wyden".
 */
function normName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_SUFFIXES.has(t))
    .join(' ')
    .trim();
}

interface Legislator {
  id?: { bioguide?: string };
  name?: { first?: string; last?: string; official_full?: string; nickname?: string };
}

/** Build a normalized-name -> bioguide map from the congress-legislators data. */
async function buildBioguideMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const url of LEGISLATOR_SOURCES) {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'congress-feed/0.1 (+https://congress.trade)',
        accept: 'application/json',
      },
    });
    if (!res.ok) continue;
    const list = (await res.json()) as Legislator[];
    for (const leg of list) {
      const bio = leg.id?.bioguide;
      if (!bio) continue;
      const n = leg.name ?? {};
      const candidates = [
        n.first && n.last ? `${n.first} ${n.last}` : '',
        n.nickname && n.last ? `${n.nickname} ${n.last}` : '',
        n.official_full ?? '',
      ];
      for (const raw of candidates) {
        const k = normName(raw);
        if (k && !map.has(k)) map.set(k, bio); // current list is loaded first; it wins
      }
    }
  }
  return map;
}

function photoUrlFor(bioguide: string): string {
  return `https://unitedstates.github.io/images/congress/225x275/${bioguide}.jpg`;
}

export function buildAdminRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // Auth gate applied to every admin route: bearer token OR Cloudflare Access.
  r.use('*', async (c, next) => {
    const env = c.env as EnvWithAdmin;
    const ok = await isAuthorized(env, {
      authorization: c.req.header('Authorization'),
      accessJwt: c.req.header('Cf-Access-Jwt-Assertion'),
    });
    if (!ok) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  // --- GET /poll-config ---------------------------------------------------
  r.get('/poll-config', async (c) => {
    const cfg = await getConfig(c.env);
    return c.json(cfg);
  });

  // --- PUT /poll-config ---------------------------------------------------
  // Accepts { schedule?: PollWindow[], aggressiveMode?: boolean }. Persists via
  // setConfig (D1 + KV cache); effective within ~60s (watcher reads getConfig).
  r.put('/poll-config', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const current = await getConfig(c.env);
    const next: PollConfig = {
      schedule: current.schedule,
      aggressiveMode: current.aggressiveMode,
      updatedAt: current.updatedAt,
    };

    if (body.schedule !== undefined) {
      const err = validateSchedule(body.schedule);
      if (err) return c.json({ error: err }, 400);
      next.schedule = body.schedule as PollWindow[];
    }
    if (body.aggressiveMode !== undefined) {
      if (typeof body.aggressiveMode !== 'boolean') {
        return c.json({ error: 'aggressiveMode must be a boolean' }, 400);
      }
      next.aggressiveMode = body.aggressiveMode;
    }

    const saved = await setConfig(c.env, next);
    return c.json(saved);
  });

  // --- GET /poll-config/aggressive ---------------------------------------
  r.get('/poll-config/aggressive', async (c) => {
    const cfg = await getConfig(c.env);
    return c.json({ aggressiveMode: cfg.aggressiveMode });
  });

  // --- GET /review-queue --------------------------------------------------
  r.get('/review-queue', async (c) => {
    const rows = await all<ReviewRow>(
      c.env.DB,
      'SELECT doc_id, reason, payload, created_at, resolved FROM review_queue WHERE resolved = 0 ORDER BY created_at ASC',
    );
    const items = rows.map((row) => ({
      docId: row.doc_id,
      reason: row.reason ?? '',
      payload: row.payload ? safeJson(row.payload) : null,
      createdAt: row.created_at ?? '',
      resolved: row.resolved === 1,
    }));
    return c.json({ items, count: items.length });
  });

  // --- POST /review/:docId ------------------------------------------------
  // Body: { decision: 'confirm'|'reject', edits?: EditedTx[] }
  //   confirm -> insert corrected transactions (source='primary'), mark review
  //              resolved, set filing persisted, enqueue delivery.dispatch each.
  //   reject  -> mark review resolved + filing status 'error'.
  r.post('/review/:docId', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const decision = body.decision;
    if (decision !== 'confirm' && decision !== 'reject') {
      return c.json({ error: "decision must be 'confirm' or 'reject'" }, 400);
    }

    const review = await get<ReviewRow>(
      c.env.DB,
      'SELECT doc_id, reason, payload, created_at, resolved FROM review_queue WHERE doc_id = ?',
      [docId],
    );
    if (!review) return c.json({ error: 'review item not found' }, 404);

    if (decision === 'reject') {
      await run(c.env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [docId]);
      await run(c.env.DB, 'UPDATE filings SET ingest_status = ? WHERE doc_id = ?', [
        'error',
        docId,
      ]);
      return c.json({ docId, decision: 'reject', resolved: true });
    }

    // confirm: insert the corrected transactions.
    const edits = Array.isArray(body.edits) ? (body.edits as EditedTx[]) : [];
    const filing = await get<{ filer_id: string | null }>(
      c.env.DB,
      'SELECT filer_id FROM filings WHERE doc_id = ?',
      [docId],
    );
    const filingFilerId = filing?.filer_id ?? null;

    const insertedIds: string[] = [];
    const nowIso = new Date().toISOString();
    for (const e of edits) {
      const id = uuid();
      // cursor_seq is DB-assigned by trg_transactions_cursor (insert with NULL).
      await run(
        c.env.DB,
        `INSERT INTO transactions (
           id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
           tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
           raw_text, confidence, source, created_at, cursor_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'primary', ?, NULL)`,
        [
          id,
          docId,
          e.filerId ?? filingFilerId,
          e.txDate ?? null,
          e.owner ?? null,
          e.assetName ?? '',
          e.ticker ?? null,
          e.assetType ?? null,
          (e.txType as TxType) ?? 'P',
          e.amountMin ?? null,
          e.amountMax ?? null,
          e.isOption ? 1 : 0,
          e.capGainsOver200 ? 1 : 0,
          e.rawText ?? '',
          e.confidence ?? 1,
          nowIso,
        ],
      );
      insertedIds.push(id);
    }

    // Mark review resolved + filing persisted.
    await run(c.env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [docId]);
    await run(c.env.DB, 'UPDATE filings SET ingest_status = ? WHERE doc_id = ?', [
      'persisted',
      docId,
    ]);

    // Enqueue delivery fan-out for each newly inserted transaction.
    for (const txId of insertedIds) {
      try {
        await c.env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId });
      } catch (err) {
        console.error('review confirm: enqueue failed', txId, (err as Error).message);
      }
    }

    return c.json({
      docId,
      decision: 'confirm',
      resolved: true,
      inserted: insertedIds.length,
      transactionIds: insertedIds,
    });
  });

  // --- GET /sources/health ------------------------------------------------
  // Recent ingest_log aggregates per source: last poll, last new filing, and the
  // observed average interval between polls (seconds).
  r.get('/sources/health', async (c) => {
    const rows = await all<{
      source: string;
      last_polled_at: string | null;
      poll_count: number;
      total_new: number;
      last_new_at: string | null;
    }>(
      c.env.DB,
      `SELECT source,
              MAX(polled_at)                              AS last_polled_at,
              COUNT(*)                                    AS poll_count,
              COALESCE(SUM(new_count), 0)                 AS total_new,
              MAX(CASE WHEN new_count > 0 THEN polled_at END) AS last_new_at
         FROM ingest_log
        GROUP BY source`,
    );

    const sources = [];
    for (const row of rows) {
      sources.push({
        source: row.source,
        lastPolledAt: row.last_polled_at,
        lastNewFilingAt: row.last_new_at,
        pollCount: row.poll_count,
        totalNew: row.total_new,
        avgIntervalSec: await observedAvgInterval(c.env, row.source),
        avgReleasedToSeenSec: await observedReleasedToSeenLag(c.env, row.source),
        avgSeenToImportedSec: await observedSeenToImportedLag(c.env, row.source),
      });
    }
    return c.json({ sources, count: sources.length });
  });

  // --- GET /ui-settings ---------------------------------------------------
  // Site-wide UI settings the admin controls for ALL visitors (logo style).
  r.get('/ui-settings', async (c) => {
    return c.json({ logoDisplay: await getLogoDisplay(c.env) });
  });

  // --- PUT /ui-settings ---------------------------------------------------
  // Update the site-wide logo style. Body: { logoDisplay: 'tile'|'transparent'|'off' }.
  r.put('/ui-settings', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const logoDisplay = await setLogoDisplay(c.env, body.logoDisplay);
    return c.json({ logoDisplay });
  });

  // --- POST /backfill -----------------------------------------------------
  // Trigger the historic-trades seed backfill (runSeedBackfill). Pulls the
  // pre-aggregated community datasets and idempotently upserts them as
  // source='seed_dataset' rows. Body (all optional):
  //   { chambers?: ('house'|'senate')[], sinceYear?: number,
  //     limit?: number, dryRun?: boolean }
  // SEED_HOUSE_URL / SEED_SENATE_URL env vars override the (often-gated) source
  // URLs. Runs inline and returns the SeedBackfillResult; per-source failures
  // are reported in `errors` rather than aborting the run.
  r.post('/backfill', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const opts: Parameters<typeof runSeedBackfillFromEnv>[1] = {};

    if (body.chambers !== undefined) {
      if (
        !Array.isArray(body.chambers) ||
        !body.chambers.every((x) => x === 'house' || x === 'senate')
      ) {
        return c.json({ error: "chambers must be an array of 'house'|'senate'" }, 400);
      }
      opts.chambers = body.chambers as Chamber[];
    }
    if (body.sinceYear !== undefined) {
      if (typeof body.sinceYear !== 'number' || !Number.isFinite(body.sinceYear)) {
        return c.json({ error: 'sinceYear must be a number' }, 400);
      }
      opts.sinceYear = body.sinceYear;
    }
    if (body.limit !== undefined) {
      if (typeof body.limit !== 'number' || body.limit <= 0) {
        return c.json({ error: 'limit must be a positive number' }, 400);
      }
      opts.limit = body.limit;
    }
    if (body.dryRun !== undefined) {
      if (typeof body.dryRun !== 'boolean') {
        return c.json({ error: 'dryRun must be a boolean' }, 400);
      }
      opts.dryRun = body.dryRun;
    }

    try {
      const result = await runSeedBackfillFromEnv(c.env, opts);
      return c.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      return c.json({ error: `backfill failed: ${(err as Error).message}` }, 500);
    }
  });

  // --- POST /house-backfill -----------------------------------------------
  // High-fidelity House history from the official yearly bulk ZIP indexes:
  // walks the House Clerk per-year indexes and feeds every PTR into the live
  // ingestion pipeline (emits the same filing.new INGEST_QUEUE message the cron
  // watcher does), populating House history into `transactions` with
  // source='primary'.
  // Body (all optional):
  //   { fromYear?: number, toYear?: number, maxFilings?: number, dryRun?: boolean }
  r.post('/house-backfill', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const result = await runHouseHistoricalBackfill(c.env, {
        fromYear: typeof body.fromYear === 'number' ? body.fromYear : undefined,
        toYear: typeof body.toYear === 'number' ? body.toYear : undefined,
        maxFilings: typeof body.maxFilings === 'number' ? body.maxFilings : undefined,
        dryRun: body.dryRun === true,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /reprocess ----------------------------------------------------
  // Re-evaluate already-ingested filings under the CURRENT normalizer rubric,
  // without re-fetching from the source (re-extracts from the stored R2 raw).
  // Two cases per filing:
  //   • already in the feed (primary rows exist): recompute confidence and
  //     UPDATE those rows IN PLACE — same id + cursor_seq, so NO duplicate rows
  //     and NO re-fired delivery webhooks. Matched in cursor_seq order (parsing
  //     the same bytes is deterministic); a row-count mismatch is skipped, never
  //     guessed.
  //   • stuck in review (no primary rows): if it now clears the bar, persist +
  //     deliver it (first-time delivery, which is correct) and mark its
  //     review_queue row resolved. If it still fails, it's left in review.
  // Body (all optional):
  //   { chamber?: 'house'|'senate', limit?: number, dryRun?: boolean }
  r.post('/reprocess', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const chamber = body.chamber === undefined ? 'house' : body.chamber;
    if (chamber !== 'house' && chamber !== 'senate') {
      return c.json({ error: "chamber must be 'house' or 'senate'" }, 400);
    }
    const dryRun = body.dryRun === true;
    let limit = typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : 500;
    if (limit > 2000) limit = 2000;

    // Filings for this chamber that we can re-extract (have a raw R2 object).
    const filings = await all<{ doc_id: string }>(
      c.env.DB,
      `SELECT doc_id FROM filings
        WHERE chamber = ? AND raw_object_key IS NOT NULL
        ORDER BY first_seen_at DESC
        LIMIT ?`,
      [chamber, limit],
    );

    const summary = {
      chamber,
      dryRun,
      filingsScanned: 0,
      rowsUpdatedInPlace: 0, // already-in-feed rows whose confidence changed
      filingsPromoted: 0, //    review -> feed (now clears the bar)
      rowsPromoted: 0,
      filingsStillInReview: 0,
      skippedNoExtract: 0,
      skippedCountMismatch: 0,
      errors: [] as string[],
    };

    for (const { doc_id } of filings) {
      summary.filingsScanned += 1;
      let extracted;
      try {
        extracted = await extractParsed(c.env, doc_id);
      } catch (err) {
        summary.errors.push(`${doc_id}: extract failed: ${(err as Error).message}`);
        continue;
      }
      if (!extracted || extracted.transactions.length === 0) {
        summary.skippedNoExtract += 1;
        continue;
      }

      const flagged = await recomputeTransactions(c.env, extracted.filing, extracted.transactions);
      const newMin = Math.min(...flagged.map((f) => f.tx.confidence));
      const hasHardFailure = flagged.some(
        (f) =>
          f.flags.includes('no_amount') ||
          f.flags.includes('invalid_amount') ||
          f.flags.includes('bad_tx_type'),
      );

      const existing = await all<{ id: string }>(
        c.env.DB,
        `SELECT id FROM transactions WHERE doc_id = ? AND source = 'primary' ORDER BY cursor_seq ASC`,
        [doc_id],
      );

      if (existing.length > 0) {
        // Already in the feed: update confidence (+ snapped amount / resolved
        // ticker) in place. Never touch id or cursor_seq -> no re-delivery.
        if (existing.length !== flagged.length) {
          summary.skippedCountMismatch += 1;
          continue;
        }
        if (!dryRun) {
          for (let i = 0; i < existing.length; i++) {
            const { tx } = flagged[i];
            await run(
              c.env.DB,
              `UPDATE transactions
                  SET confidence = ?, amount_min = ?, amount_max = ?, ticker = ?
                WHERE id = ?`,
              [tx.confidence, tx.amountMin, tx.amountMax, tx.ticker, existing[i].id],
            );
          }
          await run(c.env.DB, 'UPDATE filings SET confidence = ? WHERE doc_id = ?', [
            newMin,
            doc_id,
          ]);
        }
        summary.rowsUpdatedInPlace += flagged.length;
        continue;
      }

      // Not in the feed yet (sitting in review / error). Does it clear the bar now?
      const passesNow = newMin >= CONFIDENCE_THRESHOLD && !hasHardFailure;
      if (passesNow) {
        if (!dryRun) {
          // normalize() persists + sets ingest_status + fans out delivery
          // (first-time delivery for these rows, which is correct).
          await normalize(c.env, extracted.filing, extracted.transactions, {
            extractor: extracted.extractor,
            modelVersion: extracted.modelVersion ?? null,
          });
          await run(c.env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [doc_id]);
        }
        summary.filingsPromoted += 1;
        summary.rowsPromoted += flagged.length;
      } else {
        summary.filingsStillInReview += 1;
      }
    }

    return c.json({ ok: summary.errors.length === 0, ...summary });
  });

  // --- POST /bakeoff ------------------------------------------------------
  // Run N House PTR PDFs through several vision models (Gemini/OpenAI/Anthropic)
  // and report row recall, failures, latency, and cross-model agreement so we
  // can pick the best extractor before reprocessing the whole corpus. Read-only:
  // it never writes transactions. Body: { n?, models?: [{provider,model}], docIds? }.
  r.post('/bakeoff', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    // Candidate lineup (default provider-neutral set, overridable).
    let candidates: BakeoffCandidate[] = DEFAULT_CANDIDATES;
    if (Array.isArray(body.models)) {
      const valid: Provider[] = ['gemini', 'openai', 'anthropic'];
      const parsed: BakeoffCandidate[] = [];
      for (const m of body.models) {
        const o = m as { provider?: unknown; model?: unknown };
        if (!valid.includes(o.provider as Provider) || typeof o.model !== 'string') {
          return c.json({ error: 'each model must be {provider:gemini|openai|anthropic, model:string}' }, 400);
        }
        parsed.push({ provider: o.provider as Provider, model: o.model });
      }
      if (parsed.length === 0) return c.json({ error: 'models must be a non-empty array' }, 400);
      candidates = parsed;
    }

    let n = typeof body.n === 'number' && body.n > 0 ? Math.floor(body.n) : 20;
    if (n > 50) n = 50; // cap fan-out (n docs * candidates LLM calls)

    // Pick the documents: explicit docIds, else the most recent House PTRs with a raw PDF.
    let docs: Array<{ doc_id: string; raw_object_key: string | null }>;
    if (Array.isArray(body.docIds) && body.docIds.length > 0) {
      const ids = body.docIds.filter((x): x is string => typeof x === 'string').slice(0, n);
      docs = [];
      for (const id of ids) {
        const row = await get<{ doc_id: string; raw_object_key: string | null }>(
          c.env.DB,
          'SELECT doc_id, raw_object_key FROM filings WHERE doc_id = ?',
          [id],
        );
        if (row) docs.push(row);
      }
    } else {
      docs = await all<{ doc_id: string; raw_object_key: string | null }>(
        c.env.DB,
        `SELECT doc_id, raw_object_key FROM filings
          WHERE chamber = 'house' AND raw_object_key IS NOT NULL
          ORDER BY first_seen_at DESC
          LIMIT ?`,
        [n],
      );
    }

    if (docs.length === 0) {
      return c.json({ error: 'no House filings with a stored PDF were found to test' }, 404);
    }

    const results: CandidateDocResult[] = [];
    const skipped: string[] = [];
    for (const { doc_id, raw_object_key } of docs) {
      if (!raw_object_key) {
        skipped.push(`${doc_id}: no raw_object_key`);
        continue;
      }
      const obj = await c.env.RAW_FILES.get(raw_object_key);
      if (!obj) {
        skipped.push(`${doc_id}: R2 object ${raw_object_key} missing`);
        continue;
      }
      const bytes = await obj.arrayBuffer();
      // Sequential per doc keeps memory + provider rate-limits sane.
      for (const candidate of candidates) {
        results.push(await runCandidateOnDoc(c.env, candidate, doc_id, bytes));
      }
    }

    // Per-document row-count matrix (model label -> rowCount | "ERR").
    const perDoc: Record<string, Record<string, number | string>> = {};
    for (const r of results) {
      const lbl = `${r.provider}:${r.model}`;
      (perDoc[r.docId] ??= {})[lbl] = r.ok ? r.rowCount : 'ERR';
    }

    return c.json({
      ok: true,
      docsTested: docs.length - skipped.length,
      skipped,
      models: summarizeModels(candidates, results),
      perDoc,
    });
  });

  // --- POST /migrate ------------------------------------------------------
  // Apply schema changes via the Worker's D1 binding (sidesteps the wrangler
  // CLI's --remote D1 auth issues). Idempotent: "duplicate column" is treated
  // as already-applied.
  r.post('/migrate', async (c) => {
    const statements = [
      'ALTER TABLE filers ADD COLUMN photo_url TEXT',
      // 0003_users.sql — end-user accounts (public-site auth). Idempotent.
      `CREATE TABLE IF NOT EXISTS users (
         id             TEXT PRIMARY KEY,
         email          TEXT NOT NULL UNIQUE,
         name           TEXT,
         picture        TEXT,
         google_sub     TEXT UNIQUE,
         email_verified INTEGER NOT NULL DEFAULT 0,
         created_at     TEXT NOT NULL,
         last_login_at  TEXT
       )`,
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)',
      // 0004_billing.sql — Stripe billing columns on users. Idempotent.
      'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
      'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
      'ALTER TABLE users ADD COLUMN subscription_status TEXT',
      'ALTER TABLE users ADD COLUMN plan TEXT',
      'ALTER TABLE users ADD COLUMN current_period_end TEXT',
      'ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN trial_end TEXT',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id)',
      // 0005_securities_ref.sql — asset reference data (sector, market cap, …).
      `CREATE TABLE IF NOT EXISTS securities_ref (
         ticker            TEXT PRIMARY KEY,
         company_name      TEXT, sector TEXT, industry TEXT, asset_class TEXT,
         is_etf INTEGER NOT NULL DEFAULT 0, is_adr INTEGER NOT NULL DEFAULT 0,
         country TEXT, state_hq TEXT, state_of_incorp TEXT,
         exchange TEXT, exchange_short TEXT, currency TEXT,
         market_cap INTEGER, market_cap_bucket TEXT, ipo_date TEXT,
         cik TEXT, sic_code TEXT, sic_description TEXT,
         source TEXT, enriched_at TEXT, enrichment_error TEXT
       )`,
      'CREATE INDEX IF NOT EXISTS idx_secref_sector ON securities_ref (sector)',
      'CREATE INDEX IF NOT EXISTS idx_secref_bucket ON securities_ref (market_cap_bucket)',
      'CREATE INDEX IF NOT EXISTS idx_secref_enriched ON securities_ref (enriched_at)',
    ];
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const sql of statements) {
      try {
        await run(c.env.DB, sql);
        applied.push(sql);
      } catch (err) {
        const msg = (err as Error).message;
        if (/duplicate column|already exists/i.test(msg)) {
          skipped.push(sql);
        } else {
          return c.json({ error: msg, sql }, 500);
        }
      }
    }
    return c.json({ applied, skipped });
  });

  // --- POST /enrich-securities --------------------------------------------
  // Budgeted asset enrichment: SEC EDGAR (free) + FMP (key-gated). Processes the
  // tickers that most need it (newest-traded first, then backfilling older ones),
  // spending at most the day's remaining FMP budget. Body (optional):
  //   { max?: number, dryRun?: boolean }
  // Re-run daily (or wire to cron) to slowly backfill history within the cap.
  r.post('/enrich-securities', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const opts: { max?: number; dryRun?: boolean } = {};
    if (typeof body.max === 'number' && body.max > 0) opts.max = Math.floor(body.max);
    if (body.dryRun === true) opts.dryRun = true;
    try {
      const result = await runEnrichment(c.env, opts);
      return c.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- GET /enrich-securities/status --------------------------------------
  // Today's FMP call usage + how many tickers still need enrichment.
  r.get('/enrich-securities/status', async (c) => {
    const used = await getDailyUsed(c.env);
    const row = await get<{ pending: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS pending FROM (
         SELECT t.ticker FROM transactions t
         LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
         WHERE t.ticker IS NOT NULL AND t.ticker <> ''
           AND (sr.ticker IS NULL OR sr.enriched_at IS NULL)
         GROUP BY t.ticker)`,
    );
    const enriched = await get<{ n: number }>(
      c.env.DB,
      'SELECT COUNT(*) AS n FROM securities_ref WHERE enriched_at IS NOT NULL',
    );
    return c.json({
      fmpCallsToday: used,
      pendingTickers: row?.pending ?? 0,
      enrichedTickers: enriched?.n ?? 0,
      hasFmpKey: !!(c.env as Env & { FMP_API_KEY?: string }).FMP_API_KEY,
    });
  });

  // --- POST /enrich-photos ------------------------------------------------
  // Resolve each filer's name -> bioguide (congress-legislators) and store the
  // public headshot URL. Safe to re-run; unmatched filers stay null (the UI
  // falls back to initials).
  r.post('/enrich-photos', async (c) => {
    try {
      const map = await buildBioguideMap();
      const filers = await all<{ bioguide_id: string; full_name: string | null }>(
        c.env.DB,
        'SELECT bioguide_id, full_name FROM filers',
      );
      const updates: D1PreparedStatement[] = [];
      let matched = 0;
      for (const f of filers) {
        const bio = map.get(normName(f.full_name));
        if (!bio) continue;
        matched++;
        updates.push(
          c.env.DB
            .prepare('UPDATE filers SET photo_url = ? WHERE bioguide_id = ?')
            .bind(photoUrlFor(bio), f.bioguide_id),
        );
      }
      for (let i = 0; i < updates.length; i += 50) {
        await c.env.DB.batch(updates.slice(i, i + 50));
      }
      return c.json({ filers: filers.length, matched, unmatched: filers.length - matched });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- GET /subscriptions -------------------------------------------------
  r.get('/subscriptions', async (c) => {
    const activeOnly = c.req.query('active') === 'true';
    const subs = await listSubscriptions(c.env, activeOnly);
    return c.json({ subscriptions: subs, count: subs.length });
  });

  return r;
}

/** Observed average seconds between the most recent polls for a source. */
async function observedAvgInterval(env: Env, source: string): Promise<number | null> {
  const rows = await all<{ polled_at: string }>(
    env.DB,
    'SELECT polled_at FROM ingest_log WHERE source = ? ORDER BY polled_at DESC LIMIT 50',
    [source],
  );
  if (rows.length < 2) return null;
  // rows are DESC; compute deltas between consecutive timestamps.
  let total = 0;
  let n = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const newer = Date.parse(rows[i].polled_at);
    const older = Date.parse(rows[i + 1].polled_at);
    if (Number.isFinite(newer) && Number.isFinite(older) && newer > older) {
      total += (newer - older) / 1000;
      n++;
    }
  }
  return n > 0 ? Math.round(total / n) : null;
}

/**
 * Average "Released → Seen" lag (seconds): from a filing's official release
 * (filed_date) to when our watcher first recorded it (first_seen_at), per
 * chamber. filed_date is day-granular (the disclosure systems publish no exact
 * release time), so this is APPROXIMATE; we average only non-negative diffs over
 * recent filings. Returns null when there isn't enough dated data.
 */
async function observedReleasedToSeenLag(env: Env, source: string): Promise<number | null> {
  const row = await get<{ avg_sec: number | null }>(
    env.DB,
    `SELECT AVG((julianday(first_seen_at) - julianday(filed_date)) * 86400.0) AS avg_sec
       FROM (
         SELECT first_seen_at, filed_date
           FROM filings
          WHERE chamber = ?
            AND filed_date IS NOT NULL
            AND first_seen_at IS NOT NULL
            AND julianday(first_seen_at) >= julianday(filed_date)
          ORDER BY first_seen_at DESC
          LIMIT 200
       )`,
    [source],
  );
  return row && row.avg_sec != null ? Math.round(row.avg_sec) : null;
}

/**
 * Average "Seen → Imported" lag (seconds): from when our watcher first saw a
 * filing (filings.first_seen_at) to when we wrote its parsed rows
 * (transactions.created_at), per chamber. Both are our own timestamps, so this
 * is PRECISE. Only live-pipeline rows (source='primary') are meaningful.
 */
async function observedSeenToImportedLag(env: Env, source: string): Promise<number | null> {
  const row = await get<{ avg_sec: number | null }>(
    env.DB,
    `SELECT AVG((julianday(t.created_at) - julianday(f.first_seen_at)) * 86400.0) AS avg_sec
       FROM transactions t
       JOIN filings f ON f.doc_id = t.doc_id
      WHERE f.chamber = ?
        AND t.source = 'primary'
        AND f.first_seen_at IS NOT NULL
        AND t.created_at IS NOT NULL
        AND julianday(t.created_at) >= julianday(f.first_seen_at)`,
    [source],
  );
  return row && row.avg_sec != null ? Math.round(row.avg_sec) : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
