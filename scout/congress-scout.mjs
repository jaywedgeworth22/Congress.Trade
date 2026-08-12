#!/usr/bin/env node
/**
 * scout/congress-scout.mjs — congressional-disclosure DETECTION-LATENCY scout.
 *
 * WHY THIS RUNS OUTSIDE CLOUDFLARE:
 *   Senate eFD (efdsearch.senate.gov) is behind Imperva, which blocks datacenter
 *   / cloud egress IPs (Cloudflare Workers, generic VPS). This must run on a
 *   RESIDENTIAL connection (your Mac / a Pi). No inbound ports needed — it only
 *   makes outbound requests and (optionally) POSTs detections to the app.
 *
 * WHAT IT DOES each cycle (default every 45s):
 *   - Detects new PTR filings straight from the primary gov sources, the instant
 *     they appear — House Clerk (intraday live search + PDF-URL frontier probe)
 *     and Senate eFD (the 3-step CSRF/agreement/DataTables flow) — and stamps
 *     `our_detected_at`. This is DETECTION ONLY (existence + link), not parsing.
 *   - Optionally polls FMP family (stable + RapidAPI paths), QQ, and UW.
 *     FMP sources default to OFF (no spend) until FMP_PROBE_ENABLED=1.
 *   - Joins FMP by the filing's doc key and logs the lead. (QQ and UW are saved to state for offline analysis).
 *
 * RUN:
 *   # Detection only (FMP OFF — default):
 *   node scout/congress-scout.mjs --once
 *   # Enable FMP race (stable + RapidAPI paths can race):
 *   FMP_PROBE_ENABLED=1 FMP_API_KEY=xxx node scout/congress-scout.mjs
 *
 * ENV:
 *   FMP_API_KEY / FMP_LATENCY_API_KEY   FMP key (query auth for stable path only)
 *   FMP_RAPIDAPI_KEY / RAPIDAPI_KEY     RapidAPI marketplace key (ST shared RAPIDAPI_KEY ok)
 *   FMP_PROBE_ENABLED                  "1"/"true" to poll FMP family (default ON when unset)
 *   FMP_PATHS                          default "stable" (RapidAPI congress paths 404 on product)
 *   FMP_STABLE_BASE_URL                override stable base
 *   FMP_RAPIDAPI_BASE_URL / FMP_RAPIDAPI_HOST  override RapidAPI path (opt-in only)
 *   QQ_API_KEY            Quiver Quant key
 *   UW_API_KEY            Unusual Whales key
 *   POLL_INTERVAL_SEC     default 45
 *   SOURCES               "house,senate" (default), or a subset
 *   HOUSE_FRONTIER        "1" (default) probe PDF frontier; "0" to disable
 *   HOUSE_PROBE_WINDOW    default 25   (docIds probed ahead of the known max)
 *   STATE_FILE            default ./scout-state.json
 *   LEADS_FILE            default ./scout-leads.jsonl
 *   CT_INGEST_URL         optional: POST each detection here
 *   CT_INGEST_TOKEN       bearer token for CT_INGEST_URL
 *   CT_BASE_URL           base for scout-plan / latency-payload / raw (default derived from CT_INGEST_URL)
 *   SCOUT_LATENCY_ALWAYS  "1" = always ASK to cover every provider. It does not
 *                         bypass the lease: the server still refuses any lane it
 *                         owns, so this can no longer cause double-polling.
 *   SCOUT_HOLDER_ID       lease identity (default "mac-<hostname>"); keep stable
 *   SCOUT_RAW_UPLOAD      "1" (default) download + POST raw bytes to R2 when possible
 *   SCOUT_RAW_MAX_BYTES   default 20_000_000
 *
 * PROVIDER CALLS ARE LEASED:
 *   Every FMP/QQ/UW call requires a lease from POST /api/ingest/probe-lease.
 *   The server grants at most one holder per provider, charges the grant to the
 *   shared daily budget, and takes the lane back when it recovers or when this
 *   scout's tenure window expires. If the server is unreachable, this scout
 *   does NOT poll — it cannot tell whether the server is already polling, and a
 *   duplicate call is wasted spend.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// --- config -----------------------------------------------------------------
const ARGV = new Set(process.argv.slice(2));
const ONCE = ARGV.has('--once');
// Dual free-tier keys for stable host (owner: no known per-IP limit → ~2× capacity).
// Prefer dedicated latency names; FMP_API_KEY fills slot 2 when distinct from slot 1.
const _fmpKey1 = (process.env.FMP_LATENCY_API_KEY || '').trim();
const _fmpKey2Raw = (process.env.FMP_LATENCY_API_KEY_2 || process.env.FMP_API_KEY || '').trim();
const _fmpKey2 = _fmpKey2Raw && _fmpKey2Raw !== _fmpKey1 ? _fmpKey2Raw : '';
// Back-compat single key when only FMP_API_KEY is set (maps into slot 1).
const FMP_FREE_KEYS = [_fmpKey1, _fmpKey2].filter(Boolean);
if (!FMP_FREE_KEYS.length && (process.env.FMP_API_KEY || '').trim()) {
  FMP_FREE_KEYS.push((process.env.FMP_API_KEY || '').trim());
}
const FMP_KEY = FMP_FREE_KEYS[0] || ''; // used only for status/logging "has any free key"
// Marketplace key only — do not fall back to free-tier FMP keys (invalid on RapidAPI hosts).
// Shared RAPIDAPI_KEY is the Socratic.Trade convention for one marketplace credential.
const FMP_RAPIDAPI_KEY = process.env.FMP_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY || '';
// Default ON for CT when unset (FMP is a first-class CT latency path). Explicit false/0/off disables.
const _fmpProbeRaw = (process.env.FMP_PROBE_ENABLED || '').trim();
const FMP_PROBE_ENABLED = _fmpProbeRaw === '' ? true : !/^(0|false|no|off)$/i.test(_fmpProbeRaw);
// Default stable only: RapidAPI FMP product auth works but house/senate-latest
// return 404 (product gap verified 2026-08-06). Opt in with FMP_PATHS=stable,rapidapi.
const FMP_PATHS_RAW = (process.env.FMP_PATHS || 'stable').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const FMP_PATHS = new Set(FMP_PATHS_RAW.length ? FMP_PATHS_RAW : ['stable']);
const QQ_KEY =
  process.env.QQ_API_KEY ||
  process.env.QUIVER_API_KEY ||
  process.env.QUIVER_API_TOKEN ||
  process.env.QUIVERQUANT_API_TOKEN ||
  '';
// Single UW key (trial/paid). Canonical + global-api-keys alias.
const UW_KEY =
  process.env.UW_API_KEY ||
  process.env.UNUSUAL_WHALES_API_KEY ||
  process.env.UNUSUALWHALES_API_KEY ||
  '';
const INTERVAL_MS = (Number(process.env.POLL_INTERVAL_SEC) || 45) * 1000;
const SOURCES = new Set((process.env.SOURCES || 'house,senate').split(',').map((s) => s.trim()));
const FRONTIER = (process.env.HOUSE_FRONTIER ?? '1') !== '0';
const PROBE_WINDOW = Number(process.env.HOUSE_PROBE_WINDOW) || 25;
const PROBE_SPACING_MS = 300;
const STATE_FILE = process.env.STATE_FILE || './scout-state.json';
const LEADS_FILE = process.env.LEADS_FILE || './scout-leads.jsonl';
const CT_INGEST_URL = process.env.CT_INGEST_URL || '';
const CT_INGEST_TOKEN = process.env.CT_INGEST_TOKEN || '';
// Derive API base (https://congress.trade) from CT_INGEST_URL when possible.
const CT_BASE_URL = (process.env.CT_BASE_URL || (() => {
  if (!CT_INGEST_URL) return '';
  try {
    const u = new URL(CT_INGEST_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
})()).replace(/\/+$/, '');
const SCOUT_LATENCY_ALWAYS = /^(1|true|yes|on)$/i.test((process.env.SCOUT_LATENCY_ALWAYS || '').trim());
const SCOUT_RAW_UPLOAD = !/^(0|false|no|off)$/i.test((process.env.SCOUT_RAW_UPLOAD ?? '1').trim());
const SCOUT_RAW_MAX_BYTES = Number(process.env.SCOUT_RAW_MAX_BYTES) || 20_000_000;
/** Min seconds between scout→server latency payload posts per provider (free-tier thrift). */
const SCOUT_LATENCY_MIN_INTERVAL_SEC = Number(process.env.SCOUT_LATENCY_MIN_INTERVAL_SEC) || 15 * 60;
/** Back off after FMP 402/429 before retrying (seconds). */
const SCOUT_FMP_QUOTA_BACKOFF_SEC = Number(process.env.SCOUT_FMP_QUOTA_BACKOFF_SEC) || 45 * 60;
/**
 * Lease holder identity. Stable across restarts on purpose: the server bounds
 * how long this scout may hold a lane (tenure), and a fresh id on every restart
 * would reset that clock and let a crash-looping scout keep the lane forever.
 */
