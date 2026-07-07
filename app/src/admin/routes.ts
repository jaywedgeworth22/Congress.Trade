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
 *   GET   /diagnostics              -> connection status + recent app errors
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
 *   The surface fails closed when no auth mechanism is configured. For local
 *   development only, set ADMIN_OPEN_IN_DEV=true to open it explicitly.
 *   Provision `wrangler secret put ADMIN_TOKEN`, and/or set ADMIN_EMAILS +
 *   ACCESS_AUD + ACCESS_TEAM_DOMAIN (with an Access app in front), to lock down.
 */

import { Hono } from 'hono';
import type { Env, PollConfig, PollWindow, TxType, TxSource, Subscription } from '../shared/types';
import { all, get, run, type SqlParam } from '../shared/db';
import { HOUSE_ASSET_TYPE_NAMES } from '../shared/assetTypes';
import { listIngestionDecisions, recordIngestionDecision } from '../shared/ingestionDecisions';
import { getConfig, setConfig } from '../shared/config';
import { uuid } from '../shared/ids';
import { listSubscriptions } from '../delivery/subscriptions';
import { runSeedBackfillFromEnv } from '../backfill/seed';
import { runHouseHistoricalBackfill } from '../backfill/houseCrawler';
import { extractParsed } from '../extraction/orchestrator';
import {
  normalize,
  recomputeTransactions,
  persistTransactions,
  transactionRowKey,
  loadResolver,
  CONFIDENCE_THRESHOLD,
  hasHardFailureFlags,
} from '../extraction/normalizer';
import { mapFiling, type FilingRow } from '../delivery/rows';
import { processAgreementDoc, type AgreementModels } from '../extraction/agreement';
import type { Chamber } from '../shared/types';
import { verifyAccessJwt, certsUrl } from './access';
import { adminRuntimeConfig } from './identity';
import { getLogoDisplay, setLogoDisplay } from '../shared/settings';
import { constantTimeEqual } from '../auth/tokens';
import { getCurrentUser } from '../auth/session';
import {
  DEFAULT_CANDIDATES,
  keyFor,
  runCandidateOnDoc,
  summarizeModels,
  type BakeoffCandidate,
  type CandidateDocResult,
  type Provider,
} from '../extraction/bakeoff';
import { isBatchProvider, submitBatch, pollBatch, type BatchDoc } from '../extraction/batchExtract';
import {
  runEnrichment,
  getDailyUsed,
  prepareImportSecurityRef,
  enrichmentNeededSql,
  hasConfiguredKeyedEnrichmentProvider,
} from '../enrichment/service';
import { mergeRefs } from '../enrichment/compute';
import type { SecurityRef } from '../enrichment/types';
import { runPriceRefresh } from '../prices/service';
import { getSecretResolverStatus, refreshSecrets, resolveSecret, resolveSecrets } from '../secrets/infisical';
import { getDisclosureLatencySummary, runDisclosureLatencyProbe } from '../ingestion/fmpDisclosureLatency';

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
  /** Local-only escape hatch. Production should leave this unset/false. */
  ADMIN_OPEN_IN_DEV?: string;
  /**
   * Scoped bearer token that unlocks ONLY POST /securities/import (the
   * cross-app data-sharing endpoint). Lets a sibling app push FMP data without
   * holding the full ADMIN_TOKEN. Optional; ignored if unset.
   */
  INGEST_TOKEN?: string;
};

const LATENCY_RESET_KEY = 'admin:source_health:latency_reset_at';

/** True when the request is a bearer-authenticated call to the import endpoint. */
async function isAuthorizedIngest(
  env: EnvWithAdmin,
  path: string,
  authorization?: string,
): Promise<boolean> {
  const token = (await resolveSecret(env, 'INGEST_TOKEN')).value;
  return (
    !!token &&
    path.endsWith('/securities/import') &&
    (await constantTimeEqual(authorization ?? '', `Bearer ${token}`))
  );
}

let warnedOpenAdmin = false;
let warnedClosedAdmin = false;

function isExplicitOpenAdmin(env: EnvWithAdmin): boolean {
  const isProduction = env.SENTRY_ENVIRONMENT === 'production' || env.USAGE_MONITOR_ENVIRONMENT === 'production';
  return env.ADMIN_OPEN_IN_DEV === 'true' && !isProduction;
}

function adminActor(c: { req: { header(name: string): string | undefined } }): string {
  const accessEmail =
    c.req.header('Cf-Access-Authenticated-User-Email') ||
    c.req.header('cf-access-authenticated-user-email');
  if (accessEmail) return accessEmail;
  return c.req.header('authorization') ? 'admin-token' : 'admin';
}

/**
 * Admin auth — authorized if a valid bearer token OR an allowlisted, verified
 * Cloudflare Access identity is presented. Open only when neither is configured.
 */
async function isAuthorized(
  env: EnvWithAdmin,
  headers: { authorization?: string; accessJwt?: string; sessionEmail?: string },
): Promise<boolean> {
  const token = (await resolveSecret(env, 'ADMIN_TOKEN')).value;
  const adminConfig = await adminRuntimeConfig(env);
  const allow = adminConfig.allow;
  const aud = adminConfig.accessAud;
  const teamDomain = adminConfig.accessTeamDomain;
  const tokenConfigured = !!token;
  const accessConfigured = !!(aud && teamDomain && allow.size > 0);
  const sessionConfigured = allow.size > 0;

  if (!tokenConfigured && !accessConfigured && !sessionConfigured) {
    if (isExplicitOpenAdmin(env)) {
      if (!warnedOpenAdmin) {
        warnedOpenAdmin = true;
        console.warn(
          'admin: ADMIN_OPEN_IN_DEV=true and no ADMIN_TOKEN/Access config is present — ' +
            'the admin API is OPEN. Do not set this in production.',
        );
      }
      return true;
    }
    if (!warnedClosedAdmin) {
      warnedClosedAdmin = true;
      console.warn(
        'admin: neither ADMIN_TOKEN nor Cloudflare Access (ADMIN_EMAILS + ' +
          'ACCESS_AUD + ACCESS_TEAM_DOMAIN) is configured — the admin API is CLOSED. ' +
          'Run `wrangler secret put ADMIN_TOKEN`, set Access vars, or set ' +
          'ADMIN_OPEN_IN_DEV=true for local-only development.',
      );
    }
    return false;
  }

  // 1) Bearer token (automation / curl).
  if (
    tokenConfigured &&
    (await constantTimeEqual(headers.authorization ?? '', `Bearer ${token}`))
  ) {
    return true;
  }

  // 2) First-party Google session identity (browser). The session itself is an
  // opaque KV token; admin authorization is the ADMIN_EMAILS allowlist.
  const sessionEmail = headers.sessionEmail?.trim().toLowerCase();
  if (sessionConfigured && sessionEmail && allow.has(sessionEmail)) {
    return true;
  }

  // 3) Cloudflare Access identity (humans). Verify signature + aud + allowlist.
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
  source_url: string | null;
  raw_object_key: string | null;
  doc_kind: string | null;
  chamber?: string | null;
}

interface DiagnosticConnection {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error' | 'unknown';
  configured: boolean | null;
  lastUsedAt: string | null;
  callsTotal: number;
  callsLast24h: number;
  callsToday: number;
  errorsLast24h: number;
  note: string | null;
}

interface DiagnosticError {
  at: string | null;
  area: string;
  severity: 'warning' | 'error';
  subject: string;
  message: string;
}

interface DiagnosticUserStats {
  totalUsers: number;
  subscribedUsers: number;
  deliverySubscriptions: number;
  activeDeliverySubscriptions: number;
  adminUsers: number;
  loginsLast24h: number;
  recentLogins: Array<{
    email: string;
    name: string | null;
    lastLoginAt: string | null;
    plan: string | null;
    subscriptionStatus: string | null;
  }>;
}

function dayStartIso(now = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function hoursAgoIso(hours: number, now = new Date()): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

async function optionalAll<T>(env: Env, sql: string, params: SqlParam[] = []): Promise<T[]> {
  try {
    return await all<T>(env.DB, sql, params);
  } catch (err) {
    const msg = (err as Error).message;
    if (/no such table|no such column/i.test(msg)) return [];
    throw err;
  }
}

function connectionStatus(
  configured: boolean | null,
  errorsLast24h: number,
  lastUsedAt: string | null,
): DiagnosticConnection['status'] {
  if (configured === false) return 'warn';
  if (errorsLast24h > 0) return 'error';
  if (!lastUsedAt) return 'unknown';
  return 'ok';
}

function maxIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

function deltaSeconds(later: string | null | undefined, earlier: string | null | undefined): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 1000) : null;
}

function titleCaseSource(source: string): string {
  if (source.toLowerCase() === 'house') return 'House';
  if (source.toLowerCase() === 'senate') return 'Senate';
  return source ? `${source[0].toUpperCase()}${source.slice(1)}` : 'Source';
}

function adminSubscription(sub: Subscription): Omit<Subscription, 'secret'> & { hasSecret: boolean } {
  const { secret, ...rest } = sub;
  return { ...rest, hasSecret: Boolean(secret) };
}

interface EditedTx {
  filerId?: string | null;
  txDate?: string | null;
  owner?: string | null;
  assetName?: string;
  ticker?: string | null;
  assetType?: string | null;
  assetTypeName?: string | null;
  txType?: TxType;
  amountMin?: number | null;
  amountMax?: number | null;
  isOption?: boolean;
  capGainsOver200?: boolean;
  rawText?: string;
  confidence?: number;
}

function reviewAssetTypeName(e: EditedTx): string | null {
  const supplied = typeof e.assetTypeName === 'string' ? e.assetTypeName.trim() : '';
  if (supplied) return supplied;
  const raw = typeof e.assetType === 'string' ? e.assetType.trim() : '';
  if (!raw || raw.toLowerCase() === 'unknown') return null;
  const code = raw.toUpperCase();
  return HOUSE_ASSET_TYPE_NAMES[code] ?? raw;
}

// --- Politician photo enrichment (name -> bioguide -> unitedstates/images CDN) ---

const LEGISLATOR_SOURCES = [
  'https://unitedstates.github.io/congress-legislators/legislators-current.json',
  'https://unitedstates.github.io/congress-legislators/legislators-historical.json',
];

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * Normalize a politician name for matching: lowercase, strip punctuation, drop
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

interface LegislatorTerm {
  type?: string;
  party?: string;
  state?: string;
  district?: number | string | null;
  start?: string;
  end?: string;
}

interface Legislator {
  id?: { bioguide?: string };
  name?: { first?: string; last?: string; official_full?: string; nickname?: string };
  terms?: LegislatorTerm[];
}

interface LegislatorMatch {
  bioguide: string;
  party: string | null;
  state: string | null;
  district: string | null;
}

function latestLegislatorTerm(terms: LegislatorTerm[] | undefined): LegislatorTerm | undefined {
  return (terms ?? []).slice().sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')))[0];
}

/** Build a normalized-name -> legislator metadata map from congress-legislators. */
async function buildLegislatorMap(): Promise<Map<string, LegislatorMatch>> {
  const map = new Map<string, LegislatorMatch>();
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
      const term = latestLegislatorTerm(leg.terms);
      const match: LegislatorMatch = {
        bioguide: bio,
        party: term?.party ?? null,
        state: term?.state ?? null,
        district: term?.district == null ? null : String(term.district),
      };
      const n = leg.name ?? {};
      const candidates = [
        n.first && n.last ? `${n.first} ${n.last}` : '',
        n.nickname && n.last ? `${n.nickname} ${n.last}` : '',
        n.official_full ?? '',
      ];
      for (const raw of candidates) {
        const k = normName(raw);
        if (k && !map.has(k)) map.set(k, match); // current list is loaded first; it wins
      }
    }
  }
  return map;
}

function photoUrlFor(bioguide: string): string {
  return `https://unitedstates.github.io/images/congress/225x275/${bioguide}.jpg`;
}

/**
 * Backfill ticker resolution over stored rows whose ticker is NULL/empty or
 * whose asset name clearly describes a preferred/depositary share. No PDF
 * re-extraction — just the deterministic resolver over the stored asset name.
 * Bounded per call; safe to re-run. Shared by POST /resolve-tickers and cron.
 */
export async function runTickerBackfill(
  env: Env,
  limit = 5000,
): Promise<{ scanned: number; resolved: number }> {
  const resolver = await loadResolver(env);
  type BackfillTickerRow = {
    id: string;
    ticker: string | null;
    asset_name: string | null;
    tx_date: string | null;
    owner: string | null;
    asset_type: string | null;
    asset_type_name: string | null;
    tx_type: string | null;
    amount_min: number | null;
    amount_max: number | null;
    is_option: number | null;
    cap_gains_over_200: number | null;
    raw_text: string | null;
    filing_status: string | null;
    subholding: string | null;
    location: string | null;
    description: string | null;
    supplemental_text: string | null;
    source: TxSource;
    row_key: string | null;
  };
  const rows = await all<BackfillTickerRow>(
    env.DB,
    "SELECT id, ticker, asset_name, tx_date, owner, asset_type, asset_type_name, tx_type, " +
      "amount_min, amount_max, is_option, cap_gains_over_200, raw_text, filing_status, " +
      "subholding, location, description, supplemental_text, source, row_key FROM transactions " +
      "WHERE asset_name IS NOT NULL AND asset_name <> '' " +
      "AND ((ticker IS NULL OR ticker = '') " +
      "OR (ticker NOT LIKE '%^%' AND (" +
      "asset_name LIKE '%Depositary Share%' " +
      "OR asset_name LIKE '%Preferred%' " +
      "OR asset_name LIKE '%Preference%' " +
      "OR asset_name LIKE '%Pfd%' " +
      "OR asset_name LIKE '%Pref%'))) " +
      'AND deprecated_at IS NULL ' +
      "ORDER BY CASE WHEN ticker IS NOT NULL AND ticker <> '' AND ticker NOT LIKE '%^%' AND (" +
      "asset_name LIKE '%Depositary Share%' " +
      "OR asset_name LIKE '%Preferred%' " +
      "OR asset_name LIKE '%Preference%' " +
      "OR asset_name LIKE '%Pfd%' " +
      "OR asset_name LIKE '%Pref%') THEN 0 " +
      "WHEN (ticker IS NULL OR ticker = '') AND (" +
      "asset_name LIKE '%Depositary Share%' " +
      "OR asset_name LIKE '%Preferred%' " +
      "OR asset_name LIKE '%Preference%' " +
      "OR asset_name LIKE '%Pfd%' " +
      "OR asset_name LIKE '%Pref%') THEN 1 ELSE 2 END, id " +
      'LIMIT ?',
    [Math.min(limit, 20000)],
  );
  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    const resolved = resolver(row.ticker, row.asset_name);
    if (resolved && resolved !== (row.ticker ?? '').trim().toUpperCase()) {
      const rowIndex = parseRowIndex(row.row_key);
      const rowKey = rowIndex === null
        ? row.row_key ?? null
        : transactionRowKey(row.source, rowIndex, {
            txDate: row.tx_date,
            owner: normalizeStoredOwner(row.owner),
            assetName: row.asset_name ?? '',
            ticker: resolved,
            assetType: row.asset_type,
            assetTypeName: row.asset_type_name,
            txType: normalizeStoredTxType(row.tx_type),
            amountMin: row.amount_min,
            amountMax: row.amount_max,
            isOption: row.is_option === 1,
            capGainsOver200: row.cap_gains_over_200 === 1,
            rawText: row.raw_text ?? '',
            filingStatus: row.filing_status,
            subholding: row.subholding,
            location: row.location,
            description: row.description,
            supplementalText: row.supplemental_text,
          });
      updates.push(env.DB.prepare('UPDATE transactions SET ticker = ?, row_key = ? WHERE id = ?').bind(resolved, rowKey, row.id));
    }
  }
  for (let i = 0; i < updates.length; i += 50) {
    await env.DB.batch(updates.slice(i, i + 50));
  }
  return { scanned: rows.length, resolved: updates.length };
}