const SCOUT_HOLDER_ID = (process.env.SCOUT_HOLDER_ID || `mac-${hostname()}`).trim().slice(0, 120);
const authHeaders = () =>
  CT_INGEST_TOKEN
    ? { authorization: `Bearer ${CT_INGEST_TOKEN}`, 'content-type': 'application/json' }
    : { 'content-type': 'application/json' };

/**
 * FMP latency source registry (CT latency + Mac scout only; not Socratic).
 * Default operational = ON when keys present; grey OFF only if FMP_PROBE_ENABLED=false.
 * Stable path rotates dual free-tier keys (one key per cycle).
 */
const FMP_SOURCE_REGISTRY = [
  {
    id: 'fmp',
    pathId: 'stable',
    label: 'FMP Stable',
    baseUrl: (process.env.FMP_STABLE_BASE_URL || 'https://financialmodelingprep.com/stable').replace(/\/+$/, ''),
    auth: 'query',
  },
  {
    id: 'fmp_rapidapi',
    pathId: 'rapidapi',
    label: 'FMP RapidAPI',
    baseUrl: (process.env.FMP_RAPIDAPI_BASE_URL || 'https://financial-modeling-prep.p.rapidapi.com/stable').replace(/\/+$/, ''),
    host: process.env.FMP_RAPIDAPI_HOST || 'financial-modeling-prep.p.rapidapi.com',
    auth: 'rapidapi',
  },
];

/** Round-robin free-tier key index (persisted in scout state via nextFmpFreeKey). */
let fmpFreeKeyCursor = 0;
/**
 * When preferSecondary=true (server handoff), try key slot 2 first so the Mac
 * does not burn the same free-tier key the Oracle server is using as primary.
 */
function nextFmpFreeKey(preferSecondary = false) {
  if (!FMP_FREE_KEYS.length) return '';
  if (preferSecondary && FMP_FREE_KEYS.length > 1) {
    // Start secondary rotation at index 1 on first handoff pick.
    if (fmpFreeKeyCursor === 0) fmpFreeKeyCursor = 1;
  }
  const key = FMP_FREE_KEYS[fmpFreeKeyCursor % FMP_FREE_KEYS.length];
  fmpFreeKeyCursor = (fmpFreeKeyCursor + 1) % FMP_FREE_KEYS.length;
  return key;
}

function fmpSourceStatus(src) {
  if (!FMP_PROBE_ENABLED) return 'off';
  if (!FMP_PATHS.has(src.pathId) && !FMP_PATHS.has(src.id)) return 'off';
  const key = src.auth === 'rapidapi' ? FMP_RAPIDAPI_KEY : FMP_KEY;
  if (!key) return 'stopped';
  return 'running';
}

function logFmpRegistry() {
  for (const src of FMP_SOURCE_REGISTRY) {
    const st = fmpSourceStatus(src);
    const extra = src.auth === 'query' && st === 'running'
      ? ` freeKeys=${FMP_FREE_KEYS.length}`
      : '';
    log(`fmp-source ${src.id.padEnd(14)} path=${src.pathId.padEnd(8)} status=${st} base=${src.baseUrl}${extra}`);
  }
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SENATE = 'https://efdsearch.senate.gov';
const HOUSE_FD = 'https://disclosures-clerk.house.gov/FinancialDisclosure';
const HOUSE_PDF = 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _originalFetch = fetch;
const fetchWithRetry = async (url, options = {}, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await _originalFetch(url, options);
      if (res.status === 503 || res.status === 403 || res.status === 429) {
        if (i < retries - 1) {
          await sleep(2000 * (i + 1));
          continue;
        }
      }
      return res;
    } catch (err) {
      if (err.message && err.message.includes('fetch failed')) {
        if (i < retries - 1) {
          await sleep(5000 * (i + 1));
          continue;
        }
      }
      throw err;
    }
  }
};
globalThis.fetch = fetchWithRetry;

const nowIso = () => new Date().toISOString();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const warn = (tag, e) => console.warn(new Date().toISOString().slice(11, 19), `! ${tag}:`, e?.message || e);

// --- tiny cookie jar (name=value; carried across the eFD redirect + POSTs) ---
function absorb(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const kv = String(c).split(';', 1)[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();

function keyFromLink(link) {
  let m = /\/ptr-pdfs\/(\d{4})\/(\d+)\.pdf/i.exec(link || '');
  if (m) return `H-${m[1]}-${m[2]}`;
  m = /\/search\/view\/ptr\/([^/?#]+)/i.exec(link || '');
  if (m) return `S-${m[1]}`;
  return null;
}

// --- upstream backoff + circuit breaker -------------------------------------
// 2026-08-10/11 outage post-mortem. eFD's /search/report/data/ started serving
// a static Akamai "WEBSITE TEMPORARILY UNAVAILABLE DUE TO MAINTENANCE" 503
// while every other eFD path kept answering normally from gunicorn. The scout
// had no backoff and no escalation, so it reran the identical failing
// handshake every cycle for 32 hours — 1,385 consecutive failures, each one a
// console.warn in a file nobody reads.
//
// Two independent defects, both fixed here:
//   1. Hammering. Re-issuing a request an upstream is already refusing, once a
//      minute forever, is how a temporary upstream outage turns into a
//      permanent ban of this Mac's residential IP — the one asset that makes
//      Senate polling possible at all.
//   2. Silence. 1,385 identical failures produced no escalation of any kind.
//      There must be a point at which a source stops retrying, says so out
//      loud, and waits.
const BREAKER_BASE_MS = Number(process.env.SOURCE_BREAKER_BASE_MS) || 60_000;
const BREAKER_MAX_MS = Number(process.env.SOURCE_BREAKER_MAX_MS) || 30 * 60_000;
const BREAKER_ALERT_AFTER = Number(process.env.SOURCE_BREAKER_ALERT_AFTER) || 5;
const BREAKER_RENOTIFY_MS = Number(process.env.SOURCE_BREAKER_RENOTIFY_MS) || 6 * 3_600_000;
const BREAKER_FILE = process.env.BREAKER_FILE
  || STATE_FILE.replace(/(\.json)?$/i, '') + '-breakers.json';

const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN || process.env.PUSHOVER_CT_API_TOKEN || '';
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY || '';

/**
 * Owner-visible escalation. Never throws and never logs the token: an alert
 * channel that can take the scout down, or that leaks a credential into a log
 * file, is worse than no alert channel.
 */
async function alertOwner({ title, message, priority = 1 }) {
  if (!PUSHOVER_APP_TOKEN || !PUSHOVER_USER_KEY) return { sent: false, reason: 'pushover unconfigured' };
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: PUSHOVER_APP_TOKEN, user: PUSHOVER_USER_KEY, title, message, priority: String(priority),
      }).toString(),
    });
    return res.ok ? { sent: true } : { sent: false, reason: `pushover HTTP ${res.status}` };
  } catch (e) {
    return { sent: false, reason: e?.message || String(e) };
  }
}