function parseRowIndex(rowKey: string | null): number | null {
  const m = /^v1:[^:]+:(\d+):/.exec(rowKey ?? '');
  return m ? Number(m[1]) : null;
}

function normalizeStoredOwner(value: string | null): 'self' | 'spouse' | 'joint' | 'dependent' | null {
  return value === 'self' || value === 'spouse' || value === 'joint' || value === 'dependent' ? value : null;
}

function normalizeStoredTxType(value: string | null): TxType {
  return value === 'P' || value === 'S' || value === 'E' ? value : 'P';
}

/**
 * Resolve each filer's name -> bioguide (congress-legislators) and fill in the
 * public headshot URL plus party/state/district (COALESCE-preserve so an existing
 * value is never overwritten). Pure data fill, safe to re-run; unmatched filers
 * stay null (the UI falls back to initials). Shared by POST /enrich-photos and the
 * daily cron so photos/party fill in automatically, not just on a manual call.
 */
export async function runPhotoEnrichment(
  env: Env,
): Promise<{ filers: number; matched: number; unmatched: number }> {
  const map = await buildLegislatorMap();
  const filers = await all<{ bioguide_id: string; full_name: string | null }>(
    env.DB,
    'SELECT bioguide_id, full_name FROM filers',
  );
  const updates: D1PreparedStatement[] = [];
  let matched = 0;
  for (const f of filers) {
    const match = map.get(normName(f.full_name));
    if (!match) continue;
    matched++;
    updates.push(
      env.DB
        .prepare("UPDATE filers SET photo_url = ?, party = COALESCE(NULLIF(party, ''), ?), state = COALESCE(NULLIF(state, ''), ?), district = COALESCE(NULLIF(district, ''), ?) WHERE bioguide_id = ?")
        .bind(photoUrlFor(match.bioguide), match.party, match.state, match.district, f.bioguide_id),
    );
  }
  for (let i = 0; i < updates.length; i += 50) {
    await env.DB.batch(updates.slice(i, i + 50));
  }
  return { filers: filers.length, matched, unmatched: filers.length - matched };
}

export function buildAdminRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // Auth gate applied to every admin route: full admin (bearer token OR
  // Cloudflare Access), or — for /securities/import only — the scoped
  // INGEST_TOKEN so a sibling app can push shared data without admin rights.
  r.use('*', async (c, next) => {
    const env = c.env as EnvWithAdmin;
    const authorization = c.req.header('Authorization');
    if (await isAuthorizedIngest(env, c.req.path, authorization)) return next();
    let sessionEmail: string | undefined;
    if (!authorization) {
      try {
        sessionEmail = (await getCurrentUser(c))?.email ?? undefined;
      } catch {
        sessionEmail = undefined;
      }
    }
    const ok = await isAuthorized(env, {
      authorization,
      accessJwt: c.req.header('Cf-Access-Jwt-Assertion'),
      sessionEmail,
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
  // ?resolved=1 lists already-reviewed items (history) instead of the pending
  // queue (default 0). ingest_status distinguishes confirmed (persisted) from
  // rejected (error) for resolved items.
  r.get('/review-queue', async (c) => {
    const resolved = c.req.query('resolved') === '1' ? 1 : 0;
    const rows = await all<
      ReviewRow & { ingest_status?: string | null; manual_rows?: number | null; live_rows?: number | null }
    >(
      c.env.DB,
      `SELECT
          rq.doc_id,
          rq.reason,
          rq.payload,
          rq.created_at,
          rq.resolved,
          f.source_url,
          f.raw_object_key,
          f.doc_kind,
          f.chamber,
          f.ingest_status,
          (SELECT COUNT(*) FROM transactions t
             WHERE t.doc_id = rq.doc_id AND t.source = 'manual' AND t.deprecated_at IS NULL) AS manual_rows,
          (SELECT COUNT(*) FROM transactions t
             WHERE t.doc_id = rq.doc_id AND t.deprecated_at IS NULL) AS live_rows
        FROM review_queue rq
        LEFT JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = ?
        ORDER BY rq.created_at ${resolved ? 'DESC' : 'ASC'}`,
      [resolved],
    );

    // Attach per-model extraction results (latest run per provider:model per doc).
    // Wrapped so a missing extraction_runs table (pre-migration) degrades to [].
    const modelsByDoc = new Map<string, Array<Record<string, unknown>>>();
    if (rows.length) {
      try {
        const ids = rows.map((r) => r.doc_id);
        const placeholders = ids.map(() => '?').join(',');
        const runs = await all<{
          doc_id: string;
          provider: string;
          model: string;
          kind: string;
          ok: number;
          error: string | null;
          row_count: number;
          latency_ms: number | null;
          avg_confidence: number | null;
          created_at: string;
        }>(
          c.env.DB,
          `SELECT doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, created_at
             FROM extraction_runs WHERE doc_id IN (${placeholders})
            ORDER BY created_at DESC`,
          ids,
        );
        for (const er of runs) {
          const list = modelsByDoc.get(er.doc_id) ?? [];
          // Keep only the most recent run per provider:model (rows are DESC by time).
          if (list.some((m) => m.provider === er.provider && m.model === er.model)) continue;
          list.push({
            provider: er.provider,
            model: er.model,
            kind: er.kind,
            ok: er.ok === 1,
            error: er.error,
            rowCount: er.row_count,
            latencyMs: er.latency_ms,
            avgConfidence: er.avg_confidence,
            createdAt: er.created_at,
          });
          modelsByDoc.set(er.doc_id, list);
        }
      } catch {
        /* extraction_runs not migrated yet — no per-model data */
      }
    }

    const items = rows.map((row) => {
      const manual = (row.manual_rows ?? 0) > 0;
      const status = !row.resolved || row.resolved === 0
        ? 'pending'
        : row.ingest_status === 'error'
          ? 'rejected'
          : manual
            ? 'modified'
            : (row.live_rows ?? 0) > 0
              ? 'published'
              : 'resolved';
      return {
        docId: row.doc_id,
        reason: row.reason ?? '',
        payload: row.payload ? safeJson(row.payload) : null,
        createdAt: row.created_at ?? '',
        resolved: row.resolved === 1,
        status,
        ingestStatus: row.ingest_status ?? '',
        sourceUrl: row.source_url ?? '',
        rawObjectKey: row.raw_object_key ?? '',
        docKind: row.doc_kind ?? '',
        chamber: row.chamber ?? '',
        models: modelsByDoc.get(row.doc_id) ?? [],
      };
    });
    return c.json({ items, count: items.length, resolved: resolved === 1 });
  });

  // --- GET /ingestion-decisions ------------------------------------------
  // Append-only filing/trade decision history. Unlike review_queue, this also
  // includes clean auto-published filings that never needed human review.
  r.get('/ingestion-decisions', async (c) => {
    const rawLimit = parseInt(c.req.query('limit') || '100', 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    const docId = c.req.query('docId') || null;
    try {
      const items = await listIngestionDecisions(c.env.DB, { limit, docId });
      return c.json({ items, count: items.length, available: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (/no such table|ingestion_decisions/i.test(msg)) {
        return c.json({ items: [], count: 0, available: false });
      }
      return c.json({ error: msg }, 500);
    }
  });

  // --- GET /review/:docId/extractions -------------------------------------
  // Full stored readings (result_json) for one document, newest first — powers
  // the dashboard's "view each model's reading" panel. Separate from the list
  // endpoint so the heavy result_json is only fetched on demand.
  r.get('/review/:docId/extractions', async (c) => {
    const docId = c.req.param('docId');
    let runs: Array<Record<string, unknown>> = [];
    try {
      const rowsE = await all<{
        id: string;
        batch_id: string | null;
        provider: string;
        model: string;
        kind: string;
        ok: number;
        error: string | null;
        row_count: number;
        latency_ms: number | null;
        avg_confidence: number | null;
        result_json: string | null;
        created_at: string;
      }>(
        c.env.DB,
        `SELECT id, batch_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, created_at
           FROM extraction_runs WHERE doc_id = ? ORDER BY created_at DESC`,
        [docId],
      );
      runs = rowsE.map((er) => ({
        id: er.id,
        batchId: er.batch_id,
        provider: er.provider,
        model: er.model,
        kind: er.kind,
        ok: er.ok === 1,
        error: er.error,
        rowCount: er.row_count,
        latencyMs: er.latency_ms,
        avgConfidence: er.avg_confidence,
        rows: er.result_json ? safeJson(er.result_json) : [],
        createdAt: er.created_at,
      }));
    } catch {
      /* extraction_runs not migrated yet */
    }
    return c.json({ docId, runs, count: runs.length });
  });

  // --- POST /review/:docId ------------------------------------------------
  // Body: { decision: 'confirm'|'reject'|'manual', edits?: EditedTx[] }
  //   confirm -> insert corrected transactions (source='primary'), mark review
  //              resolved, set filing persisted, enqueue delivery.dispatch each.
  //   manual  -> same as confirm but recorded as source='manual' — the admin
  //              hand-entered the rows because the automated read was wrong / too
  //              low-confidence to trust. Flagged so admins can tell them apart.
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
    if (decision !== 'confirm' && decision !== 'reject' && decision !== 'manual') {
      return c.json({ error: "decision must be 'confirm', 'reject', or 'manual'" }, 400);
    }

    const review = await get<ReviewRow>(
      c.env.DB,
      'SELECT doc_id, reason, payload, created_at, resolved FROM review_queue WHERE doc_id = ?',
      [docId],
    );
    if (!review) return c.json({ error: 'review item not found' }, 404);
    if (review.resolved === 1) {
      return c.json({ error: 'review item already resolved' }, 409);
    }

    if (decision === 'reject') {
      const nowIso = new Date().toISOString();
      await run(c.env.DB, 'UPDATE review_queue SET resolved = 1 WHERE doc_id = ?', [docId]);
      await run(c.env.DB, 'UPDATE filings SET ingest_status = ? WHERE doc_id = ?', [
        'error',
        docId,
      ]);
      await recordIngestionDecision(c.env.DB, {
        docId,
        action: 'rejected',
        source: 'admin',
        actor: adminActor(c),
        reason: review.reason ?? 'rejected',
        payload: {
          reviewCreatedAt: review.created_at,
          reviewPayload: review.payload ? safeJson(review.payload) : null,
        },
        createdAt: nowIso,
      });
      return c.json({ docId, decision: 'reject', resolved: true });
    }

    // confirm/manual: insert the (corrected or hand-entered) transactions.
    // 'manual' tags provenance so admins can tell hand-entered rows from machine reads.
    const source: TxSource = decision === 'manual' ? 'manual' : 'primary';
    if (!Array.isArray(body.edits)) {
      return c.json(
        {
          error:
            decision === 'confirm'
              ? 'confirm requires explicit transaction edits; choose a model, edit the queued rows, or reject the item'
              : 'manual review requires explicit transaction edits',
        },
        400,
      );
    }
    const edits = body.edits as EditedTx[];
    if (edits.length === 0) {
      return c.json(
        {
          error:
            decision === 'confirm'
              ? 'confirm requires at least one explicit transaction edit; use Manual to add rows or Reject to discard'
              : 'manual review requires at least one transaction edit',
        },
        400,
      );
    }
    const filing = await get<{ filer_id: string | null }>(
      c.env.DB,
      'SELECT filer_id FROM filings WHERE doc_id = ?',
      [docId],
    );
    const filingFilerId = filing?.filer_id ?? null;

    const insertedIds: string[] = [];
    const nowIso = new Date().toISOString();
    for (const [rowIndex, e] of edits.entries()) {
      const id = uuid();
      const assetTypeName = reviewAssetTypeName(e);
      const rowKey = transactionRowKey(source, rowIndex, {
        txDate: e.txDate ?? null,
        owner: e.owner === 'self' || e.owner === 'spouse' || e.owner === 'joint' || e.owner === 'dependent'
          ? e.owner
          : null,
        assetName: e.assetName ?? '',
        ticker: e.ticker ?? null,
        assetType: e.assetType ?? null,
        assetTypeName,
        txType: (e.txType as TxType) ?? 'P',
        amountMin: e.amountMin ?? null,
        amountMax: e.amountMax ?? null,
        isOption: Boolean(e.isOption),
        capGainsOver200: Boolean(e.capGainsOver200),
        rawText: e.rawText ?? '',
      });
      // cursor_seq is DB-assigned by trg_transactions_cursor (insert with NULL).
      const res = await run(
        c.env.DB,
        `INSERT OR IGNORE INTO transactions (
           id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
           tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
           raw_text, asset_type_name, row_key, confidence, source, created_at, cursor_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
          assetTypeName,
          rowKey,
          e.confidence ?? 1,
          source,
          nowIso,
        ],
      );
      if ((res.meta?.changes ?? 1) > 0) insertedIds.push(id);
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

    await recordIngestionDecision(c.env.DB, {
      docId,
      action: decision === 'manual' ? 'manual' : 'confirmed',
      source: 'admin',
      actor: adminActor(c),
      reason: review.reason ?? null,
      transactionIds: insertedIds,
      payload: {
        source,
        editCount: edits.length,
        inserted: insertedIds.length,
        reviewCreatedAt: review.created_at,
      },
      createdAt: nowIso,
    });

    return c.json({
      docId,
      decision,
      source,
      resolved: true,
      inserted: insertedIds.length,
      transactionIds: insertedIds,
    });
  });

  // --- POST /review/:docId/unpublish --------------------------------------
  // Retract a previously-published filing: soft-delete its primary transactions
  // (deprecated_at), revert the filing to 'needs_review', and re-open the review
  // item so it returns to the pending queue. Soft-delete (not hard delete) keeps
  // history and lets every feed/analytics/stream read exclude the rows via
  // `deprecated_at IS NULL`. Already-delivered webhook/SSE events cannot be
  // recalled — this stops the rows being served going forward.
  // Body (optional): { reason?: string }
  r.post('/review/:docId/unpublish', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const reason = typeof body.reason === 'string' && body.reason.length ? body.reason : 'unpublished by admin';

    const filing = await get<{ ingest_status: string | null }>(
      c.env.DB,
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (!filing) return c.json({ error: 'filing not found' }, 404);

    const nowIso = new Date().toISOString();
    // Soft-delete the live primary rows for this doc.
    const res = await run(
      c.env.DB,
      `UPDATE transactions
          SET deprecated_at = ?, deprecated_reason = ?
        WHERE doc_id = ? AND source IN ('primary', 'manual') AND deprecated_at IS NULL`,
      [nowIso, reason, docId],
    );
    const deprecated = res.meta?.changes ?? 0;

    // Revert the filing and re-open the review item (back into the pending queue).
    await run(c.env.DB, 'UPDATE filings SET ingest_status = ? WHERE doc_id = ?', ['needs_review', docId]);
    await run(
      c.env.DB,
      `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved)
         VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(doc_id) DO UPDATE SET resolved = 0, reason = excluded.reason, created_at = excluded.created_at`,
      [docId, 'unpublished: ' + reason, null, nowIso],
    );

    await recordIngestionDecision(c.env.DB, {
      docId,
      action: 'unpublished',
      source: 'admin',
      actor: adminActor(c),
      reason,
      payload: { deprecatedTransactions: deprecated },
      createdAt: nowIso,
    });

    return c.json({ docId, unpublished: true, deprecatedTransactions: deprecated, reason });
  });

  // --- GET /sources/health ------------------------------------------------
  // Recent ingest_log aggregates per source: last poll, last new filing, and the
  // observed average interval between polls (seconds).
  r.get('/sources/health', async (c) => {
    const latencyResetAt = await getLatencyResetAt(c.env);
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
        avgReleasedToSeenSec: await observedReleasedToSeenLag(c.env, row.source, latencyResetAt),
        avgSeenToImportedSec: await observedSeenToImportedLag(c.env, row.source, latencyResetAt),
      });
    }
    return c.json({ sources, count: sources.length, latencyResetAt });
  });

  // --- POST /sources/health/latency-reset ---------------------------------
  // Reset only the observed latency baseline. Historical rows stay untouched;
  // future Source Health averages ignore rows first seen before this timestamp.
  r.post('/sources/health/latency-reset', async (c) => {
    const latencyResetAt = new Date().toISOString();
    await setLatencyResetAt(c.env, latencyResetAt);
    return c.json({ ok: true, latencyResetAt });
  });

  // --- GET /disclosure-latency/summary ------------------------------------
  // Aggregate provider-race metrics. `publicSummary` intentionally excludes
  // filing/member detail so it can be reviewed before any public sharing.
  r.get('/disclosure-latency/summary', async (c) => {
    return c.json(await getDisclosureLatencySummary(c.env));
  });

  // --- GET /disclosure-latency -------------------------------------------
  // Congress.Trade-vs-provider race monitor. `providerDeltaSec` is provider
  // monitor first-observed minus Congress.Trade first_seen_at: positive means we
  // observed first; negative means the provider was already observed first.
  r.get('/disclosure-latency', async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200);
    const provider = (c.req.query('provider') || '').trim().toLowerCase();
    const where = provider ? 'WHERE provider = ?' : '';
    const params: SqlParam[] = provider ? [provider, limit] : [limit];
    const rows = await optionalAll<{
      doc_id: string;
      provider: string;
      chamber: string;
      source_url: string | null;
      filed_date: string | null;
      filer_name: string | null;
      congress_first_seen_at: string;
      provider_key: string | null;
      provider_first_seen_at: string | null;
      provider_published_at: string | null;
      match_method: string | null;
      status: string;
      attempts: number;
      last_checked_at: string | null;
      error: string | null;
      created_at: string;
      updated_at: string;
    }>(
      c.env,
      `SELECT doc_id, provider, chamber, source_url, filed_date, filer_name,
              congress_first_seen_at, provider_key, provider_first_seen_at, provider_published_at,
              match_method, status, attempts, last_checked_at, error,
              created_at, updated_at
         FROM disclosure_latency_candidates
        ${where}
        ORDER BY created_at DESC
        LIMIT ?`,
      params,
    );
    const items = rows.map((row) => ({
      docId: row.doc_id,
      provider: row.provider,
      chamber: row.chamber,
      sourceUrl: row.source_url,
      filedDate: row.filed_date,
      filerName: row.filer_name,
      congressFirstSeenAt: row.congress_first_seen_at,
      providerKey: row.provider_key,
      providerFirstSeenAt: row.provider_first_seen_at,
      providerDeltaSec: deltaSeconds(row.provider_first_seen_at, row.congress_first_seen_at),
      providerPublishedAt: row.provider_published_at,
      providerPublishedDeltaSec: deltaSeconds(row.provider_published_at, row.congress_first_seen_at),
      matchMethod: row.match_method,
      status: row.status,
      attempts: row.attempts,
      lastCheckedAt: row.last_checked_at,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return c.json({ count: items.length, items });
  });

  // --- POST /disclosure-latency/probe -------------------------------------
  // Force a one-off provider latest probe, useful immediately after new filings
  // land or before turning on the continuous cron switch. Optional query:
  // ?providers=fmp,unusual_whales,quiver
  r.post('/disclosure-latency/probe', async (c) => {
    const providers = (c.req.query('providers') || c.req.query('provider') || '')
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const result = await runDisclosureLatencyProbe(c.env, new Date(), fetch, { force: true, providers });
    return c.json({ ok: result.errors.length === 0, ...result });
  });

  // --- GET /diagnostics ---------------------------------------------------
  // Admin operational snapshot: provider/source connection status, usage counts,
  // and recent errors collected from existing D1 tables. This intentionally
  // reports only whether secrets are configured, never their values.
  r.get('/diagnostics', async (c) => {
    const now = new Date();
    const last24 = hoursAgoIso(24, now);
    const today = dayStartIso(now);
    const runtimeSecrets = await resolveSecrets(c.env, [
      'GEMINI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
      'LLAMAINDEX_API_KEY',
      'LLAMAPARSE_API_KEY',
      'ARBITRATION_API_KEY',
      'FMP_API_KEY',
      'MASSIVE_API_KEY',
      'INTRINIO_API_KEY',
      'TWELVEDATA_API_KEY',
      'FINNHUB_API_KEY',
      'LOGODEV_PUBLISHABLE_KEY',
      'APP_B_IMPORT_URL',
      'APP_B_INGEST_TOKEN',
      'INGEST_TOKEN',
      'WEBHOOK_SIGNING_KEY',
      'GOOGLE_OAUTH_CLIENT_ID',
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'STRIPE_SECRET_KEY',
    ]);
    const secretStatus = getSecretResolverStatus(c.env);
    const adminConfig = await adminRuntimeConfig(c.env);

    const connections: DiagnosticConnection[] = [];
    const infisicalFailures = secretStatus.sources.filter((s) => s.configured && !s.ok).length;
    connections.push({
      id: 'secrets:infisical',
      label: 'Infisical Runtime Secrets',
      status: !secretStatus.enabled ? 'warn' : infisicalFailures || secretStatus.errors.length ? 'error' : 'ok',
      configured: secretStatus.enabled,
      lastUsedAt: secretStatus.lastRefreshAt,
      callsTotal: secretStatus.sources.reduce((sum, s) => sum + s.count, 0),
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: secretStatus.errors.length,
      note: secretStatus.enabled
        ? `Cache ${secretStatus.cacheReady ? 'ready' : 'empty'}; expires in ${secretStatus.cacheExpiresInSeconds ?? 0}s; env fallback ${secretStatus.envFallbackAllowed ? 'allowed' : 'disabled'}`
        : 'Infisical machine identity bootstrap secrets are not available to this Worker runtime',
    });

    const sourceRows = await optionalAll<{
      source: string;
      last_used_at: string | null;
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
    }>(
      c.env,
      `SELECT source,
              MAX(polled_at) AS last_used_at,
              COUNT(*) AS calls_total,
              SUM(CASE WHEN polled_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN polled_at >= ? THEN 1 ELSE 0 END) AS calls_today
         FROM ingest_log
        GROUP BY source`,
      [last24, today],
    );
    for (const row of sourceRows) {
      connections.push({
        id: `source:${row.source}`,
        label: `${titleCaseSource(row.source)} Source`,
        status: connectionStatus(true, 0, row.last_used_at),
        configured: true,
        lastUsedAt: row.last_used_at,
        callsTotal: row.calls_total,
        callsLast24h: row.calls_last_24h,
        callsToday: row.calls_today,
        errorsLast24h: 0,
        note: 'Source checks recorded by ingest_log',
      });
    }

    const extractionRows = await optionalAll<{
      provider: string;
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT provider,
              COUNT(*) AS calls_total,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(created_at) AS last_used_at,
              SUM(CASE WHEN ok = 0 AND created_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM extraction_runs
        GROUP BY provider`,
      [last24, today, last24],
    );
    const extractionByProvider = new Map(extractionRows.map((row) => [row.provider.toLowerCase(), row]));

    const gemini = await get<{
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env.DB,
      `SELECT COUNT(*) AS calls_total,
              SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(first_seen_at) AS last_used_at,
              SUM(CASE WHEN error IS NOT NULL AND error != '' AND first_seen_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM filings
        WHERE extractor = 'visionLlm'
           OR model_version LIKE 'gemini%'
           OR error LIKE '%Gemini%'
           OR error LIKE '%visionLlm%'`,
      [last24, today, last24],
    );
    const geminiExtract = extractionByProvider.get('gemini');
    const geminiLastUsed = maxIso(gemini?.last_used_at ?? null, geminiExtract?.last_used_at ?? null);
    const geminiErrors = (gemini?.errors_last_24h ?? 0) + (geminiExtract?.errors_last_24h ?? 0);
    connections.push({
      id: 'provider:gemini',
      label: 'Gemini OCR',
      status: connectionStatus(!!runtimeSecrets.GEMINI_API_KEY, geminiErrors, geminiLastUsed),
      configured: !!runtimeSecrets.GEMINI_API_KEY,
      lastUsedAt: geminiLastUsed,
      callsTotal: (gemini?.calls_total ?? 0) + (geminiExtract?.calls_total ?? 0),
      callsLast24h: (gemini?.calls_last_24h ?? 0) + (geminiExtract?.calls_last_24h ?? 0),
      callsToday: (gemini?.calls_today ?? 0) + (geminiExtract?.calls_today ?? 0),
      errorsLast24h: geminiErrors,
      note: runtimeSecrets.GEMINI_API_KEY ? 'Production OCR + bake-off extraction runs' : 'GEMINI_API_KEY is not available to this Worker runtime',
    });

    const modelProviders: Array<{ id: string; provider: string; label: string; configured: boolean; note: string }> = [
      {
        id: 'provider:openai',
        provider: 'openai',
        label: 'OpenAI OCR',
        configured: !!runtimeSecrets.OPENAI_API_KEY,
        note: runtimeSecrets.OPENAI_API_KEY ? 'Bake-off / review extraction candidate' : 'OPENAI_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:anthropic',
        provider: 'anthropic',
        label: 'Anthropic OCR',
        configured: !!runtimeSecrets.ANTHROPIC_API_KEY,
        note: runtimeSecrets.ANTHROPIC_API_KEY ? 'Bake-off / review extraction candidate' : 'ANTHROPIC_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:mistral',
        provider: 'mistral',
        label: 'Mistral OCR',
        configured: !!runtimeSecrets.MISTRAL_API_KEY,
        note: runtimeSecrets.MISTRAL_API_KEY ? 'Bake-off / batch OCR candidate' : 'MISTRAL_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:xai',
        provider: 'xai',
        label: 'xAI OCR',
        configured: !!runtimeSecrets.XAI_API_KEY,
        note: runtimeSecrets.XAI_API_KEY ? 'Bake-off / batch OCR candidate' : 'XAI_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:llamaparse',
        provider: 'llamaparse',
        label: 'LlamaParse OCR',
        configured: !!(runtimeSecrets.LLAMAINDEX_API_KEY || runtimeSecrets.LLAMAPARSE_API_KEY),
        note: runtimeSecrets.LLAMAINDEX_API_KEY || runtimeSecrets.LLAMAPARSE_API_KEY
          ? 'LlamaIndex Cloud parser candidate'
          : 'LLAMAINDEX_API_KEY/LLAMAPARSE_API_KEY is not available to this Worker runtime',
      },
    ];
    for (const provider of modelProviders) {
      const row = extractionByProvider.get(provider.provider);
      connections.push({
        id: provider.id,
        label: provider.label,
        status: connectionStatus(provider.configured, row?.errors_last_24h ?? 0, row?.last_used_at ?? null),
        configured: provider.configured,
        lastUsedAt: row?.last_used_at ?? null,
        callsTotal: row?.calls_total ?? 0,
        callsLast24h: row?.calls_last_24h ?? 0,
        callsToday: row?.calls_today ?? 0,
        errorsLast24h: row?.errors_last_24h ?? 0,
        note: provider.note,
      });
    }

    connections.push({
      id: 'provider:arbitration',
      label: 'Arbitration Model',
      status: runtimeSecrets.ARBITRATION_API_KEY ? 'ok' : 'warn',
      configured: !!runtimeSecrets.ARBITRATION_API_KEY,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.ARBITRATION_API_KEY ? 'Secondary arbitration key available' : 'ARBITRATION_API_KEY is not available to this Worker runtime',
    });

    // Cross-app trade delivery health: outbound push to peer apps (Agentic
    // Trading) over webhook + SSE subscriptions. Surfaces 24h delivery outcomes
    // and any dead-lettered messages so a silently-broken peer connection is
    // visible to admins instead of failing unseen.
    const deliveryStats = await optionalAll<{
      total: number;
      delivered: number;
      failed: number;
      pending: number;
      today: number;
      last_delivered: string | null;
      last_failed: string | null;
    }>(
      c.env,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS today,
              MAX(CASE WHEN status = 'delivered' THEN updated_at END) AS last_delivered,
              MAX(CASE WHEN status = 'failed' THEN updated_at END) AS last_failed
         FROM deliveries
        WHERE updated_at >= ?`,
      [today, last24],
    );
    const subCounts = await optionalAll<{ active: number; webhook: number; sse: number }>(
      c.env,
      `SELECT COUNT(*) AS active,
              SUM(CASE WHEN delivery = 'webhook' THEN 1 ELSE 0 END) AS webhook,
              SUM(CASE WHEN delivery = 'sse' THEN 1 ELSE 0 END) AS sse
         FROM subscriptions WHERE active = 1`,
    );
    const dlq = await optionalAll<{ n: number; last_at: string | null }>(
      c.env,
      `SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM dead_letter_events
        WHERE queue LIKE '%delivery%' AND created_at >= ?`,
      [last24],
    );
    const ds = deliveryStats[0] ?? { total: 0, delivered: 0, failed: 0, pending: 0, today: 0, last_delivered: null, last_failed: null };
    const sc = subCounts[0] ?? { active: 0, webhook: 0, sse: 0 };
    const dlqCount = dlq[0]?.n ?? 0;
    const crossAppErrors = (ds.failed ?? 0) + dlqCount;
    connections.push({
      id: 'delivery:cross-app',
      label: 'Cross-App Trade Delivery',
      status:
        dlqCount > 0 ? 'error'
        : crossAppErrors > 0 ? 'warn'
        : (sc.active ?? 0) === 0 ? 'unknown'
        : (ds.delivered ?? 0) > 0 ? 'ok'
        : 'unknown',
      configured: (sc.active ?? 0) > 0,
      lastUsedAt: maxIso(ds.last_delivered, ds.last_failed),
      callsTotal: ds.total ?? 0,
      callsLast24h: ds.total ?? 0,
      callsToday: ds.today ?? 0,
      errorsLast24h: crossAppErrors,
      note:
        `${sc.active ?? 0} active subscription(s) (${sc.webhook ?? 0} webhook, ${sc.sse ?? 0} SSE); ` +
        `24h: ${ds.delivered ?? 0} delivered, ${ds.failed ?? 0} failed, ${ds.pending ?? 0} pending` +
        (dlqCount ? `; ${dlqCount} dead-lettered (see delivery DLQ)` : ''),
    });

    const fmp = await optionalAll<{
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS calls_total,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(enriched_at) AS last_used_at,
              SUM(CASE WHEN enrichment_error IS NOT NULL AND enrichment_error != '' AND enriched_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM securities_ref`,
      [last24, today, last24],
    );
    const fmpRow = fmp[0];
    connections.push({
      id: 'provider:fmp',
      label: 'FMP Market Data',
      status: connectionStatus(!!runtimeSecrets.FMP_API_KEY, fmpRow?.errors_last_24h ?? 0, fmpRow?.last_used_at ?? null),
      configured: !!runtimeSecrets.FMP_API_KEY,
      lastUsedAt: fmpRow?.last_used_at ?? null,
      callsTotal: fmpRow?.calls_total ?? 0,
      callsLast24h: fmpRow?.calls_last_24h ?? 0,
      callsToday: fmpRow?.calls_today ?? 0,
      errorsLast24h: fmpRow?.errors_last_24h ?? 0,
      note: runtimeSecrets.FMP_API_KEY ? 'Enrichment rows refreshed' : 'FMP_API_KEY is not available to this Worker runtime',
    });

    const appBReceivedRows = await optionalAll<{
      imported_refs: number;
      fundamentals_rows: number;
      analyst_rows: number;
      latest_import_at: string | null;
    }>(
      c.env,
      `SELECT
         (SELECT COUNT(*) FROM securities_ref WHERE source = 'imported') AS imported_refs,
         (SELECT COUNT(*) FROM fundamentals_eod WHERE source = 'imported') AS fundamentals_rows,
         (SELECT COUNT(*) FROM analyst_consensus WHERE source = 'imported') AS analyst_rows,
         (SELECT MAX(updated_at)
            FROM (
              SELECT updated_at FROM fundamentals_eod WHERE source = 'imported'
              UNION ALL
              SELECT updated_at FROM analyst_consensus WHERE source = 'imported'
            )) AS latest_import_at`,
    );
    const appBReceived = appBReceivedRows[0];
    const appBReceivedTotal =
      (appBReceived?.imported_refs ?? 0) + (appBReceived?.fundamentals_rows ?? 0) + (appBReceived?.analyst_rows ?? 0);
    connections.push({
      id: 'app-b:receive',
      label: 'App B → Congress.Trade Import',
      status: connectionStatus(!!runtimeSecrets.INGEST_TOKEN, 0, appBReceived?.latest_import_at ?? null),
      configured: !!runtimeSecrets.INGEST_TOKEN,
      lastUsedAt: appBReceived?.latest_import_at ?? null,
      callsTotal: appBReceivedTotal,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.INGEST_TOKEN
        ? 'Scoped import token configured; activity inferred from imported market-data rows'
        : 'INGEST_TOKEN is not available to receive App B imports',
    });

    const appBPushConfigured = !!(runtimeSecrets.APP_B_IMPORT_URL && runtimeSecrets.APP_B_INGEST_TOKEN);
    connections.push({
      id: 'app-b:send',
      label: 'Congress.Trade → App B Push',
      status: appBPushConfigured ? 'ok' : 'warn',
      configured: appBPushConfigured,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: appBPushConfigured
        ? 'Outbound shared-data push is configured; no send audit table exists yet'
        : 'APP_B_IMPORT_URL/APP_B_INGEST_TOKEN is missing or incomplete',
    });

    const providerRows = await optionalAll<{
      provider: string;
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT CASE
                WHEN lower(source) LIKE '%massive%' THEN 'massive'
                WHEN lower(source) LIKE '%intrinio%' THEN 'intrinio'
                WHEN lower(source) LIKE '%twelvedata%' THEN 'twelvedata'
                WHEN lower(source) LIKE '%finnhub%' THEN 'finnhub'
                WHEN lower(source) LIKE '%edgar%' THEN 'edgar'
                ELSE 'other'
              END AS provider,
              COUNT(*) AS calls_total,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(enriched_at) AS last_used_at,
              SUM(CASE WHEN enrichment_error IS NOT NULL AND enrichment_error != '' AND enriched_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM securities_ref
        WHERE source IS NOT NULL AND source != ''
        GROUP BY provider`,
      [last24, today, last24],
    );
    const providerUsage = new Map(providerRows.map((row) => [row.provider, row]));
    const addMarketProvider = (id: string, label: string, configured: boolean, note: string) => {
      const row = providerUsage.get(id);
      connections.push({
        id: `provider:${id}`,
        label,
        status: connectionStatus(configured, row?.errors_last_24h ?? 0, row?.last_used_at ?? null),
        configured,
        lastUsedAt: row?.last_used_at ?? null,
        callsTotal: row?.calls_total ?? 0,
        callsLast24h: row?.calls_last_24h ?? 0,
        callsToday: row?.calls_today ?? 0,
        errorsLast24h: row?.errors_last_24h ?? 0,
        note,
      });
    };
    addMarketProvider('massive', 'Massive Market Data', !!runtimeSecrets.MASSIVE_API_KEY, runtimeSecrets.MASSIVE_API_KEY ? 'Reference/price fallback configured' : 'MASSIVE_API_KEY is not available to this Worker runtime');
    addMarketProvider('intrinio', 'Intrinio Reference Data', !!runtimeSecrets.INTRINIO_API_KEY, runtimeSecrets.INTRINIO_API_KEY ? 'Reference fallback configured' : 'INTRINIO_API_KEY is not available to this Worker runtime');
    addMarketProvider('twelvedata', 'Twelve Data Reference', !!runtimeSecrets.TWELVEDATA_API_KEY, runtimeSecrets.TWELVEDATA_API_KEY ? 'Reference fallback configured' : 'TWELVEDATA_API_KEY is not available to this Worker runtime');
    addMarketProvider('finnhub', 'Finnhub Reference', !!runtimeSecrets.FINNHUB_API_KEY, runtimeSecrets.FINNHUB_API_KEY ? 'Reference fallback configured' : 'FINNHUB_API_KEY is not available to this Worker runtime');
    addMarketProvider('edgar', 'SEC EDGAR Reference', true, 'Free fallback; no secret required');

    connections.push({
      id: 'provider:logodev',
      label: 'Logo.dev',
      status: runtimeSecrets.LOGODEV_PUBLISHABLE_KEY ? 'ok' : 'warn',
      configured: !!runtimeSecrets.LOGODEV_PUBLISHABLE_KEY,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.LOGODEV_PUBLISHABLE_KEY ? 'Ticker logo proxy token available' : 'LOGODEV_PUBLISHABLE_KEY is not available to this Worker runtime',
    });

    const priceRows = await optionalAll<{ last_used_at: string | null }>(
      c.env,
      `SELECT MAX(date) AS last_used_at FROM price_eod`
    );
    const priceRow = priceRows[0];
    const hasPriceProvider = !!(runtimeSecrets.FMP_API_KEY || runtimeSecrets.MASSIVE_API_KEY);
    connections.push({
      id: 'cache:prices',
      label: 'Asset Price Cache',
      status: connectionStatus(hasPriceProvider, 0, priceRow?.last_used_at ?? null),
      configured: hasPriceProvider,
      lastUsedAt: priceRow?.last_used_at ?? null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: hasPriceProvider
        ? `PRICE_PROVIDER=${c.env.PRICE_PROVIDER || 'fmp'}; counts show cached assets/rows, not raw API calls`
        : 'No FMP_API_KEY or MASSIVE_API_KEY configured for price history',
    });

    const spxRows = await optionalAll<{ last_used_at: string | null }>(
      c.env,
      `SELECT MAX(date) AS last_used_at FROM spx_eod`
    );
    const spxRow = spxRows[0];
    connections.push({
      id: 'cache:spx',
      label: 'S&P Benchmark Cache',
      status: connectionStatus(hasPriceProvider, 0, spxRow?.last_used_at ?? null),
      configured: hasPriceProvider,
      lastUsedAt: spxRow?.last_used_at ?? null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: 'SPY-adjusted close history used as the S&P comparison baseline',
    });

    const perfRows = await optionalAll<{ last_used_at: string | null }>(
      c.env,
      `SELECT MAX(computed_at) AS last_used_at FROM tx_performance`
    );
    const perfRow = perfRows[0];
    connections.push({
      id: 'cache:performance',
      label: 'Trade Performance Anchors',
      status: connectionStatus(hasPriceProvider, 0, perfRow?.last_used_at ?? null),
      configured: hasPriceProvider,
      lastUsedAt: perfRow?.last_used_at ?? null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: 'Required for per-trade and member S&P-relative performance',
    });

    const webhooks = await optionalAll<{
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS calls_total,
              SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(updated_at) AS last_used_at,
              SUM(CASE WHEN last_error IS NOT NULL AND last_error != '' AND updated_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM deliveries`,
      [last24, today, last24],
    );
    const wh = webhooks[0];
    connections.push({
      id: 'delivery:webhook',
      label: 'Webhook Delivery',
      status: connectionStatus(!!runtimeSecrets.WEBHOOK_SIGNING_KEY, wh?.errors_last_24h ?? 0, wh?.last_used_at ?? null),
      configured: !!runtimeSecrets.WEBHOOK_SIGNING_KEY,
      lastUsedAt: wh?.last_used_at ?? null,
      callsTotal: wh?.calls_total ?? 0,
      callsLast24h: wh?.calls_last_24h ?? 0,
      callsToday: wh?.calls_today ?? 0,
      errorsLast24h: wh?.errors_last_24h ?? 0,
      note: runtimeSecrets.WEBHOOK_SIGNING_KEY ? 'Delivery attempts recorded' : 'WEBHOOK_SIGNING_KEY is not available to this Worker runtime',
    });

    connections.push({
      id: 'auth:google',
      label: 'Google Sign-In',
      status: runtimeSecrets.GOOGLE_OAUTH_CLIENT_ID ? 'ok' : 'warn',
      configured: !!runtimeSecrets.GOOGLE_OAUTH_CLIENT_ID,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.GOOGLE_OAUTH_CLIENT_ID ? 'Client id available' : 'GOOGLE_OAUTH_CLIENT_ID is not available to this Worker runtime',
    });
    connections.push({
      id: 'email:resend',
      label: 'Email',
      status: runtimeSecrets.RESEND_API_KEY && runtimeSecrets.EMAIL_FROM ? 'ok' : 'warn',
      configured: !!(runtimeSecrets.RESEND_API_KEY && runtimeSecrets.EMAIL_FROM),
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.RESEND_API_KEY && runtimeSecrets.EMAIL_FROM ? 'Resend sender available' : 'RESEND_API_KEY/EMAIL_FROM unavailable or incomplete',
    });
    connections.push({
      id: 'billing:stripe',
      label: 'Stripe Billing',
      status: runtimeSecrets.STRIPE_SECRET_KEY ? 'ok' : 'warn',
      configured: !!runtimeSecrets.STRIPE_SECRET_KEY,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.STRIPE_SECRET_KEY ? 'Secret key available' : 'STRIPE_SECRET_KEY is not available to this Worker runtime',
    });

    const errors: DiagnosticError[] = [];
    for (const source of secretStatus.sources) {
      if (source.configured && !source.ok) {
        errors.push({
          at: secretStatus.lastRefreshAt ?? now.toISOString(),
          area: 'Infisical',
          severity: 'error',
          subject: source.name,
          message: source.error ?? 'Secret source failed to refresh',
        });
      }
    }
    if (!runtimeSecrets.FMP_API_KEY) {
      errors.push({
        at: now.toISOString(),
        area: 'Fallback / Degraded Mode',
        severity: 'warning',
        subject: 'Security enrichment',
        message:
          'FMP_API_KEY is not available to this Worker runtime; enrichment uses runtime-available secondary providers and the EDGAR baseline for missing fields.',
      });
    }
    if (!runtimeSecrets.FMP_API_KEY && runtimeSecrets.MASSIVE_API_KEY) {
      errors.push({
        at: now.toISOString(),
        area: 'Fallback / Degraded Mode',
        severity: 'warning',
        subject: 'Price refresh',
        message:
          'FMP_API_KEY is not available to this Worker runtime; price refresh will use MASSIVE_API_KEY as the provider fallback.',
      });
    } else if (!runtimeSecrets.FMP_API_KEY && !runtimeSecrets.MASSIVE_API_KEY) {
      errors.push({
        at: now.toISOString(),
        area: 'Fallback / Degraded Mode',
        severity: 'warning',
        subject: 'Price refresh',
        message: 'No FMP_API_KEY or MASSIVE_API_KEY is available to this Worker runtime; price refresh is disabled.',
      });
    }
    const filingErrors = await optionalAll<{
      first_seen_at: string | null;
      doc_id: string;
      error: string;
    }>(
      c.env,
      `SELECT first_seen_at, doc_id, error
         FROM filings
        WHERE error IS NOT NULL AND error != ''
        ORDER BY first_seen_at DESC
        LIMIT 40`,
    );
    for (const e of filingErrors) {
      errors.push({ at: e.first_seen_at, area: 'Filing', severity: 'error', subject: e.doc_id, message: e.error });
    }

    const reviewErrors = await optionalAll<{
      created_at: string | null;
      doc_id: string;
      reason: string | null;
    }>(
      c.env,
      `SELECT created_at, doc_id, reason
         FROM review_queue
        WHERE resolved = 0
        ORDER BY created_at DESC
        LIMIT 40`,
    );
    for (const e of reviewErrors) {
      errors.push({
        at: e.created_at,
        area: 'Review Queue',
        severity: 'warning',
        subject: e.doc_id,
        message: e.reason ?? 'Needs review',
      });
    }

    const deliveryErrors = await optionalAll<{
      updated_at: string | null;
      id: string;
      last_error: string | null;
    }>(
      c.env,
      `SELECT updated_at, id, last_error
         FROM deliveries
        WHERE last_error IS NOT NULL AND last_error != ''
        ORDER BY updated_at DESC
        LIMIT 40`,
    );
    for (const e of deliveryErrors) {
      errors.push({ at: e.updated_at, area: 'Delivery', severity: 'error', subject: e.id, message: e.last_error ?? '' });
    }

    const enrichmentErrors = await optionalAll<{
      enriched_at: string | null;
      ticker: string;
      enrichment_error: string | null;
    }>(
      c.env,
      `SELECT enriched_at, ticker, enrichment_error
         FROM securities_ref
        WHERE enrichment_error IS NOT NULL AND enrichment_error != ''
        ORDER BY enriched_at DESC
        LIMIT 40`,
    );
    for (const e of enrichmentErrors) {
      errors.push({
        at: e.enriched_at,
        area: 'Enrichment',
        severity: 'error',
        subject: e.ticker,
        message: e.enrichment_error ?? '',
      });
    }

    const commandErrors = await optionalAll<{
      updated_at: string | null;
      id: string;
      type: string;
      error: string | null;
    }>(
      c.env,
      `SELECT updated_at, id, type, error
         FROM client_commands
        WHERE error IS NOT NULL AND error != ''
        ORDER BY updated_at DESC
        LIMIT 40`,
    );
    for (const e of commandErrors) {
      errors.push({
        at: e.updated_at,
        area: 'Client Command',
        severity: 'error',
        subject: `${e.type} ${e.id}`,
        message: e.error ?? '',
      });
    }

    const userRows = await optionalAll<{
      total_users: number;
      subscribed_users: number;
      logins_last_24h: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS total_users,
              SUM(CASE WHEN subscription_status IN ('active', 'trialing') THEN 1 ELSE 0 END) AS subscribed_users,
              SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS logins_last_24h
         FROM users`,
      [last24],
    );
    const deliverySubRows = await optionalAll<{
      total: number;
      active: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active
         FROM subscriptions`,
    );
    const recentLogins = await optionalAll<{
      email: string;
      name: string | null;
      last_login_at: string | null;
      plan: string | null;
      subscription_status: string | null;
    }>(
      c.env,
      `SELECT email, name, last_login_at, plan, subscription_status
         FROM users
        WHERE last_login_at IS NOT NULL
        ORDER BY last_login_at DESC
        LIMIT 10`,
    );
    const userRow = userRows[0];
    const deliverySubRow = deliverySubRows[0];
    const userStats: DiagnosticUserStats = {
      totalUsers: userRow?.total_users ?? 0,
      subscribedUsers: userRow?.subscribed_users ?? 0,
      deliverySubscriptions: deliverySubRow?.total ?? 0,
      activeDeliverySubscriptions: deliverySubRow?.active ?? 0,
      adminUsers: adminConfig.allow.size,
      loginsLast24h: userRow?.logins_last_24h ?? 0,
      recentLogins: recentLogins.map((row) => ({
        email: row.email,
        name: row.name,
        lastLoginAt: row.last_login_at,
        plan: row.plan,
        subscriptionStatus: row.subscription_status,
      })),
    };

    errors.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''));
    return c.json({
      generatedAt: now.toISOString(),
      connections,
      secrets: secretStatus,
      userStats,
      errors: errors.slice(0, 75),
      errorCount: errors.length,
    });
  });

  // --- POST /diagnostics/secrets/refresh ----------------------------------
  // Force-refresh the Infisical secret cache. This does not write plaintext
  // secrets into KV/D1/Cloudflare vars; optional KV cache entries are encrypted.
  r.post('/diagnostics/secrets/refresh', async (c) => {
    return c.json({ secrets: await refreshSecrets(c.env) });
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
  // maxFilings defaults to 500. dryRun only counts matching PTRs; it does not
  // write filings rows or enqueue pipeline work.
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
      const hasHardFailure = hasHardFailureFlags(flagged);

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
  // Run N House PTR PDFs through several vision models (Gemini/OpenAI/Anthropic/Mistral/xAI)
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
      const valid: Provider[] = ['gemini', 'openai', 'anthropic', 'mistral', 'xai'];
      const parsed: BakeoffCandidate[] = [];
      for (const m of body.models) {
        const o = m as { provider?: unknown; model?: unknown };
        if (!valid.includes(o.provider as Provider) || typeof o.model !== 'string') {
          return c.json({ error: 'each model must be {provider:gemini|openai|anthropic|mistral|xai, model:string}' }, 400);
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

    // Only docs with a stored raw PDF actually reach runCandidateOnDoc below;
    // filter before charging the cap so a request full of explicit docIds with
    // no raw_object_key can't burn the whole daily quota on rows that will be
    // skipped without calling any provider.
    docs = docs.filter((d) => d.raw_object_key);

    if (docs.length === 0) {
      return c.json({ error: 'no House filings with a stored PDF were found to test' }, 404);
    }

    // Daily spend guardrail. A bake-off fans out (docs × candidates) external
    // vision-model calls; an admin running n=50 with the 6-model default fires
    // ~300 paid calls in one request with no metering. Cap the per-day total so
    // a single request (or a busy day) can't run up an unbounded LLM bill.
    // Approximate (KV fixed window); raise BAKEOFF_DAILY_CALL_CAP to lift it.
    // Only candidates with a configured API key actually reach a provider
    // (runCandidateOnDoc below short-circuits to an "API key not configured"
    // result otherwise) — charge the cap for those only, so an environment
    // with just one or two providers configured doesn't exhaust the daily
    // budget on calls that were never going to happen.
    const configuredCount = (
      await Promise.all(candidates.map((cand) => keyFor(c.env, cand.provider)))
    ).filter(Boolean).length;
    const plannedCalls = docs.length * configuredCount;
    const dailyCap =
      Number((c.env as { BAKEOFF_DAILY_CALL_CAP?: string }).BAKEOFF_DAILY_CALL_CAP ?? '200') || 200;
    const capDay = new Date().toISOString().slice(0, 10);
    const capKey = `bakeoff:calls:${capDay}`;
    let usedToday = 0;
    try {
      usedToday = parseInt((await c.env.CONFIG_KV.get(capKey)) || '0', 10) || 0;
    } catch {
      /* fail open on KV read error */
    }
    if (usedToday + plannedCalls > dailyCap) {
      return c.json(
        {
          error: 'bake-off daily call cap reached',
          plannedCalls,
          usedToday,
          dailyCap,
          hint: 'reduce n or models, or raise BAKEOFF_DAILY_CALL_CAP',
        },
        429,
      );
    }
    try {
      await c.env.CONFIG_KV.put(capKey, String(usedToday + plannedCalls), { expirationTtl: 172800 });
    } catch {
      /* fail open on KV write error */
    }

    // Persist each model's reading by default (set persist:false to skip) so the
    // results land in extraction_runs for the review dashboard + later learning.
    const persist = body.persist !== false;
    const batchId = uuid();
    const nowIso = new Date().toISOString();

    const results: CandidateDocResult[] = [];
    const skipped: string[] = [];
    let persistErrors = 0;
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
        const res = await runCandidateOnDoc(c.env, candidate, doc_id, bytes);
        results.push(res);
        if (persist) {
          try {
            await run(
              c.env.DB,
              `INSERT INTO extraction_runs
                 (id, batch_id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, created_at)
               VALUES (?, ?, ?, ?, ?, 'bakeoff', ?, ?, ?, ?, ?, ?, ?)`,
              [
                uuid(),
                batchId,
                res.docId,
                res.provider,
                res.model,
                res.ok ? 1 : 0,
                res.error ?? null,
                res.rowCount,
                res.latencyMs,
                res.avgConfidence,
                JSON.stringify(res.rows ?? []),
                nowIso,
              ],
            );
          } catch {
            // Table may not exist yet (pre-migration) — keep the bake-off read-only-safe.
            persistErrors++;
          }
        }
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
      persisted: persist && persistErrors === 0,
      batchId: persist ? batchId : null,
      models: summarizeModels(candidates, results),
      perDoc,
    });
  });

  // --- POST /batch-submit -------------------------------------------------
  // Kick off an async, ~50%-cheaper batch extraction for a set of docs (backlog
  // reprocessing — NOT the live feed). Body: { provider, model, docIds?, n? }.
  // Returns immediately with a jobId to poll via /batch-status/:jobId.
  r.post('/batch-submit', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!isBatchProvider(body.provider)) {
      return c.json({ error: 'provider must be anthropic | openai | mistral | xai' }, 400);
    }
    const provider = body.provider;
    const model =
      typeof body.model === 'string' && body.model
        ? body.model
        : provider === 'anthropic' ? 'claude-haiku-4-5'
        : provider === 'openai' ? 'gpt-4o'
        : provider === 'xai' ? 'grok-4.3'
        : 'mistral-ocr-latest';

    let n = typeof body.n === 'number' && body.n > 0 ? Math.floor(body.n) : 50;
    if (n > 200) n = 200;

    let docRows: Array<{ doc_id: string; raw_object_key: string | null }>;
    if (Array.isArray(body.docIds) && body.docIds.length > 0) {
      const ids = body.docIds.filter((x): x is string => typeof x === 'string').slice(0, n);
      docRows = [];
      for (const id of ids) {
        const row = await get<{ doc_id: string; raw_object_key: string | null }>(
          c.env.DB,
          'SELECT doc_id, raw_object_key FROM filings WHERE doc_id = ?',
          [id],
        );
        if (row) docRows.push(row);
      }
    } else {
      // Default target: the unresolved review backlog (what batch is cheapest for).
      docRows = await all<{ doc_id: string; raw_object_key: string | null }>(
        c.env.DB,
        `SELECT f.doc_id, f.raw_object_key
           FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
          WHERE rq.resolved = 0 AND f.raw_object_key IS NOT NULL
          ORDER BY rq.created_at DESC LIMIT ?`,
        [n],
      );
    }

    const docs: BatchDoc[] = [];
    const skipped: string[] = [];
    for (const { doc_id, raw_object_key } of docRows) {
      if (!raw_object_key) { skipped.push(`${doc_id}: no raw_object_key`); continue; }
      const obj = await c.env.RAW_FILES.get(raw_object_key);
      if (!obj) { skipped.push(`${doc_id}: R2 object missing`); continue; }
      docs.push({ docId: doc_id, bytes: await obj.arrayBuffer() });
    }
    if (docs.length === 0) return c.json({ error: 'no documents with a stored PDF to batch', skipped }, 404);

    let providerBatchId: string;
    try {
      providerBatchId = await submitBatch(c.env, provider, model, docs);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }

    const jobId = uuid();
    await run(
      c.env.DB,
      `INSERT INTO batch_jobs (id, provider, model, provider_batch_id, doc_ids, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?)`,
      [jobId, provider, model, providerBatchId, JSON.stringify(docs.map((d) => d.docId)), new Date().toISOString()],
    );
    return c.json({ jobId, provider, model, providerBatchId, docCount: docs.length, skipped, poll: `/api/admin/batch-status/${jobId}` });
  });

  // --- GET /batch-jobs ----------------------------------------------------
  r.get('/batch-jobs', async (c) => {
    let jobs: Array<Record<string, unknown>> = [];
    try {
      const rowsB = await all<Record<string, unknown>>(
        c.env.DB,
        `SELECT id, provider, model, provider_batch_id, doc_ids, status, submitted_at, completed_at, turnaround_ms, result_summary, error
           FROM batch_jobs ORDER BY submitted_at DESC LIMIT 50`,
      );
      jobs = rowsB.map((j) => ({
        ...j,
        doc_ids: typeof j.doc_ids === 'string' ? safeJson(j.doc_ids) : j.doc_ids,
        result_summary: typeof j.result_summary === 'string' ? safeJson(j.result_summary) : j.result_summary,
      }));
    } catch {
      /* table not migrated */
    }
    return c.json({ jobs, count: jobs.length });
  });

  // --- POST /batch-status/:jobId ------------------------------------------
  // Poll the provider; when finished, persist each doc's reading into
  // extraction_runs (kind='batch') and record the real turnaround on batch_jobs.
  r.post('/batch-status/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    const job = await get<{
      id: string; provider: string; model: string; provider_batch_id: string | null;
      doc_ids: string; status: string; submitted_at: string;
    }>(
      c.env.DB,
      'SELECT id, provider, model, provider_batch_id, doc_ids, status, submitted_at FROM batch_jobs WHERE id = ?',
      [jobId],
    );
    if (!job) return c.json({ error: 'batch job not found' }, 404);
    if (!isBatchProvider(job.provider) || !job.provider_batch_id) {
      return c.json({ error: 'job missing provider batch id' }, 409);
    }
    if (job.status === 'completed' || job.status === 'failed') {
      return c.json({ jobId, status: job.status, alreadyFinished: true });
    }

    let poll;
    try {
      poll = await pollBatch(c.env, job.provider, job.provider_batch_id);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }

    if (!poll.done) {
      await run(c.env.DB, 'UPDATE batch_jobs SET status = ? WHERE id = ?', ['running', jobId]);
      return c.json({ jobId, status: 'running', providerStatus: poll.status });
    }

    const completedAt = new Date().toISOString();
    const turnaroundMs = Date.parse(completedAt) - Date.parse(job.submitted_at);
    let okCount = 0;
    let rowTotal = 0;
    const errors: string[] = [];

    if (!poll.failed) {
      for (const res of poll.results) {
        if (res.ok) { okCount++; rowTotal += res.rows.length; } else errors.push(`${res.docId}: ${res.error ?? 'failed'}`);
        const avg = res.rows.length ? res.rows.reduce((s, x) => s + (x.confidence ?? 0), 0) / res.rows.length : 0;
        try {
          await run(
            c.env.DB,
            `INSERT INTO extraction_runs
               (id, batch_id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, created_at)
             VALUES (?, ?, ?, ?, ?, 'batch', ?, ?, ?, ?, ?, ?, ?)`,
            [uuid(), jobId, res.docId, job.provider, job.model, res.ok ? 1 : 0, res.error ?? null,
             res.rows.length, turnaroundMs, Math.round(avg * 1000) / 1000, JSON.stringify(res.rows), completedAt],
          );
        } catch { /* extraction_runs missing */ }
      }
    }

    const summary = { docs: poll.results.length, ok: okCount, rows: rowTotal, errors: errors.slice(0, 20) };
    await run(
      c.env.DB,
      'UPDATE batch_jobs SET status = ?, completed_at = ?, turnaround_ms = ?, result_summary = ?, error = ? WHERE id = ?',
      [poll.failed ? 'failed' : 'completed', completedAt, turnaroundMs, JSON.stringify(summary), poll.failed ? poll.status : null, jobId],
    );
    return c.json({
      jobId,
      status: poll.failed ? 'failed' : 'completed',
      turnaroundMs,
      turnaroundMin: Math.round((turnaroundMs / 60000) * 10) / 10,
      summary,
    });
  });

  // --- POST /agreement-reprocess ------------------------------------------
  // Agreement-based auto-publish for the backlog. For each doc, run TWO
  // independent (cross-vendor) models; when they FULLY agree on the row set
  // (every row's ticker|date|type matches), the read is trusted and published
  // (ticker-resolved + bracket-validated via the normalizer) instead of held in
  // review — agreement substitutes for the conservative 0.60 vision-confidence
  // cap. Disagreements (or hard structural failures) stay in review.
  //
  // Body: { docIds?, n?, models:[{provider,model},{provider,model}],
  //         requireThird?:{provider,model}, dryRun?:boolean (default TRUE) }
  // dryRun reports what WOULD publish without writing — always preview first.
  r.post('/agreement-reprocess', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parseModel = (m: unknown): BakeoffCandidate | null => {
      const o = m as { provider?: unknown; model?: unknown };
      const valid: Provider[] = ['gemini', 'openai', 'anthropic', 'mistral', 'xai'];
      return valid.includes(o.provider as Provider) && typeof o.model === 'string'
        ? { provider: o.provider as Provider, model: o.model }
        : null;
    };
    const models = Array.isArray(body.models) ? body.models.map(parseModel) : [];
    if (models.length !== 2 || models.some((m) => !m)) {
      return c.json({ error: 'models must be exactly two {provider,model} from gemini|openai|anthropic|mistral|xai' }, 400);
    }
    const [mA, mB] = models as BakeoffCandidate[];
    const mC = body.requireThird ? parseModel(body.requireThird) : null;
    if (body.requireThird && !mC) return c.json({ error: 'requireThird must be {provider,model}' }, 400);
    const dryRun = body.dryRun !== false; // default true — preview unless explicitly false

    let n = typeof body.n === 'number' && body.n > 0 ? Math.floor(body.n) : 25;
    if (n > 100) n = 100;

    let docRows: Array<{ doc_id: string; raw_object_key: string | null }>;
    if (Array.isArray(body.docIds) && body.docIds.length > 0) {
      const ids = body.docIds.filter((x): x is string => typeof x === 'string').slice(0, n);
      docRows = [];
      for (const id of ids) {
        const row = await get<{ doc_id: string; raw_object_key: string | null }>(
          c.env.DB,
          'SELECT doc_id, raw_object_key FROM filings WHERE doc_id = ?',
          [id],
        );
        if (row) docRows.push(row);
      }
    } else {
      docRows = await all<{ doc_id: string; raw_object_key: string | null }>(
        c.env.DB,
        `SELECT f.doc_id, f.raw_object_key
           FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
          WHERE rq.resolved = 0 AND f.raw_object_key IS NOT NULL
          ORDER BY rq.created_at DESC LIMIT ?`,
        [n],
      );
    }

    const agModels: AgreementModels = { a: mA, b: mB, c: mC };
    const results: Array<Record<string, unknown>> = [];
    let published = 0, wouldPublish = 0, disagree = 0, hardfail = 0, skipped = 0;

    for (const { doc_id, raw_object_key } of docRows) {
      const res = await processAgreementDoc(c.env, agModels, doc_id, raw_object_key, dryRun);
      results.push(res as unknown as Record<string, unknown>);
      if (res.outcome === 'published') published++;
      else if (res.outcome === 'would_publish') wouldPublish++;
      else if (res.outcome === 'disagree') disagree++;
      else if (res.outcome === 'agree_but_hardfail') hardfail++;
      else skipped++;
    }

    return c.json({
      ok: true,
      dryRun,
      models: { a: `${mA.provider}:${mA.model}`, b: `${mB.provider}:${mB.model}`, ...(mC ? { c: `${mC.provider}:${mC.model}` } : {}) },
      docsProcessed: docRows.length,
      summary: { published, wouldPublish, disagree, hardfail, skipped },
      results,
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
      // 0006_prices.sql — price history + per-trade performance vs S&P 500.
      `CREATE TABLE IF NOT EXISTS price_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
         PRIMARY KEY (ticker, date)
       )`,
      'CREATE INDEX IF NOT EXISTS idx_price_eod_ticker_date ON price_eod (ticker, date DESC)',
      'CREATE TABLE IF NOT EXISTS spx_eod (date TEXT PRIMARY KEY, close REAL NOT NULL)',
      `CREATE TABLE IF NOT EXISTS tx_performance (
         tx_id TEXT PRIMARY KEY, price_at_trade REAL, spx_at_trade REAL, computed_at TEXT
       )`,
      'ALTER TABLE securities_ref ADD COLUMN current_price REAL',
      'ALTER TABLE securities_ref ADD COLUMN current_price_date TEXT',
      // 0007_market_extras.sql — daily volume + insider / short-volume datasets.
      'ALTER TABLE price_eod ADD COLUMN volume INTEGER',
      `CREATE TABLE IF NOT EXISTS insider_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, sentiment REAL,
         buy_filings INTEGER, sell_filings INTEGER, buy_shares REAL, sell_shares REAL,
         owners TEXT, PRIMARY KEY (ticker, date)
       )`,
      `CREATE TABLE IF NOT EXISTS short_volume_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, short_volume_ratio REAL,
         elevated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ticker, date)
       )`,
      // 0008_idempotency_keys.sql — at-least-once retry guards.
      'ALTER TABLE transactions ADD COLUMN row_key TEXT',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_doc_source_rowkey
         ON transactions (doc_id, source, row_key)
         WHERE row_key IS NOT NULL`,
      `DELETE FROM deliveries
         WHERE rowid NOT IN (
           SELECT MAX(rowid)
             FROM deliveries
            GROUP BY subscription_id, tx_id
         )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_subscription_tx
         ON deliveries (subscription_id, tx_id)`,
      // 0009_client_api.sql — shared PWA / SwiftUI client state.
      `CREATE TABLE IF NOT EXISTS user_preferences (
         user_id TEXT PRIMARY KEY,
         saved_filters TEXT NOT NULL DEFAULT '{}',
         watchlist TEXT NOT NULL DEFAULT '[]',
         notification_settings TEXT NOT NULL DEFAULT '{}',
         default_window TEXT,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS client_commands (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         type TEXT NOT NULL,
         status TEXT NOT NULL,
         idempotency_key TEXT,
         payload TEXT NOT NULL DEFAULT '{}',
         result TEXT,
         error TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         started_at TEXT,
         finished_at TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_client_commands_user_idempotency
         ON client_commands (user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_client_commands_user_created
         ON client_commands (user_id, created_at DESC)`,
      'CREATE INDEX IF NOT EXISTS idx_client_commands_status ON client_commands (status)',
      // 0010_fundamentals.sql — sibling-app fundamentals + analyst consensus cache.
      `CREATE TABLE IF NOT EXISTS fundamentals_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, pe_ratio REAL, eps REAL, beta REAL,
         dividend_yield REAL, week52_high REAL, week52_low REAL, fcf_yield REAL,
         debt_to_equity REAL, eps_growth REAL, source TEXT, updated_at TEXT NOT NULL,
         PRIMARY KEY (ticker, date)
       )`,
      `CREATE TABLE IF NOT EXISTS analyst_consensus (
         ticker TEXT NOT NULL, date TEXT NOT NULL, rating TEXT, target_mean REAL,
         target_high REAL, target_low REAL, target_median REAL, analyst_count INTEGER,
         strong_buy INTEGER, buy INTEGER, hold INTEGER, sell INTEGER, strong_sell INTEGER,
         source TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (ticker, date)
       )`,
      // 0011_transaction_row_details.sql — row-specific House PTR details.
      'ALTER TABLE transactions ADD COLUMN asset_type_name TEXT',
      'ALTER TABLE transactions ADD COLUMN filing_status TEXT',
      'ALTER TABLE transactions ADD COLUMN subholding TEXT',
      'ALTER TABLE transactions ADD COLUMN location TEXT',
      'ALTER TABLE transactions ADD COLUMN description TEXT',
      'ALTER TABLE transactions ADD COLUMN supplemental_text TEXT',
      'CREATE INDEX IF NOT EXISTS idx_tx_asset_type_name ON transactions (asset_type_name)',
      // 0012_shares_outstanding.sql — keep market cap current off the daily close.
      'ALTER TABLE securities_ref ADD COLUMN shares_outstanding REAL',
      `UPDATE securities_ref SET shares_outstanding = market_cap / current_price
         WHERE shares_outstanding IS NULL AND market_cap IS NOT NULL
           AND current_price IS NOT NULL AND current_price > 0`,
      // 0013_tx_deprecation.sql — soft-delete so admins can un-publish filings.
      'ALTER TABLE transactions ADD COLUMN deprecated_at TEXT',
      'ALTER TABLE transactions ADD COLUMN deprecated_reason TEXT',
      'CREATE INDEX IF NOT EXISTS idx_tx_deprecated_at ON transactions (deprecated_at)',
      // 0014_tx_perf_filing_anchors.sql — disclosure-date performance anchors.
      'ALTER TABLE tx_performance ADD COLUMN price_at_filing REAL',
      'ALTER TABLE tx_performance ADD COLUMN spx_at_filing REAL',
      // 0015_extraction_runs.sql — per-doc per-model extraction results (bake-off + review dashboard).
      `CREATE TABLE IF NOT EXISTS extraction_runs (
         id TEXT PRIMARY KEY, batch_id TEXT, doc_id TEXT NOT NULL,
         provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bakeoff',
         ok INTEGER NOT NULL DEFAULT 0, error TEXT, row_count INTEGER NOT NULL DEFAULT 0,
         latency_ms INTEGER, avg_confidence REAL, result_json TEXT, created_at TEXT NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_doc ON extraction_runs (doc_id)',
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_batch ON extraction_runs (batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_created ON extraction_runs (created_at)',
      // 0016_batch_jobs.sql — async batch reprocessing jobs (cheaper backlog path).
      `CREATE TABLE IF NOT EXISTS batch_jobs (
         id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
         provider_batch_id TEXT, doc_ids TEXT NOT NULL, status TEXT NOT NULL,
         submitted_at TEXT NOT NULL, completed_at TEXT, turnaround_ms INTEGER,
         result_summary TEXT, error TEXT)`,
      'CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs (status)',
      'CREATE INDEX IF NOT EXISTS idx_batch_jobs_submitted ON batch_jobs (submitted_at)',
      // 0017_fb_meta_remap.sql — Facebook's old "FB" ticker was reassigned by the
      // SEC to a ProShares ETF after Meta moved to "META", so congressional FB
      // trades were showing the ProShares name. Remap stored FB rows to META and
      // fix the cached names. Idempotent (UPDATEs).
      "UPDATE transactions SET ticker = 'META' WHERE ticker = 'FB' AND deprecated_at IS NULL",
      "UPDATE securities_ref SET company_name = 'Meta Platforms, Inc.' WHERE ticker = 'META' AND (company_name IS NULL OR company_name = '' OR company_name LIKE '%ProShares%')",
      "UPDATE securities_master SET name = 'Meta Platforms, Inc.' WHERE ticker = 'META'",
      // 0018_agreement_attempted.sql — one autonomous agreement attempt per review doc.
      'ALTER TABLE review_queue ADD COLUMN agreement_attempted_at TEXT',
      'CREATE INDEX IF NOT EXISTS idx_review_queue_agreement ON review_queue (agreement_attempted_at)',
      // 0019_ingestion_decisions.sql — append-only audit trail for publication/review decisions.
      `CREATE TABLE IF NOT EXISTS ingestion_decisions (
         id TEXT PRIMARY KEY,
         doc_id TEXT NOT NULL,
         action TEXT NOT NULL,
         source TEXT NOT NULL,
         actor TEXT,
         reason TEXT,
         payload TEXT,
         transaction_ids TEXT NOT NULL DEFAULT '[]',
         created_at TEXT NOT NULL
       )`,
      'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_doc ON ingestion_decisions (doc_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_created ON ingestion_decisions (created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_action ON ingestion_decisions (action, created_at DESC)',
      // 0020_disclosure_available_generated.sql — generated column for disclosure availability.
      'ALTER TABLE transactions ADD COLUMN first_seen_at TEXT',
      'ALTER TABLE transactions ADD COLUMN filed_date TEXT',
      `UPDATE transactions SET
         first_seen_at = (SELECT first_seen_at FROM filings WHERE filings.doc_id = transactions.doc_id),
         filed_date = (SELECT filed_date FROM filings WHERE filings.doc_id = transactions.doc_id)`,
      `ALTER TABLE transactions ADD COLUMN disclosure_available_at TEXT GENERATED ALWAYS AS (
         COALESCE(first_seen_at, CASE WHEN filed_date IS NOT NULL THEN filed_date || 'T00:00:00.000Z' END, created_at)
       )`,
      'CREATE INDEX IF NOT EXISTS idx_tx_disclosure_available_ticker ON transactions (disclosure_available_at, ticker, id)',
      // 0021_disclosure_latency_watch.sql — Congress.Trade-vs-FMP disclosure race monitor.
      `CREATE TABLE IF NOT EXISTS disclosure_latency_candidates (
         doc_id TEXT NOT NULL,
         provider TEXT NOT NULL DEFAULT 'fmp',
         chamber TEXT NOT NULL,
         source_url TEXT,
         filed_date TEXT,
         filer_name TEXT,
         congress_first_seen_at TEXT NOT NULL,
         provider_key TEXT,
         provider_first_seen_at TEXT,
         provider_published_at TEXT,
         match_method TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         attempts INTEGER NOT NULL DEFAULT 0,
         last_checked_at TEXT,
         error TEXT,
         payload TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (doc_id, provider)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_disc_latency_candidates_status
         ON disclosure_latency_candidates (provider, status, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS disclosure_provider_observations (
         provider TEXT NOT NULL,
         chamber TEXT NOT NULL,
         provider_key TEXT NOT NULL,
         first_observed_at TEXT NOT NULL,
         last_observed_at TEXT NOT NULL,
         provider_published_at TEXT,
         source_url TEXT,
         filed_date TEXT,
         filer_name TEXT,
         payload TEXT,
         PRIMARY KEY (provider, chamber, provider_key)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_disc_provider_seen
         ON disclosure_provider_observations (provider, chamber, first_observed_at DESC)`,
      // 0022_stripe_webhook_events.sql — durable Stripe webhook idempotency ledger.
      `CREATE TABLE IF NOT EXISTS stripe_webhook_events (
         event_id TEXT PRIMARY KEY,
         event_type TEXT NOT NULL,
         received_at TEXT NOT NULL,
         processed_at TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received
         ON stripe_webhook_events (received_at DESC)`,
      // 0023_disclosure_provider_timestamps.sql — provider-side publish/upload timestamp when available.
      'ALTER TABLE disclosure_latency_candidates ADD COLUMN provider_published_at TEXT',
      'ALTER TABLE disclosure_provider_observations ADD COLUMN provider_published_at TEXT',
      // 0024_dead_letter_events.sql — operator log for terminally-failed queue messages.
      `CREATE TABLE IF NOT EXISTS dead_letter_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         queue TEXT NOT NULL,
         msg_type TEXT,
         doc_id TEXT,
         tx_id TEXT,
         attempts INTEGER,
         error TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_dead_letter_created ON dead_letter_events(created_at)`,
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
    const opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {};
    if (typeof body.max === 'number' && body.max > 0) opts.max = Math.floor(body.max);
    if (typeof body.maxPerMinute === 'number' && body.maxPerMinute > 0) opts.maxPerMinute = Math.floor(body.maxPerMinute);
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
    const retryIncomplete = hasConfiguredKeyedEnrichmentProvider(c.env);
    const row = await get<{ pending: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS pending FROM (
         SELECT t.ticker FROM transactions t
         LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
         WHERE t.ticker IS NOT NULL AND t.ticker <> ''
           AND ${enrichmentNeededSql('sr', retryIncomplete)}
         GROUP BY t.ticker)`,
    );
    const enriched = await get<{ n: number }>(
      c.env.DB,
      'SELECT COUNT(*) AS n FROM securities_ref WHERE enriched_at IS NOT NULL',
    );
    const pending = await marketPending(c.env);
    const coverage = await marketCoverage(c.env);
    return c.json({
      fmpCallsToday: used,
      pendingTickers: row?.pending ?? 0,
      pricePendingTickers: pending.prices,
      enrichedTickers: enriched?.n ?? 0,
      coverage,
      hasFmpKey: !!(c.env as Env & { FMP_API_KEY?: string }).FMP_API_KEY,
      hasKeyedEnrichmentProvider: retryIncomplete,
    });
  });

  // --- POST /refresh-prices -----------------------------------------------
  // Budgeted price + performance refresh (FMP-only): updates the S&P series and,
  // for tickers needing it, caches daily closes + computes per-trade anchors.
  // Shares the daily FMP budget with enrichment. Body: { max?, dryRun? }.
  r.post('/refresh-prices', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {};
    if (typeof body.max === 'number' && body.max > 0) opts.max = Math.floor(body.max);
    if (typeof body.maxPerMinute === 'number' && body.maxPerMinute > 0) opts.maxPerMinute = Math.floor(body.maxPerMinute);
    if (body.dryRun === true) opts.dryRun = true;
    try {
      const result = await runPriceRefresh(c.env, opts);
      return c.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /backfill-market ----------------------------------------------
  // One bounded pass of enrichment + price refresh in a single call, for fast
  // paid-tier history backfilling. A single Worker invocation is capped by
  // Cloudflare's per-request subrequest/CPU limits, so this does ONE safe batch
  // and reports what's left — loop it (see scripts/backfill-market.sh) until
  // `done` is true. Body (all optional):
  //   { max?: number,           // tickers per pass for EACH of enrich + prices (default 40)
  //     maxPerMinute?: number,  // throttle FMP calls/min (paid tier ~300; avoids 429s)
  //     dryRun?: boolean }
  r.post('/backfill-market', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const max = typeof body.max === 'number' && body.max > 0 ? Math.floor(body.max) : 40;
    const maxPerMinute =
      typeof body.maxPerMinute === 'number' && body.maxPerMinute > 0 ? Math.floor(body.maxPerMinute) : undefined;
    const dryRun = body.dryRun === true;
    try {
      const enrich = await runEnrichment(c.env, { max, maxPerMinute, dryRun });
      const prices = await runPriceRefresh(c.env, { max, maxPerMinute, dryRun });
      const pending = await marketPending(c.env);
      return c.json({
        ok: enrich.errors.length === 0 && prices.errors.length === 0,
        done: pending.enrich === 0 && pending.prices === 0,
        pending,
        enrich,
        prices,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /securities/import --------------------------------------------
  // Share FMP data fetched by ANOTHER app (e.g. a local Next.js app) into this
  // Worker's cache, so a fetch by either app serves both — no duplicate FMP
  // calls here. Body (all optional):
  //   { refs?: [{ ticker, sector?, marketCap?, country?, exchangeShort?, ... }],
  //     spx?: [{ date, close }],
  //     prices?: [{ ticker, closes?: [{date,close,volume?}], currentPrice?, currentPriceDate? }],
  //     insider?: [{ ticker, date, sentiment?, buyFilings?, sellFilings?, buyShares?, sellShares?, owners? }],
  //     shortVolume?: [{ ticker, date, ratio, elevated? }],
  //     fundamentals?: [{ ticker, date, peRatio?, eps?, beta?, dividendYield?,
  //                       week52High?, week52Low?, fcfYield?, debtToEquity?, epsGrowth? }],
  //     analyst?: [{ ticker, date, rating?, targetMean?, targetHigh?, targetLow?,
  //                  targetMedian?, analystCount?, strongBuy?, buy?, hold?, sell?, strongSell? }] }
  // Upserts securities_ref / spx_eod / price_eod / insider_eod / short_volume_eod /
  // fundamentals_eod / analyst_consensus and recomputes per-trade
  // performance anchors for imported tickers. Idempotent. Authorized by the
  // full ADMIN_TOKEN/Access OR the scoped INGEST_TOKEN (this endpoint only).
  r.post('/securities/import', async (c) => {
    // This endpoint runs inside a normal Worker request. Keep callers honest.
    // Paid Workers allow larger batches, but the cap remains configurable so
    // the app can be dialed back without code changes.
    const limits = importLimits(c.env);
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (contentLength > limits.bytes) {
      return c.json(
        {
          error: 'import payload too large; split into smaller batches',
          maxBytes: limits.bytes,
          receivedBytes: contentLength,
          suggestedLimits: importLimitResponse(limits),
        },
        413,
      );
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const summary = {
      refs: 0, spxRows: 0, pricedTickers: 0, priceRows: 0, perfTickers: 0,
      insiderRows: 0, shortVolumeRows: 0, fundamentalsRows: 0, analystRows: 0,
      errors: [] as string[],
    };
    const nowIso = new Date().toISOString();
    const oversized =
      countArray(body.refs) > limits.refs ||
      countArray(body.spx) > limits.spx ||
      countArray(body.prices) > limits.prices ||
      countArray(body.insider) > limits.insider ||
      countArray(body.shortVolume) > limits.shortVolume ||
      (Array.isArray(body.prices) &&
        (body.prices as Array<{ closes?: unknown }>).some((p) => countArray(p.closes) > limits.closesPerTicker));
    if (oversized) {
      return c.json(
        {
          error: 'import batch too large; split into smaller batches',
          limits: importLimitResponse(limits),
        },
        413,
      );
    }

    const REF_KEYS = [
      'companyName', 'sector', 'industry', 'assetClass', 'isEtf', 'isAdr', 'country',
      'stateHq', 'stateOfIncorp', 'exchange', 'exchangeShort', 'currency', 'marketCap',
      'sharesOutstanding', 'ipoDate', 'cik', 'sicCode', 'sicDescription',
    ] as const;

    // 1) Company reference rows. Build all upsert statements first, then flush
    // them through DB.batch in chunks of 100 (the same pattern every other slot
    // below uses). The previous per-row `await` serialized one D1 round trip per
    // ref — with batches near the 2000-ref cap that repeatedly tripped the
    // Worker CPU limit and overloaded D1. On a chunk failure we fall back to
    // per-row writes for that chunk so a single bad ref still gets attributed.
    if (Array.isArray(body.refs)) {
      const refStmts: { ticker: string; stmt: D1PreparedStatement }[] = [];
      for (const raw of body.refs as unknown[]) {
        const o = raw as Record<string, unknown>;
        const ticker = typeof o.ticker === 'string' ? o.ticker.toUpperCase() : null;
        if (!ticker) continue;
        const partial: Partial<SecurityRef> = { source: 'imported' };
        for (const k of REF_KEYS) if (o[k] !== undefined) (partial as Record<string, unknown>)[k] = o[k];
        refStmts.push({ ticker, stmt: prepareImportSecurityRef(c.env, mergeRefs(ticker, [partial])) });
      }
      for (let i = 0; i < refStmts.length; i += 100) {
        const chunk = refStmts.slice(i, i + 100);
        try {
          await c.env.DB.batch(chunk.map((r) => r.stmt));
          summary.refs += chunk.length;
        } catch {
          // Batch failed as a unit — retry the chunk row-by-row to surface the
          // specific ticker(s) at fault without dropping the whole chunk.
          for (const r of chunk) {
            try {
              await r.stmt.run();
              summary.refs++;
            } catch (e) {
              summary.errors.push(r.ticker + ' ref: ' + (e as Error).message);
            }
          }
        }
      }
    }

    // 2) S&P 500 closes.
    if (Array.isArray(body.spx)) {
      const rows = (body.spx as Array<{ date?: unknown; close?: unknown }>)
        .filter((x) => typeof x.date === 'string' && typeof x.close === 'number')
        .slice(0, limits.spx);
      for (let i = 0; i < rows.length; i += 100) {
        await c.env.DB.batch(
          rows.slice(i, i + 100).map((x) =>
            c.env.DB.prepare(
              'INSERT INTO spx_eod (date, close) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET close=excluded.close',
            ).bind((x.date as string).slice(0, 10), x.close as number),
          ),
        );
      }
      summary.spxRows += rows.length;
    }

    // 3) Per-ticker price history (+ current price), then recompute anchors.
    if (Array.isArray(body.prices)) {
      for (const raw of body.prices as unknown[]) {
        const o = raw as { ticker?: unknown; closes?: unknown; currentPrice?: unknown; currentPriceDate?: unknown };
        const ticker = typeof o.ticker === 'string' ? o.ticker.toUpperCase() : null;
        if (!ticker) continue;
        const closes = Array.isArray(o.closes)
          ? (o.closes as Array<{ date?: unknown; close?: unknown; volume?: unknown }>)
              .filter((x) => typeof x.date === 'string' && typeof x.close === 'number')
              .slice(0, limits.closesPerTicker)
          : [];
        try {
          for (let i = 0; i < closes.length; i += 100) {
            await c.env.DB.batch(
              closes.slice(i, i + 100).map((x) =>
                c.env.DB.prepare(
                  `INSERT INTO price_eod (ticker, date, close, volume) VALUES (?, ?, ?, ?)
                   ON CONFLICT(ticker, date) DO UPDATE SET close=excluded.close,
                     volume=COALESCE(excluded.volume, price_eod.volume)`,
                ).bind(
                  ticker,
                  (x.date as string).slice(0, 10),
                  x.close as number,
                  typeof x.volume === 'number' ? Math.round(x.volume) : null,
                ),
              ),
            );
          }
          summary.priceRows += closes.length;
          if (typeof o.currentPrice === 'number') {
            await run(
              c.env.DB,
              `INSERT INTO securities_ref (ticker, current_price, current_price_date) VALUES (?, ?, ?)
               ON CONFLICT(ticker) DO UPDATE SET current_price=excluded.current_price, current_price_date=excluded.current_price_date`,
              [ticker, o.currentPrice, typeof o.currentPriceDate === 'string' ? o.currentPriceDate : nowIso.slice(0, 10)],
            );
          }
          // Recompute per-trade anchors for this ticker from the cached series.
          await run(
            c.env.DB,
            `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, computed_at)
             SELECT t.id,
               (SELECT close FROM price_eod p WHERE p.ticker = t.ticker AND p.date <= t.tx_date ORDER BY p.date DESC LIMIT 1),
               (SELECT close FROM spx_eod s WHERE s.date <= t.tx_date ORDER BY s.date DESC LIMIT 1),
               ?
             FROM transactions t
             WHERE t.ticker = ? AND t.tx_date IS NOT NULL AND t.tx_date <> ''
             ON CONFLICT(tx_id) DO UPDATE SET price_at_trade=excluded.price_at_trade, spx_at_trade=excluded.spx_at_trade, computed_at=excluded.computed_at`,
            [nowIso, ticker],
          );
          summary.pricedTickers++;
          summary.perfTickers++;
        } catch (e) {
          summary.errors.push(ticker + ' price: ' + (e as Error).message);
        }
      }
    }

    // 4) Insider (SEC Form 4) daily aggregates: [{ ticker, date, sentiment?,
    //    buyFilings?, sellFilings?, buyShares?, sellShares?, owners?:[...] }].
    if (Array.isArray(body.insider)) {
      const rows = (body.insider as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, limits.insider);
      for (let i = 0; i < rows.length; i += 100) {
        await c.env.DB.batch(
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO insider_eod (ticker, date, sentiment, buy_filings, sell_filings, buy_shares, sell_shares, owners)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 sentiment=COALESCE(excluded.sentiment, insider_eod.sentiment),
                 buy_filings=COALESCE(excluded.buy_filings, insider_eod.buy_filings),
                 sell_filings=COALESCE(excluded.sell_filings, insider_eod.sell_filings),
                 buy_shares=COALESCE(excluded.buy_shares, insider_eod.buy_shares),
                 sell_shares=COALESCE(excluded.sell_shares, insider_eod.sell_shares),
                 owners=COALESCE(excluded.owners, insider_eod.owners)`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              numOrNull(o.sentiment),
              intOrNull(o.buyFilings),
              intOrNull(o.sellFilings),
              numOrNull(o.buyShares),
              numOrNull(o.sellShares),
              Array.isArray(o.owners) ? JSON.stringify(o.owners) : null,
            ),
          ),
        );
      }
      summary.insiderRows += rows.length;
    }

    // 5) FINRA short-volume daily: [{ ticker, date, ratio, elevated? }].
    if (Array.isArray(body.shortVolume)) {
      const rows = (body.shortVolume as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, limits.shortVolume);
      for (let i = 0; i < rows.length; i += 100) {
        await c.env.DB.batch(
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO short_volume_eod (ticker, date, short_volume_ratio, elevated)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 short_volume_ratio=COALESCE(excluded.short_volume_ratio, short_volume_eod.short_volume_ratio),
                 elevated=excluded.elevated`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              numOrNull(o.ratio),
              o.elevated ? 1 : 0,
            ),
          ),
        );
      }
      summary.shortVolumeRows += rows.length;
    }

    // 6) Fundamentals daily snapshot pushed by a sibling app (saves our FMP
    //    quota). [{ ticker, date, peRatio?, eps?, beta?, dividendYield?,
    //    week52High?, week52Low?, fcfYield?, debtToEquity?, epsGrowth? }].
    //    week52High/Low also accept the `52wHigh`/`52wLow` aliases.
    if (Array.isArray(body.fundamentals)) {
      const rows = (body.fundamentals as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, 20000);
      for (let i = 0; i < rows.length; i += 100) {
        await c.env.DB.batch(
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO fundamentals_eod (ticker, date, pe_ratio, eps, beta, dividend_yield,
                 week52_high, week52_low, fcf_yield, debt_to_equity, eps_growth, source, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 pe_ratio=COALESCE(excluded.pe_ratio, fundamentals_eod.pe_ratio),
                 eps=COALESCE(excluded.eps, fundamentals_eod.eps),
                 beta=COALESCE(excluded.beta, fundamentals_eod.beta),
                 dividend_yield=COALESCE(excluded.dividend_yield, fundamentals_eod.dividend_yield),
                 week52_high=COALESCE(excluded.week52_high, fundamentals_eod.week52_high),
                 week52_low=COALESCE(excluded.week52_low, fundamentals_eod.week52_low),
                 fcf_yield=COALESCE(excluded.fcf_yield, fundamentals_eod.fcf_yield),
                 debt_to_equity=COALESCE(excluded.debt_to_equity, fundamentals_eod.debt_to_equity),
                 eps_growth=COALESCE(excluded.eps_growth, fundamentals_eod.eps_growth),
                 source=excluded.source, updated_at=excluded.updated_at`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              numOrNull(o.peRatio),
              numOrNull(o.eps),
              numOrNull(o.beta),
              numOrNull(o.dividendYield),
              numOrNull(o.week52High ?? o['52wHigh']),
              numOrNull(o.week52Low ?? o['52wLow']),
              numOrNull(o.fcfYield),
              numOrNull(o.debtToEquity),
              numOrNull(o.epsGrowth),
              nowIso,
            ),
          ),
        );
      }
      summary.fundamentalsRows += rows.length;
    }

    // 7) Analyst consensus snapshot. [{ ticker, date, rating?, targetMean?,
    //    targetHigh?, targetLow?, targetMedian?, analystCount?, strongBuy?,
    //    buy?, hold?, sell?, strongSell? }].
    if (Array.isArray(body.analyst)) {
      const rows = (body.analyst as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, 20000);
      for (let i = 0; i < rows.length; i += 100) {
        await c.env.DB.batch(
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO analyst_consensus (ticker, date, rating, target_mean, target_high,
                 target_low, target_median, analyst_count, strong_buy, buy, hold, sell, strong_sell,
                 source, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 rating=COALESCE(excluded.rating, analyst_consensus.rating),
                 target_mean=COALESCE(excluded.target_mean, analyst_consensus.target_mean),
                 target_high=COALESCE(excluded.target_high, analyst_consensus.target_high),
                 target_low=COALESCE(excluded.target_low, analyst_consensus.target_low),
                 target_median=COALESCE(excluded.target_median, analyst_consensus.target_median),
                 analyst_count=COALESCE(excluded.analyst_count, analyst_consensus.analyst_count),
                 strong_buy=COALESCE(excluded.strong_buy, analyst_consensus.strong_buy),
                 buy=COALESCE(excluded.buy, analyst_consensus.buy),
                 hold=COALESCE(excluded.hold, analyst_consensus.hold),
                 sell=COALESCE(excluded.sell, analyst_consensus.sell),
                 strong_sell=COALESCE(excluded.strong_sell, analyst_consensus.strong_sell),
                 source=excluded.source, updated_at=excluded.updated_at`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              typeof o.rating === 'string' ? o.rating : null,
              numOrNull(o.targetMean),
              numOrNull(o.targetHigh),
              numOrNull(o.targetLow),
              numOrNull(o.targetMedian),
              intOrNull(o.analystCount),
              intOrNull(o.strongBuy),
              intOrNull(o.buy),
              intOrNull(o.hold),
              intOrNull(o.sell),
              intOrNull(o.strongSell),
              nowIso,
            ),
          ),
        );
      }
      summary.analystRows += rows.length;
    }

    return c.json({ ok: summary.errors.length === 0, ...summary });
  });

  // --- POST /enrich-photos ------------------------------------------------
  // Resolve each filer's name -> bioguide (congress-legislators) and store the
  // public headshot URL. Safe to re-run; unmatched filers stay null (the UI
  // falls back to initials).
  r.post('/enrich-photos', async (c) => {
    try {
      return c.json(await runPhotoEnrichment(c.env));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /resolve-tickers ----------------------------------------------
  // Backfill: re-run ticker resolution over already-stored ticker-less rows and
  // preferred/depositary share rows that may have been collapsed to the common
  // issuer. No PDF re-extraction — just the deterministic resolver over the
  // stored asset name. Safe to re-run; bounded by ?limit (default 5000).
  r.post('/resolve-tickers', async (c) => {
    try {
      const limit = Number(c.req.query('limit')) || 5000;
      return c.json(await runTickerBackfill(c.env, limit));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- GET /subscriptions -------------------------------------------------
  r.get('/subscriptions', async (c) => {
    const activeOnly = c.req.query('active') === 'true';
    const subs = await listSubscriptions(c.env, activeOnly);
    return c.json({ subscriptions: subs.map(adminSubscription), count: subs.length });
  });

  return r;
}

function ratio(n: number, d: number): number | null {
  if (!d) return null;
  return Math.round((n / d) * 10_000) / 10_000;
}

interface MarketCoverage {
  trades: {
    total: number;
    tickered: number;
    companyName: number;
    sector: number;
    country: number;
    marketCap: number;
    companyNamePctOfTickered: number | null;
    sectorPctOfTickered: number | null;
    countryPctOfTickered: number | null;
    marketCapPctOfTickered: number | null;
  };
  assets: {
    total: number;
    companyName: number;
    sector: number;
    country: number;
    marketCap: number;
    companyNamePct: number | null;
    sectorPct: number | null;
    countryPct: number | null;
    marketCapPct: number | null;
  };
  missingSamples: Array<{
    ticker: string;
    name: string | null;
    trades: number;
    missing: string[];
    source: string | null;
    enrichedAt: string | null;
    enrichmentError: string | null;
  }>;
}

async function marketCoverage(env: Env): Promise<MarketCoverage> {
  const trade = await get<{
    total: number;
    tickered: number;
    company_name: number;
    sector: number;
    country: number;
    market_cap: number;
  }>(
    env.DB,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN 1 ELSE 0 END) AS tickered,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND sr.company_name IS NOT NULL AND sr.company_name <> '' THEN 1 ELSE 0 END) AS company_name,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND sr.sector IS NOT NULL AND sr.sector <> '' THEN 1 ELSE 0 END) AS sector,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND sr.country IS NOT NULL AND sr.country <> '' THEN 1 ELSE 0 END) AS country,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND (sr.market_cap IS NOT NULL OR (sr.market_cap_bucket IS NOT NULL AND sr.market_cap_bucket <> '')) THEN 1 ELSE 0 END) AS market_cap
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.deprecated_at IS NULL`,
  );
  const asset = await get<{
    total: number;
    company_name: number;
    sector: number;
    country: number;
    market_cap: number;
  }>(
    env.DB,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN company_name IS NOT NULL AND company_name <> '' THEN 1 ELSE 0 END) AS company_name,
            SUM(CASE WHEN sector IS NOT NULL AND sector <> '' THEN 1 ELSE 0 END) AS sector,
            SUM(CASE WHEN country IS NOT NULL AND country <> '' THEN 1 ELSE 0 END) AS country,
            SUM(CASE WHEN market_cap IS NOT NULL OR (market_cap_bucket IS NOT NULL AND market_cap_bucket <> '') THEN 1 ELSE 0 END) AS market_cap
       FROM (
         SELECT t.ticker,
                MAX(sr.company_name) AS company_name,
                MAX(sr.sector) AS sector,
                MAX(sr.country) AS country,
                MAX(sr.market_cap) AS market_cap,
                MAX(sr.market_cap_bucket) AS market_cap_bucket
           FROM transactions t
           LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
          WHERE t.deprecated_at IS NULL AND t.ticker IS NOT NULL AND t.ticker <> ''
          GROUP BY t.ticker
       )`,
  );
  const samples = await all<{
    ticker: string;
    name: string | null;
    trades: number;
    company_name: string | null;
    sector: string | null;
    country: string | null;
    market_cap: number | null;
    market_cap_bucket: string | null;
    source: string | null;
    enriched_at: string | null;
    enrichment_error: string | null;
  }>(
    env.DB,
    `SELECT t.ticker,
            COALESCE(MAX(sr.company_name), MAX(sm.name), MAX(t.asset_name)) AS name,
            COUNT(*) AS trades,
            MAX(sr.company_name) AS company_name,
            MAX(sr.sector) AS sector,
            MAX(sr.country) AS country,
            MAX(sr.market_cap) AS market_cap,
            MAX(sr.market_cap_bucket) AS market_cap_bucket,
            MAX(sr.source) AS source,
            MAX(sr.enriched_at) AS enriched_at,
            MAX(sr.enrichment_error) AS enrichment_error
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       LEFT JOIN securities_master sm ON sm.ticker = t.ticker
      WHERE t.deprecated_at IS NULL AND t.ticker IS NOT NULL AND t.ticker <> ''
      GROUP BY t.ticker
     HAVING company_name IS NULL OR company_name = ''
         OR sector IS NULL OR sector = ''
         OR country IS NULL OR country = ''
         OR (market_cap IS NULL AND (market_cap_bucket IS NULL OR market_cap_bucket = ''))
      ORDER BY trades DESC
      LIMIT 20`,
  );
  const tickered = trade?.tickered ?? 0;
  const totalAssets = asset?.total ?? 0;
  return {
    trades: {
      total: trade?.total ?? 0,
      tickered,
      companyName: trade?.company_name ?? 0,
      sector: trade?.sector ?? 0,
      country: trade?.country ?? 0,
      marketCap: trade?.market_cap ?? 0,
      companyNamePctOfTickered: ratio(trade?.company_name ?? 0, tickered),
      sectorPctOfTickered: ratio(trade?.sector ?? 0, tickered),
      countryPctOfTickered: ratio(trade?.country ?? 0, tickered),
      marketCapPctOfTickered: ratio(trade?.market_cap ?? 0, tickered),
    },
    assets: {
      total: totalAssets,
      companyName: asset?.company_name ?? 0,
      sector: asset?.sector ?? 0,
      country: asset?.country ?? 0,
      marketCap: asset?.market_cap ?? 0,
      companyNamePct: ratio(asset?.company_name ?? 0, totalAssets),
      sectorPct: ratio(asset?.sector ?? 0, totalAssets),
      countryPct: ratio(asset?.country ?? 0, totalAssets),
      marketCapPct: ratio(asset?.market_cap ?? 0, totalAssets),
    },
    missingSamples: samples.map((s) => {
      const missing: string[] = [];
      if (!s.company_name) missing.push('companyName');
      if (!s.sector) missing.push('sector');
      if (!s.country) missing.push('country');
      if (s.market_cap == null && !s.market_cap_bucket) missing.push('marketCap');
      return {
        ticker: s.ticker,
        name: s.name,
        trades: s.trades,
        missing,
        source: s.source,
        enrichedAt: s.enriched_at,
        enrichmentError: s.enrichment_error,
      };
    }),
  };
}

/**
 * Count tickers still needing work: `enrich` = traded tickers with no useful
 * securities_ref coverage; `prices` = traded (dated) tickers with no cached
 * price_eod. Drives the `done` flag for the backfill-market loop.
 */
async function marketPending(env: Env): Promise<{ enrich: number; prices: number }> {
  const retryIncomplete = hasConfiguredKeyedEnrichmentProvider(env);
  const e = await get<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM (
       SELECT t.ticker FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       WHERE t.ticker IS NOT NULL AND t.ticker <> ''
         AND ${enrichmentNeededSql('sr', retryIncomplete)}
       GROUP BY t.ticker)`,
  );
  const p = await get<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM (
       SELECT t.ticker FROM transactions t
       LEFT JOIN price_eod pe ON pe.ticker = t.ticker
       WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.tx_date IS NOT NULL
         AND pe.ticker IS NULL
       GROUP BY t.ticker)`,
  );
  return { enrich: e?.n ?? 0, prices: p?.n ?? 0 };
}

async function getLatencyResetAt(env: Env): Promise<string | null> {
  try {
    const raw = await env.CONFIG_KV.get(LATENCY_RESET_KEY);
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

async function setLatencyResetAt(env: Env, value: string): Promise<void> {
  await env.CONFIG_KV.put(LATENCY_RESET_KEY, value);
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
async function observedReleasedToSeenLag(env: Env, source: string, sinceIso: string | null): Promise<number | null> {
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
            AND (? IS NULL OR first_seen_at >= ?)
          ORDER BY first_seen_at DESC
          LIMIT 200
       )`,
    [source, sinceIso, sinceIso],
  );
  return row && row.avg_sec != null ? Math.round(row.avg_sec) : null;
}