const breakers = (() => {
  try {
    return existsSync(BREAKER_FILE) ? JSON.parse(readFileSync(BREAKER_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
})();
// Breaker state is persisted because pm2 restarts it 3+ times on a bad day. An
// in-memory-only breaker resets to "closed" on every restart, which would let a
// restart loop reproduce exactly the hammering this exists to prevent.
const saveBreakers = () => {
  try { writeFileSync(BREAKER_FILE, JSON.stringify(breakers, null, 2)); } catch {}
};
const breaker = (name) => (breakers[name] ??= {
  fails: 0, openUntil: 0, firstFailAt: 0, notifiedAt: 0, lastReason: '', lastSkipLogAt: 0,
});

function breakerDelayMs(fails) {
  const raw = Math.min(BREAKER_BASE_MS * 2 ** (fails - 1), BREAKER_MAX_MS);
  // +/-25% jitter: without it every restart, and every peer that shares this
  // upstream, re-synchronises its retries onto the same second.
  return Math.round(raw * (0.75 + Math.random() * 0.5));
}

/** True when the breaker is open — callers must skip the request entirely. */
function breakerOpen(name, now = Date.now()) {
  const b = breaker(name);
  if (b.openUntil <= now) return false;
  // Rate-limit the skip line itself; a chatty skip is just a cheaper flood.
  if (now - (b.lastSkipLogAt || 0) >= 10 * 60_000) {
    b.lastSkipLogAt = now;
    saveBreakers();
    log(`~ ${name}: breaker OPEN (${b.fails} consecutive failures, ${b.lastReason}) — `
      + `next attempt in ${Math.round((b.openUntil - now) / 1000)}s`);
  }
  return true;
}

async function recordFailure(name, reason, now = Date.now()) {
  const b = breaker(name);
  b.fails += 1;
  b.lastReason = reason;
  if (!b.firstFailAt) b.firstFailAt = now;
  b.openUntil = now + breakerDelayMs(b.fails);
  const downMin = Math.round((now - b.firstFailAt) / 60_000);
  const renotifyDue = now - (b.notifiedAt || 0) >= BREAKER_RENOTIFY_MS;
  if (b.fails >= BREAKER_ALERT_AFTER && (!b.notifiedAt || renotifyDue)) {
    const res = await alertOwner({
      title: `CT scout DOWN: ${name}`,
      message: `${name} has failed ${b.fails} consecutive polls over ${downMin}m.\nLast: ${reason}\n`
        + `Backing off; next attempt in ${Math.round((b.openUntil - now) / 60_000)}m.`,
      priority: 1,
    });
    // Record the notification only on confirmed delivery, so an undelivered
    // alarm retries next cycle instead of silently counting as "notified".
    if (res.sent) b.notifiedAt = now;
    else warn(name, `escalation NOT delivered (${res.reason})`);
  }
  saveBreakers();
}

async function recordSuccess(name, now = Date.now()) {
  const b = breaker(name);
  if (!b.fails) return;
  const downMin = Math.round((now - (b.firstFailAt || now)) / 60_000);
  log(`+ ${name}: recovered after ${b.fails} consecutive failures (${downMin}m down)`);
  if (b.notifiedAt) {
    await alertOwner({
      title: `CT scout recovered: ${name}`,
      message: `${name} is polling again after ${b.fails} failures over ${downMin}m.`,
      priority: 0,
    });
  }
  breakers[name] = { fails: 0, openUntil: 0, firstFailAt: 0, notifiedAt: 0, lastReason: '', lastSkipLogAt: 0 };
  saveBreakers();
}

// --- Senate eFD (3-step CSRF/agreement/DataTables; residential IP required) --
function fmtSenate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Distinguishes failure classes that look identical at the status line but
 * have opposite responses. The 2026-08-11 outage was `upstream-maintenance`:
 * a site-wide Akamai intercept on one path, confirmed by the maintenance page
 * being served from `AkamaiNetStorage` while /search/home/ still answered 200
 * from gunicorn on the same connection. Retrying harder could not have fixed
 * it, and would only have risked the IP.
 */
const MAINTENANCE_RE = /site under maintenance|temporarily unavailable due to maintenance/i;
function classifyUpstream(status, body) {
  if (status === 503 && MAINTENANCE_RE.test(body || '')) {
    return 'upstream-maintenance (static maintenance page — upstream outage, not our IP)';
  }
  if (status === 403 || status === 401) return 'blocked (IP or session rejected)';
  if (status === 429) return 'throttled (back off harder)';
  if (status >= 500) return 'upstream-error';
  return `http-${status}`;
}

/**
 * Breaker-guarded entry point. The unguarded handshake lives in
 * detectSenateOnce; everything that decides *whether* to run it lives here.
 */
async function detectSenate() {
  if (breakerOpen('senate')) return [];
  try {
    const out = await detectSenateOnce();
    await recordSuccess('senate');
    return out;
  } catch (e) {
    await recordFailure('senate', e?.message || String(e));
    throw e;
  }
}

async function detectSenateOnce() {
  const jar = new Map();
  const H = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' };
  let res = await fetch(`${SENATE}/search/`, { headers: H, redirect: 'manual' });
  absorb(jar, res);
  for (let hop = 0; hop < 4 && [301, 302, 303, 307, 308].includes(res.status); hop++) {
    const loc = res.headers.get('location');
    if (!loc) break;
    res = await fetch(new URL(loc, `${SENATE}/search/`).href, { headers: { ...H, cookie: cookieHeader(jar) }, redirect: 'manual' });
    absorb(jar, res);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 2000);
    throw new Error(`GET /search/ HTTP ${res.status} — ${classifyUpstream(res.status, snippet)}`);
  }
  const html = await res.text();
  // The hidden input's name/value attribute order isn't guaranteed by eFD's
  // template, so try both orders (mirrors app/src/ingestion/senateSource.ts
  // parseCsrfMiddlewareToken).
  const token = (
    /name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/i.exec(html) ||
    /value=["']([^"']+)["']\s+name=["']csrfmiddlewaretoken["']/i.exec(html) ||
    []
  )[1];
  if (!token) throw new Error('csrfmiddlewaretoken not found (blocked?)');
  await fetch(`${SENATE}/search/home/`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar), referer: `${SENATE}/search/`, origin: SENATE },
    body: `prohibition_agreement=1&csrfmiddlewaretoken=${encodeURIComponent(token)}`,
    redirect: 'manual',
  }).then((r) => absorb(jar, r));
  const now = new Date();
  const since = new Date(now.getTime() - 45 * 864e5);
  const body = new URLSearchParams({
    // eFD inserted an "office" display column ahead of the PTR link, shifting
    // the submitted-date column from index 4 to 5 (see the 6-column fixture in
    // app/src/ingestion/__tests__/senateSource.test.ts). Sorting by the old
    // index-4 no longer orders by date, which can omit the newest filings once
    // a 45-day window has more than `length` rows.
    draw: '1', start: '0', length: '100', 'search[value]': '', 'search[regex]': 'false',
    'order[0][column]': '5', 'order[0][dir]': 'desc', report_types: '[11]', filer_types: '[]',
    submitted_start_date: fmtSenate(since), submitted_end_date: fmtSenate(now), first_name: '', last_name: '',
  });
  const data = await fetch(`${SENATE}/search/report/data/`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', cookie: cookieHeader(jar), referer: `${SENATE}/search/`, origin: SENATE, 'x-csrftoken': jar.get('csrftoken') || token, 'x-requested-with': 'XMLHttpRequest', accept: 'application/json,text/javascript,*/*; q=0.01' },
    body: body.toString(),
  });
  if (!data.ok) {
    // Read a bounded slice of the body before throwing. The old code threw on
    // the status alone, which is why 1,385 log lines said "HTTP 503" and none
    // said "the Senate is in a maintenance window" — the answer was in the
    // response body the whole time.
    const snippet = (await data.text().catch(() => '')).slice(0, 2000);
    throw new Error(`report/data/ HTTP ${data.status} — ${classifyUpstream(data.status, snippet)}`);
  }
  const json = await data.json();
  const rows = Array.isArray(json.data) ? json.data : [];
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    // eFD's DataTables column order shifts (it recently inserted an "office"
    // display column, moving the anchor from index 2 to 3), so find each cell
    // by content rather than trusting a fixed index.
    const cells = (Array.isArray(r) ? r : []).map((c) => (typeof c === 'string' ? c : ''));
    const anchorCell = cells.find((c) => /\/search\/view\/ptr\//i.test(c));
    const href = anchorCell ? (/href=["']([^"']+)["']/i.exec(anchorCell) || [])[1] : null;
    const key = keyFromLink(href || '');
    if (!key) continue;
    const nameCell = cells.find((c) => /\(Senator\)/i.test(c) && !/</.test(c));
    const filedDate = (cells.find((c) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(c.trim())) ?? '').trim();
    out.push({
      source: 'senate',
      key,
      link: href.startsWith('http') ? href : `${SENATE}${href}`,
      name: stripTags(nameCell) || `${r[0]} ${r[1]}`.trim(),
      filedDate: filedDate || undefined,
    });
  }
  return out;
}

// --- House Clerk (intraday live search + PDF-URL frontier probe) -------------
async function detectHouseLiveSearch() {
  const jar = new Map();
  const land = await fetch(`${HOUSE_FD}/ViewSearch`, { headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
  if (land.ok) absorb(jar, land);
  const body = new URLSearchParams({ LastName: '', FilingYear: String(new Date().getUTCFullYear()), State: '', District: '' });
  const res = await fetch(`${HOUSE_FD}/ViewMemberSearchResult`, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,*/*', referer: `${HOUSE_FD}/ViewSearch`, origin: 'https://disclosures-clerk.house.gov', 'x-requested-with': 'XMLHttpRequest', ...(cookieHeader(jar) ? { cookie: cookieHeader(jar) } : {}) },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`live search HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const seen = new Set();
  const re = /href=["']([^"']*\/ptr-pdfs\/(\d{4})\/(\d+)\.pdf)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    // Rebuild the absolute URL from the captured year/docId via the known-good
    // HOUSE_PDF base instead of the raw matched href: the live-search markup
    // sometimes omits the leading slash (e.g. href="public_disc/ptr-pdfs/...")
    // which naive prefixing turns into an unusable
    // ".../house.govpublic_disc/..." URL.
    out.push({ source: 'house', key: `H-${m[2]}-${m[3]}`, link: `${HOUSE_PDF}/${m[2]}/${m[3]}.pdf` });
  }
  return out;
}
async function detectHouseFrontier(state) {
  if (!state.houseMaxDocId) return []; // need a baseline from the live search first
  const year = new Date().getUTCFullYear();
  const out = [];
  for (let i = 1; i <= PROBE_WINDOW; i++) {
    const id = state.houseMaxDocId + i;
    const url = `${HOUSE_PDF}/${year}/${id}.pdf`;
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA } });
      if (r.ok) out.push({ source: 'house', key: `H-${year}-${id}`, link: url });
    } catch { /* ignore a single probe failure */ }
    await sleep(PROBE_SPACING_MS); // gentle: the Clerk throttles bursts
  }
  return out;
}

// --- FMP family (stable default; RapidAPI opt-in; dual free keys rotate) ---
/**
 * @returns {{ keys: Array<{key,pathId,sourceId}>, chamberJson: {house?:unknown,senate?:unknown} }}
 */
async function pollFmpPath(src, freeKey) {
  const out = [];
  const chamberJson = {};
  const key = src.auth === 'rapidapi' ? FMP_RAPIDAPI_KEY : freeKey;
  if (!key) return { keys: out, chamberJson };
  // house + senate only (executive-latest often 404 and wastes free-tier quota)
  for (const ch of ['house', 'senate']) {
    let url = `${src.baseUrl}/${ch}-latest?page=0&limit=100`;
    const headers = { accept: 'application/json' };
    if (src.auth === 'rapidapi') {
      // Socratic.Trade RapidAPI transport: header auth (never query apikey).
      headers['x-rapidapi-key'] = key;
      if (src.host) headers['x-rapidapi-host'] = src.host;
    } else {
      url += `&apikey=${encodeURIComponent(key)}`;
    }
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`${src.id}/${ch}-latest HTTP ${r.status}`);
    const json = await r.json();
    chamberJson[ch] = json;
    const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const k = keyFromLink(row?.link || row?.url || '');
      if (k) out.push({ key: k, pathId: src.pathId, sourceId: src.id });
    }
  }
  return { keys: out, chamberJson };
}

/**
 * Poll enabled FMP paths. Stable uses one free-tier key per cycle (rotates dual
 * keys). On 402/429 for stable, try the other free key once (owner: no known
 * per-IP limit — second account still has quota when first is bandwidth-capped).
 * RapidAPI off by default (404 product gap).
 */
/**
 * @param {{ preferSecondaryKey?: boolean }} [opts]
 * @returns {{ keys: Array, payloads: Array<{provider,fmpPathId,chamberJson}> }}
 */