/**
 * Average "Seen → Imported" lag (seconds): from when our watcher first saw a
 * filing (filings.first_seen_at) to when we wrote its parsed rows
 * (transactions.created_at), per chamber. Both are our own timestamps, so this
 * is PRECISE. Only live-pipeline rows (source='primary') are meaningful.
 */
async function observedSeenToImportedLag(env: Env, source: string, sinceIso: string | null): Promise<number | null> {
  const row = await get<{ avg_sec: number | null }>(
    env.DB,
    `SELECT AVG((julianday(t.created_at) - julianday(f.first_seen_at)) * 86400.0) AS avg_sec
       FROM transactions t
       JOIN filings f ON f.doc_id = t.doc_id
      WHERE f.chamber = ?
        AND t.source = 'primary'
        AND f.first_seen_at IS NOT NULL
        AND t.created_at IS NOT NULL
        AND julianday(t.created_at) >= julianday(f.first_seen_at)
        AND (? IS NULL OR f.first_seen_at >= ?)`,
    [source, sinceIso, sinceIso],
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

type ImportLimits = {
  bytes: number;
  refs: number;
  spx: number;
  prices: number;
  closesPerTicker: number;
  insider: number;
  shortVolume: number;
};

const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  bytes: 1_500_000,
  refs: 2_000,
  spx: 5_000,
  prices: 100,
  closesPerTicker: 1_500,
  insider: 5_000,
  shortVolume: 5_000,
};

const MAX_IMPORT_LIMITS: ImportLimits = {
  bytes: 3_000_000,
  refs: 5_000,
  spx: 10_000,
  prices: 250,
  closesPerTicker: 3_000,
  insider: 10_000,
  shortVolume: 10_000,
};

function positiveIntSetting(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function importLimits(env: Env): ImportLimits {
  return {
    bytes: positiveIntSetting(env.IMPORT_MAX_BYTES, DEFAULT_IMPORT_LIMITS.bytes, MAX_IMPORT_LIMITS.bytes),
    refs: positiveIntSetting(env.IMPORT_MAX_REFS, DEFAULT_IMPORT_LIMITS.refs, MAX_IMPORT_LIMITS.refs),
    spx: positiveIntSetting(env.IMPORT_MAX_SPX, DEFAULT_IMPORT_LIMITS.spx, MAX_IMPORT_LIMITS.spx),
    prices: positiveIntSetting(env.IMPORT_MAX_PRICES, DEFAULT_IMPORT_LIMITS.prices, MAX_IMPORT_LIMITS.prices),
    closesPerTicker: positiveIntSetting(
      env.IMPORT_MAX_CLOSES_PER_TICKER,
      DEFAULT_IMPORT_LIMITS.closesPerTicker,
      MAX_IMPORT_LIMITS.closesPerTicker,
    ),
    insider: positiveIntSetting(env.IMPORT_MAX_INSIDER, DEFAULT_IMPORT_LIMITS.insider, MAX_IMPORT_LIMITS.insider),
    shortVolume: positiveIntSetting(
      env.IMPORT_MAX_SHORT_VOLUME,
      DEFAULT_IMPORT_LIMITS.shortVolume,
      MAX_IMPORT_LIMITS.shortVolume,
    ),
  };
}

function importLimitResponse(limits: ImportLimits): Omit<ImportLimits, 'bytes'> {
  return {
    refs: limits.refs,
    spx: limits.spx,
    prices: limits.prices,
    closesPerTicker: limits.closesPerTicker,
    insider: limits.insider,
    shortVolume: limits.shortVolume,
  };
}

function countArray(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/** Coerce an unknown to a finite number or null (for defensive ingest). */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Coerce an unknown to a rounded integer or null. */
function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}