async function pollFmpFamily(opts = {}) {
  const preferSecondaryKey = !!opts.preferSecondaryKey;
  const out = [];
  const payloads = [];
  for (const src of FMP_SOURCE_REGISTRY) {
    if (fmpSourceStatus(src) !== 'running') continue;
    if (src.auth === 'rapidapi') {
      try {
        const res = await pollFmpPath(src, '');
        out.push(...res.keys);
        if (Object.keys(res.chamberJson).length) {
          payloads.push({ provider: 'fmp_rapidapi', fmpPathId: 'rapidapi', chamberJson: res.chamberJson });
        }
      } catch (e) {
        warn(`fmp:${src.id}`, e);
      }
      continue;
    }
    // Stable: rotate key; on quota errors try remaining free keys.
    // Handoff: prefer secondary free key first (server usually owns slot 1).
    const tried = new Set();
    let lastErr = null;
    for (let attempt = 0; attempt < Math.max(1, FMP_FREE_KEYS.length); attempt++) {
      const freeKey = nextFmpFreeKey(preferSecondaryKey);
      if (!freeKey || tried.has(freeKey)) continue;
      tried.add(freeKey);
      try {
        const res = await pollFmpPath(src, freeKey);
        out.push(...res.keys);
        if (Object.keys(res.chamberJson).length) {
          payloads.push({ provider: 'fmp', fmpPathId: 'stable', chamberJson: res.chamberJson });
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        if (/HTTP (402|429)/.test(msg) && tried.size < FMP_FREE_KEYS.length) {
          warn(`fmp:${src.id}`, `${msg} — trying next free key`);
          continue;
        }
        break;
      }
    }
    if (lastErr) {
      warn(`fmp:${src.id}`, lastErr);
      // Surface quota errors so the cycle can back off instead of retrying every 45s.
      const msg = String(lastErr?.message || lastErr);
      if (/HTTP (402|429)/.test(msg) && !out.length) throw lastErr;
    }
  }
  return { keys: out, payloads };
}

// --- QQ ---------------------------------------------------------------------
async function pollQQ() {
  const out = [];
  // Live house+senate endpoints match server tradeLatency fetchQuiverRows.
  const headers = { Authorization: `Token ${QQ_KEY}`, Accept: 'application/json' };
  const chamberJson = {};
  for (const [ch, path] of [
    ['house', 'https://api.quiverquant.com/beta/live/housetrading?options=true'],
    ['senate', 'https://api.quiverquant.com/beta/live/senatetrading?options=true'],
  ]) {
    try {
      const r = await fetch(path, { headers });
      if (!r.ok) throw new Error(`QQ ${ch} HTTP ${r.status}`);
      const json = await r.json();
      chamberJson[ch] = json;
      const rows = Array.isArray(json) ? json : [];
      for (const t of rows) {
        const key = `${t.Name || t.Representative || ''}_${t.Filed || t.ReportDate || ''}_${t.Ticker || ''}_${t.TransactionDate || ''}`.replace(/[^a-zA-Z0-9_]/g, '');
        out.push({ key });
      }
    } catch (e) {
      warn(`qq:${ch}`, e);
    }
  }
  return { keys: out, chamberJson };
}

// --- UW ---------------------------------------------------------------------
async function pollUW() {
  const out = [];
  const url = `https://api.unusualwhales.com/api/congress/recent-trades?limit=200`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${UW_KEY}`, 'UW-CLIENT-API-ID': '100001' } });
  if (!r.ok) throw new Error(`UW HTTP ${r.status}`);
  const json = await r.json();
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  for (const t of rows) {
    const key = `${t.name || t.politician || t.representative || ''}_${t.filed_at_date || t.filed_date || t.disclosure_date || ''}_${t.ticker || ''}_${t.transaction_date || ''}`.replace(/[^a-zA-Z0-9_]/g, '');
    out.push({ key });
  }
  // Server parser expects the full feed under any chamber key; use house.
  return { keys: out, chamberJson: { house: json } };
}

// --- server handoff (plan + latency payload + raw R2 upload) -----------------
async function fetchScoutPlan() {
  if (!CT_BASE_URL || !CT_INGEST_TOKEN) return null;
  try {
    const res = await fetch(`${CT_BASE_URL}/api/ingest/scout-plan`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      warn('scout-plan', new Error(`HTTP ${res.status}`));
      return null;
    }
    return await res.json();
  } catch (e) {
    warn('scout-plan', e);
    return null;
  }
}

/**
 * Ask the server for permission to poll `provider` this cycle.
 *
 * The server is the single arbiter: it holds the lease table in D1 and grants
 * at most one holder per provider. A grant also charges the shared daily call
 * ledger, so one grant authorizes exactly one poll — which is why this is
 * called per cycle rather than once per handoff.
 *
 * FAILS CLOSED. If the server is unreachable we cannot know whether it is
 * already polling this source, and the whole point of the lease is that a
 * duplicate call is wasted money. Same reasoning as the existing rule against
 * inventing needScout when the plan is unavailable.
 */
async function acquireProbeLease(provider, { ttlSec, fmpSlot } = {}) {
  if (!CT_BASE_URL || !CT_INGEST_TOKEN) {
    return { granted: false, denial: 'no_server', detail: 'CT_BASE_URL/CT_INGEST_TOKEN unset' };
  }
  try {
    const res = await fetch(`${CT_BASE_URL}/api/ingest/probe-lease`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        action: 'acquire',
        provider,
        holderId: SCOUT_HOLDER_ID,
        ...(ttlSec ? { ttlSec } : {}),
        ...(fmpSlot ? { fmpSlot } : {}),
      }),
    });
    if (!res.ok) {
      warn('probe-lease', new Error(`${provider} HTTP ${res.status}`));
      return { granted: false, denial: `http_${res.status}` };
    }
    const body = await res.json();
    if (body?.granted) {
      log('LEASE', provider, 'granted until', body.lease?.expiresAt || '?', `charged=${body.charged ?? 0}`);
    } else if (body?.denial && body.denial !== 'not_eligible') {
      // not_eligible is the steady state (server owns the lane); logging it
      // every 45s would drown the log. Everything else is worth seeing.
      log('LEASE', provider, 'denied', body.denial, body.detail || '');
    }
    return body || { granted: false, denial: 'empty_response' };
  } catch (e) {
    warn('probe-lease', e);
    return { granted: false, denial: 'error', detail: String(e?.message || e) };
  }
}

/** Hand a lane back early (clean shutdown), so the server need not wait out the TTL. */
async function releaseProbeLease(provider) {
  if (!CT_BASE_URL || !CT_INGEST_TOKEN) return false;
  try {
    const res = await fetch(`${CT_BASE_URL}/api/ingest/probe-lease`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'release', provider, holderId: SCOUT_HOLDER_ID }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function shouldPostLatency(state, provider) {
  const last = state.latencyPostedAt?.[provider];
  if (!last) return true;
  const ageSec = (Date.now() - Date.parse(last)) / 1000;
  return !Number.isFinite(ageSec) || ageSec >= SCOUT_LATENCY_MIN_INTERVAL_SEC;
}

function fmpQuotaBlocked(state) {
  const until = state.fmpQuotaBlockedUntil;
  if (!until) return false;
  return Date.parse(until) > Date.now();
}

async function postLatencyPayload(provider, chamberJson, fmpPathId, state) {
  if (!CT_BASE_URL || !CT_INGEST_TOKEN) return false;
  if (!shouldPostLatency(state, provider)) {
    log('LATENCY', provider, 'skip spacing');
    return false;
  }
  try {
    const res = await fetch(`${CT_BASE_URL}/api/ingest/latency-payload`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        provider,
        fmpPathId,
        observedAt: nowIso(),
        chamberJson,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      warn('latency-payload', new Error(`HTTP ${res.status} ${text.slice(0, 160)}`));
      return false;
    }
    const body = await res.json().catch(() => ({}));
    state.latencyPostedAt = state.latencyPostedAt || {};
    state.latencyPostedAt[provider] = nowIso();
    log('LATENCY', provider, `upserted=${body.upserted ?? '?'}`, `matched=${body.matched ?? '?'}`);
    return true;
  } catch (e) {
    warn('latency-payload', e);
    return false;
  }
}

function bytesToBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

async function downloadFilingBytes(link) {
  if (!link) return null;
  const res = await fetch(link, {
    headers: {
      'user-agent': UA,
      accept: 'application/pdf,text/html,application/octet-stream,*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength === 0) throw new Error('empty body');
  if (ab.byteLength > SCOUT_RAW_MAX_BYTES) throw new Error(`body ${ab.byteLength} exceeds SCOUT_RAW_MAX_BYTES`);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  // Reject obvious Senate agreement wall HTML
  const head = Buffer.from(ab.slice(0, 4096)).toString('utf8');
  if (/I agree to the terms/i.test(head) && /efdsearch|agreement/i.test(head)) {
    throw new Error('senate agreement wall HTML (not a filing)');
  }
  return { bytes: Buffer.from(ab), contentType };
}

async function postRawUpload(docId, link, contentType, bytes) {
  if (!CT_BASE_URL || !CT_INGEST_TOKEN) return false;
  try {
    const res = await fetch(`${CT_BASE_URL}/api/ingest/raw`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        docId,
        sourceUrl: link || undefined,
        contentType,
        bytesBase64: bytesToBase64(bytes),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      warn('raw-upload', new Error(`${docId} HTTP ${res.status} ${text.slice(0, 160)}`));
      return false;
    }
    const body = await res.json().catch(() => ({}));
    log('RAW', docId, `bytes=${body.bytes ?? bytes.length}`, `enqueued=${body.enqueued ?? '?'}`);
    return true;
  } catch (e) {
    warn('raw-upload', e);
    return false;
  }
}

async function maybeUploadRaw(docId, link, state) {
  if (!SCOUT_RAW_UPLOAD || !link || !docId) return;
  if (state.rawUploaded?.[docId] || state.rawFailed?.[docId]) return;
  const isSenateView = /efdsearch\.senate\.gov/i.test(link || '');
  if (isSenateView && !/^(1|true|yes|on)$/i.test((process.env.SCOUT_SENATE_RAW || '').trim())) {
    state.rawFailed = state.rawFailed || {};
    state.rawFailed[docId] = 'skip_senate_view_use_relay';
    return;
  }
  try {
    const got = await downloadFilingBytes(link);
    if (!got) return;
    const ok = await postRawUpload(docId, link, got.contentType, got.bytes);
    if (ok) {
      state.rawUploaded = state.rawUploaded || {};
      state.rawUploaded[docId] = nowIso();
    } else {
      state.rawFailed = state.rawFailed || {};
      state.rawFailed[docId] = 'post_failed';
    }
  } catch (e) {
    warn(`raw:${docId}`, e);
    state.rawFailed = state.rawFailed || {};
    state.rawFailed[docId] = String(e?.message || e).slice(0, 120);
  }
}

// --- optional: push detections to the Cloudflare app ------------------------
// Returns true on success (or when CT_INGEST_URL isn't configured, i.e.
// nothing to retry) and false on failure so the caller can retry on a later
// cycle instead of silently dropping the detection forever.
async function maybePost(d, ts) {
  if (!CT_INGEST_URL) return true;
  try {
    const res = await fetch(CT_INGEST_URL, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        source: d.source,
        docKey: d.key,
        link: d.link,
        detectedAt: ts,
        filerName: d.name || undefined,
        filedDate: d.filedDate || undefined,
        // Default server-side is ingest-when-link-present; send explicitly so
        // pure latency runs can set CT_INGEST_LATENCY_ONLY=1 without code edits.
        ingest: process.env.CT_INGEST_LATENCY_ONLY === '1' ? false : true,
      }),
    });
    if (!res.ok) {
      warn('ct-post', new Error(`HTTP ${res.status}`));
      return false;
    }
    try {
      const body = await res.json();
      if (body && (body.insert || body.enqueued != null)) {
        log('POSTED', d.key, `insert=${body.insert ?? '?'}`, `enqueued=${body.enqueued ?? '?'}`);
      }
    } catch {
      /* response body optional */
    }
    return true;
  } catch (e) {
    warn('ct-post', e);
    return false;
  }
}

// --- state ------------------------------------------------------------------
function loadState() {
  const fresh = {
    startedAt: nowIso(),
    baselineEstablishedAt: null,
    ourSeen: {},
    posted: {},
    fmpSeen: {},
    qqSeen: {},
    uwSeen: {},
    leadsLogged: {},
    houseMaxDocId: 0,
    rawUploaded: {},
  };
  if (existsSync(STATE_FILE)) {
    try {
      // Merge onto `fresh` so a state file saved before these fields existed
      // (baselineEstablishedAt, posted) doesn't crash on the new code paths.
      return { ...fresh, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
    } catch { /* reset */ }
  }
  return fresh;
}
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// --- one cycle --------------------------------------------------------------
async function cycle(state) {
  // The very first cycle (per persisted state, so a launchctl/process restart
  // does NOT re-trigger this) is a startup snapshot of whatever's already
  // public, not a real detection race — those entries would otherwise get
  // posted to the app and scored as us "winning" a race that never happened.
  const isBaselineCycle = !state.baselineEstablishedAt;

  // Server-first plan: Mac covers a provider only after N successive *server*
  // errors (not wall-clock silence). SCOUT_LATENCY_ALWAYS overrides for testing.
  const plan = await fetchScoutPlan();
  const needScout = new Set(
    (plan?.latencyNeedScout || []).map((h) => h.provider).filter(Boolean),
  );
  if (SCOUT_LATENCY_ALWAYS) {
    needScout.add('fmp');
    needScout.add('unusual_whales');
    needScout.add('quiver');
  }
  // Do NOT invent needScout when plan is unavailable — that was the old
  // "always cover FMP" behavior and burned free-tier quota.
  if (plan?.latencyNeedScout?.length) {
    log(
      'HANDOFF latency',
      plan.latencyNeedScout.map((h) => `${h.provider}:${(h.needScoutReason || '').slice(0, 64)}`).join(' | ') || 'none',
    );
  }

  // Every provider call below is gated on a LEASE granted by the server. The
  // plan's needScout is only an eligibility hint; the lease is the permission,
  // and the server refuses it whenever it owns the lane itself. Acquiring also
  // charges the shared daily ledger, so these calls finally count against the
  // same cap the server spends from.
  const wantFmpCover = needScout.has('fmp') || needScout.has('fmp_rapidapi') || SCOUT_LATENCY_ALWAYS;
  const preferSecondaryFmpKey = !!(plan?.fmpPreferSecondaryKey) || wantFmpCover;
  if (FMP_PROBE_ENABLED && (FMP_KEY || FMP_RAPIDAPI_KEY) && wantFmpCover && !fmpQuotaBlocked(state)) {
    const lease = await acquireProbeLease('fmp', {
      ttlSec: plan?.leaseTtlSec,
      fmpSlot: preferSecondaryFmpKey && FMP_FREE_KEYS.length > 1 ? '2' : '1',
    });
    if (lease.granted) {
      try {
        if (preferSecondaryFmpKey && FMP_FREE_KEYS.length > 1) {
          log('fmp handoff: preferring secondary free-tier key (server owns primary)');
        }
        const fmp = await pollFmpFamily({ preferSecondaryKey: preferSecondaryFmpKey });
        for (const f of fmp.keys) {
          if (!state.fmpSeen[f.key]) state.fmpSeen[f.key] = { at: nowIso(), pathId: f.pathId, sourceId: f.sourceId };
        }
        for (const p of fmp.payloads) {
          if (needScout.has(p.provider) || (p.provider === 'fmp' && needScout.has('fmp')) || SCOUT_LATENCY_ALWAYS) {
            await postLatencyPayload(p.provider, p.chamberJson, p.fmpPathId, state);
          }
        }
      } catch (e) {
        warn('fmp', e);
        const msg = String(e?.message || e);
        if (/HTTP (402|429)/.test(msg)) {
          state.fmpQuotaBlockedUntil = new Date(Date.now() + SCOUT_FMP_QUOTA_BACKOFF_SEC * 1000).toISOString();
          log('fmp quota backoff until', state.fmpQuotaBlockedUntil);
        }
      }
    }
  }
  // NOTE: Quiver and UW previously had `else` branches that polled anyway and
  // threw the payload away — ~3,400-5,500 provider calls a day for zero stored
  // observations, invisible to every budget. There is no unleased path now.
  if (QQ_KEY) {
    const lease = await acquireProbeLease('quiver', { ttlSec: plan?.leaseTtlSec });
    if (lease.granted) {
      try {
        const qq = await pollQQ();
        for (const q of qq.keys) if (!state.qqSeen[q.key]) state.qqSeen[q.key] = { at: nowIso() };
        if (Object.keys(qq.chamberJson).length) await postLatencyPayload('quiver', qq.chamberJson, undefined, state);
      } catch (e) { warn('qq', e); }
    }
  }
  if (UW_KEY) {
    const lease = await acquireProbeLease('unusual_whales', { ttlSec: plan?.leaseTtlSec });
    if (lease.granted) {
      try {
        const uw = await pollUW();
        for (const u of uw.keys) if (!state.uwSeen[u.key]) state.uwSeen[u.key] = { at: nowIso() };
        if (Object.keys(uw.chamberJson).length) await postLatencyPayload('unusual_whales', uw.chamberJson, undefined, state);
      } catch (e) { warn('uw', e); }
    }
  }

  const detections = [];
  if (SOURCES.has('house')) {
    try { detections.push(...(await detectHouseLiveSearch())); } catch (e) { warn('house-live', e); }
    if (FRONTIER) { try { detections.push(...(await detectHouseFrontier(state))); } catch (e) { warn('house-frontier', e); } }
  }
  if (SOURCES.has('senate')) { try { detections.push(...(await detectSenate())); } catch (e) { warn('senate', e); } }

  for (const d of detections) {
    if (d.key.startsWith('H-')) { const n = Number(d.key.split('-').pop()); if (n > state.houseMaxDocId) state.houseMaxDocId = n; }
    if (!state.ourSeen[d.key]) {
      const at = nowIso();
      state.ourSeen[d.key] = { at, source: d.source, link: d.link, name: d.name || null, filedDate: d.filedDate || null };
      log('DETECT', d.source.padEnd(6), d.key, d.name || '');
    }
  }

  // Post (or retry a previously-failed post for) every detection, skipping the
  // baseline cycle entirely so pre-existing filings never reach the app as
  // "just detected". `state.posted` only flips to true on a successful POST,
  // so a detection whose post failed (bad token, app down, ...) keeps
  // retrying on later cycles instead of vanishing once the config is fixed.
  if (!isBaselineCycle) {
    for (const [key, entry] of Object.entries(state.ourSeen)) {
      if (state.posted[key]) continue;
      const ok = await maybePost({ source: entry.source, key, link: entry.link, name: entry.name, filedDate: entry.filedDate }, entry.at);
      if (ok) {
        state.posted[key] = true;
        // Residential download → R2 when server may be IP-blocked.
        await maybeUploadRaw(key, entry.link, state);
      }
    }
  }

  // Backlog from server plan: filings missing raw / 403-class fetch errors.
  if (!isBaselineCycle && SCOUT_RAW_UPLOAD && plan?.rawFetch?.length) {
    const backlog = plan.rawFetch
      .filter((n) => n?.sourceUrl && !/efdsearch\.senate\.gov/i.test(n.sourceUrl))
      .slice(0, 5);
    for (const need of backlog) {
      await maybeUploadRaw(need.docId, need.sourceUrl, state);
    }
  }

  const startMs = state.baselineEstablishedAt ? Date.parse(state.baselineEstablishedAt) : Date.parse(state.startedAt);
  for (const key of Object.keys(state.ourSeen)) {
    if (state.leadsLogged[key]) continue;
    const our = state.ourSeen[key];
    const fmp = state.fmpSeen[key];
    if (!our || !fmp) continue;
    const leadSec = Math.round((Date.parse(fmp.at) - Date.parse(our.at)) / 1000);
    const live = Date.parse(our.at) > startMs && Date.parse(fmp.at) > startMs;
    const rec = { key, source: our.source, name: our.name, ourDetectedAt: our.at, fmpFirstSeenAt: fmp.at, leadSec, live, loggedAt: nowIso() };
    appendFileSync(LEADS_FILE, JSON.stringify(rec) + '\n');
    state.leadsLogged[key] = true;
    log('LEAD  ', `${leadSec >= 0 ? '+' : ''}${leadSec}s`, live ? '(live race)' : '(baseline)', key, our.name || '');
  }
  if (isBaselineCycle) {
    state.baselineEstablishedAt = nowIso();
    log(`baseline established: ${Object.keys(state.ourSeen).length} pre-existing filing(s) will not be posted or scored as races`);
  }
  saveState(state);
  summarize(state);
}

function summarize(state) {
  const leads = existsSync(LEADS_FILE) ? readFileSync(LEADS_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const live = leads.filter((l) => l.live);
  const ahead = live.filter((l) => l.leadSec > 0);
  const detected = Object.keys(state.ourSeen).length;
  const matched = leads.length;
  let median = null;
  if (live.length) { const s = live.map((l) => l.leadSec).sort((a, b) => a - b); median = s[Math.floor(s.length / 2)]; }
  log(`SUMMARY detected=${detected} matched-with-fmp=${matched} live-races=${live.length} we-were-first=${ahead.length}${median != null ? ` median-lead=${median}s` : ''}`);
}

// --- main -------------------------------------------------------------------
(async () => {
  const state = loadState();
  const fmpOn = FMP_PROBE_ENABLED && !!(FMP_KEY || FMP_RAPIDAPI_KEY);
  log(
    `scout start — sources=${[...SOURCES].join('+')} interval=${INTERVAL_MS / 1000}s frontier=${FRONTIER}` +
      ` fmp=${fmpOn ? 'on' : 'OFF'} qq=${QQ_KEY ? 'on' : 'OFF'} uw=${UW_KEY ? 'on' : 'OFF'}` +
      ` handoff=${CT_BASE_URL ? 'on' : 'OFF'} rawUpload=${SCOUT_RAW_UPLOAD ? 'on' : 'OFF'}` +
      ` latencyAlways=${SCOUT_LATENCY_ALWAYS ? 'on' : 'off'} leaseHolder=${SCOUT_HOLDER_ID}`,
  );
  logFmpRegistry();

  // Hand every lane back on a clean exit so the server can resume immediately
  // instead of waiting out the TTL. A hard kill still self-heals on expiry —
  // that is what the TTL is for.
  let releasing = false;
  const releaseAllLanes = async () => {
    if (releasing) return;
    releasing = true;
    await Promise.all(
      ['fmp', 'fmp_rapidapi', 'quiver', 'unusual_whales'].map((p) => releaseProbeLease(p)),
    );
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      releaseAllLanes().finally(() => process.exit(0));
    });
  }

  if (ONCE) {
    await cycle(state);
    await releaseAllLanes();
    return;
  }
  for (;;) { await cycle(state).catch((e) => warn('cycle', e)); await sleep(INTERVAL_MS); }
})();
