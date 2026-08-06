/**
 * src/ingestion/tradeLatency.ts
 * OWNER: ingestion
 *
 * Provider-latency monitor for congressional disclosures. Candidates are
 * created when congress.trade first sees a new filing; provider observations
 * are populated from third-party "latest" endpoints. The public comparison
 * is deliberately limited to the intersection of both feeds and publishes
 * the provider-observed denominator separately, so a congress.trade miss
 * cannot silently turn into a speed win.
 */

import type { Env, Transaction } from '../shared/types.ts';
import { all, run, batch, get } from '../shared/db.ts';
import type { SqlParam } from '../shared/db.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { notifyAdmin } from '../alerts/notify.ts';
import { assertFmpTierOk } from '../shared/fmpStatus.ts';
import { getLastPollAt, setLastPollAt } from '../shared/config.ts';
import type { DiscoveredFiling } from './watcher.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

type Chamber = 'house' | 'senate' | 'executive';
/**
 * Latency race providers. FMP family lives here (and on Mac scout) — not on
 * Socratic.Trade product surfaces. `fmp` = direct stable host; `fmp_rapidapi` =
 * RapidAPI alternate path so both can race when probes are ON.
 */
export type ProviderId =
  | 'fmp'
  | 'fmp_rapidapi'
  | 'unusual_whales'
  | 'quiver'
  | 'finnhub'
  | 'ainvest'
  | 'capitol_trades';

/** Operational lifecycle for a latency source (admin + scout badges). */
export type LatencySourceStatus = 'off' | 'running' | 'error' | 'stopped' | 'unknown';

/** FMP family provider ids (CT latency + Mac scout only). */
export const FMP_FAMILY_PROVIDER_IDS: readonly ProviderId[] = ['fmp', 'fmp_rapidapi'] as const;

export function isFmpFamilyProvider(id: string): boolean {
  return (FMP_FAMILY_PROVIDER_IDS as readonly string[]).includes(id);
}

type EnvWithWatch = Env & {
  DISCLOSURE_LATENCY_WATCH_ENABLED?: string;
  DISCLOSURE_LATENCY_PROVIDERS?: string;
  DISCLOSURE_LATENCY_WATCH_LIMIT?: string;
  /** @deprecated Latency probes use FMP_LATENCY_API_KEY (+ secondary) only. */
  FMP_API_KEY?: string;
  FMP_DAILY_CALL_CAP?: string;
  FMP_MAX_PER_MINUTE?: string;
  FMP_DISCLOSURE_WATCH_ENABLED?: string;
  FMP_DISCLOSURE_WATCH_LIMIT?: string;
  UNUSUAL_WHALES_API_KEY?: string;
  QUIVER_API_KEY?: string;
  QUIVER_API_TOKEN?: string;
  FINNHUB_API_KEY?: string;
  AINVEST_API_KEY?: string;
  UW_DEEP_MATCH_DATES_PER_RUN?: string;
  /** Free-tier keys reserved for disclosure-latency probes only. */
  FMP_LATENCY_API_KEY?: string;
  /** Per-key daily cap for latency probes (default 235; free plan is 250). */
  FMP_LATENCY_DAILY_CAP?: string;
  /**
   * Master switch for FMP-family latency probes (stable + RapidAPI paths).
   * Default OFF — no FMP spend until operator sets true/1/yes/on.
   * Independent of DISCLOSURE_LATENCY_WATCH_ENABLED (UW/QQ can still run).
   */
  FMP_LATENCY_PROBE_ENABLED?: string;
  /**
   * Comma-separated FMP path ids to probe when FMP_LATENCY_PROBE_ENABLED is on:
   * `stable` (id=fmp) and/or `rapidapi` (id=fmp_rapidapi). Default both so they
   * can race when turned on.
   */
  FMP_LATENCY_PATHS?: string;
  /** Override base for stable FMP disclosures (default financialmodelingprep.com/stable). */
  FMP_STABLE_BASE_URL?: string;
  /** Override base for RapidAPI FMP disclosures. */
  FMP_RAPIDAPI_BASE_URL?: string;
  /** RapidAPI host header (default financial-modeling-prep.p.rapidapi.com). */
  FMP_RAPIDAPI_HOST?: string;
  /** Optional dedicated RapidAPI key; falls back to FMP_LATENCY_* keys. */
  FMP_RAPIDAPI_KEY?: string;
};

interface CandidateRow {
  trade_hash: string;
  doc_id: string;
  provider: ProviderId;
  chamber: Chamber;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  ticker: string | null;
  tx_date: string | null;
  tx_type: string | null;
  congress_first_seen_at: string;
  attempts: number;
}

interface ProviderObservationRow {
  provider: ProviderId;
  chamber: Chamber;
  provider_key: string;
  trade_hash: string;
  first_observed_at: string;
  last_observed_at: string;
  provider_published_at: string | null;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
}

export interface DisclosureProviderRow {
  provider: ProviderId;
  chamber: Chamber;
  providerKey: string;
  tradeHash: string;
  payload: Record<string, unknown>;
  sourceUrl: string | null;
  filedDate: string | null;
  filerName: string | null;
  providerPublishedAt: string | null;
}

export type FmpDisclosureRow = DisclosureProviderRow;

export interface CandidateMatch {
  providerKey: string;
  matchMethod: string;
}

export interface DisclosureLatencyProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  requiresMembership: boolean;
  supportsDirectLatest: boolean;
  timestampKind: 'provider' | 'monitor' | 'none';
  /**
   * Lifecycle badge for admin/scout UI:
   *  - off     intentional disable (grey) — default for FMP family
   *  - running probe path active (green)
   *  - error   enabled but failing (red)
   *  - stopped would run but missing keys/config (red-ish / warn)
   *  - unknown cannot determine
   */
  operationalStatus: LatencySourceStatus;
  /** Path family tag for multi-path providers (e.g. fmp stable vs rapidapi). */
  pathId?: string;
  reason?: string;
}

export interface DisclosureLatencyProviderRun extends DisclosureLatencyProviderStatus {
  enabled: boolean;
  fetchedRows: number;
  pending: number;
  matched: number;
  errors: string[];
}

export interface DisclosureLatencyProbeResult {
  enabled: boolean;
  reason?: string;
  fetchedRows: number;
  pending: number;
  matched: number;
  errors: string[];
  providers: DisclosureLatencyProviderRun[];
}

export interface DisclosureLatencyProviderMetrics {
  provider: ProviderId;
  label: string;
  /** Lifecycle for scoreboard (FMP family defaults to off). */
  operationalStatus?: LatencySourceStatus;
  candidates: number;
  /**
   * Concurrent races only (both first-seen in window, |delta| ≤ max concurrent
   * hours). Drives lead/win stats and preliminary/usable gates.
   */
  matched: number;
  /** High-confidence overlap matches in the score window (coverage density). */
  strongMatched: number;
  pending: number;
  errored: number;
  /** Rows observed by the provider during the active monitor window. */
  providerObserved: number;
  /** Provider rows old enough that a late congress.trade match is no longer pending. */
  maturedProviderObserved: number;
  /** Provider rows without a high-confidence congress.trade match after the grace period. */
  unmatchedProvider: number;
  /** Recent provider rows still inside the late-match grace period. */
  pendingProvider: number;
  /** congress.trade candidates old enough for a directional coverage estimate. */
  maturedCandidates: number;
  /** Jointly observed, high-confidence rows in the matured provider cohort. */
  maturedMatched: number;
  /** congress.trade coverage of the provider-observed matured cohort. */
  ctCoveragePct: number | null;
  /** Provider coverage of the congress.trade matured candidate cohort. */
  providerCoveragePct: number | null;
  /** Jaccard overlap of the two matured observed cohorts. */
  overlapPct: number | null;
  /** insufficient = too few matured rows; limited = coverage too low for a
   *  full claim; preliminary = enough matched timing for a soft claim;
   *  usable = coverage + sample gates pass for a full Ahead/Behind claim. */
  comparisonStatus: 'insufficient' | 'limited' | 'preliminary' | 'usable';
  comparisonBasis: 'matched-overlap-only';
  ctAheadMonitorCount: number;
  providerAheadMonitorCount: number;
  tieMonitorCount: number;
  avgMonitorDeltaSec: number | null;
  medianMonitorDeltaSec: number | null;
  p90MonitorDeltaSec: number | null;
  avgProviderPublishedDeltaSec: number | null;
  medianProviderPublishedDeltaSec: number | null;
  ctAheadPublishedCount: number;
  providerAheadPublishedCount: number;
  tiePublishedCount: number;
  /** Whether this provider uses monitor (crawler first-seen) or provider (provider's own semantic timestamp) for timing. */
  timestampKind: 'monitor' | 'provider' | 'none';
}

export interface DisclosureLatencyTotals {
  candidates: number;
  matched: number;
  pending: number;
  errored: number;
  providerObserved: number;
  maturedProviderObserved: number;
  unmatchedProvider: number;
  comparableProviders: number;
  configuredComparableProviders: number;
}

export interface DisclosureLatencySummary {
  generatedAt: string;
  /** Scoreboard observation window in hours (currently 168 = 7 days). */
  windowHours: number;
  /** Max |delta| hours for a race to count toward lead/win timing. */
  maxConcurrentDeltaHours: number;
  totals: DisclosureLatencyTotals;
  providers: DisclosureLatencyProviderMetrics[];
  providerStatuses: DisclosureLatencyProviderStatus[];
  publicSummary: {
    generatedAt: string;
    windowHours: number;
    maxConcurrentDeltaHours: number;
    totals: DisclosureLatencyTotals;
    providers: DisclosureLatencyProviderMetrics[];
  };
}

/** Alternate FMP HTTP path (stable host vs RapidAPI) for dual-path race. */
export type FmpLatencyPathId = 'stable' | 'rapidapi';

export interface FmpLatencyPathDefinition {
  pathId: FmpLatencyPathId;
  /** Matches ProviderId used in trade_latency_candidates / observations. */
  providerId: ProviderId;
  label: string;
  defaultBaseUrl: string;
  auth: 'query' | 'rapidapi';
  rapidApiHost?: string;
}

/**
 * Registered FMP path collection for CT latency + Mac scout.
 * Default operational state is ON for CT when latency keys present; explicit
 * FMP_LATENCY_PROBE_ENABLED=false forces OFF (grey).
 * When ON, enabled paths race (first observation wins per provider id).
 */
export const FMP_LATENCY_PATHS: readonly FmpLatencyPathDefinition[] = [
  {
    pathId: 'stable',
    providerId: 'fmp',
    label: 'FMP Stable',
    defaultBaseUrl: 'https://financialmodelingprep.com/stable',
    auth: 'query',
  },
  {
    pathId: 'rapidapi',
    providerId: 'fmp_rapidapi',
    label: 'FMP RapidAPI',
    defaultBaseUrl: 'https://financial-modeling-prep.p.rapidapi.com/stable',
    auth: 'rapidapi',
    rapidApiHost: 'financial-modeling-prep.p.rapidapi.com',
  },
] as const;

interface ProviderDefinition {
  id: ProviderId;
  label: string;
  secretNames: string[];
  requiresMembership: boolean;
  supportsDirectLatest: boolean;
  timestampKind: 'provider' | 'monitor' | 'none';
  /** FMP path id when this provider is an FMP-family alternate path. */
  fmpPathId?: FmpLatencyPathId;
  reason?: string;
  fetchRows?: (
    apiKey: string,
    max: number,
    fetchImpl: typeof fetch,
    pace?: () => Promise<void>,
    opts?: { baseUrl?: string; auth?: 'query' | 'rapidapi'; rapidApiHost?: string },
  ) => Promise<DisclosureProviderRow[]>;
}

const DEFAULT_LIMIT = 100;
const PAYLOAD_LIMIT = 20_000;
/**
 * Unusual Whales' recent-trades page only holds ~200 rows, so a pending
 * observation whose filing has scrolled outside that window can never match
 * on the normal pass. The deep-match pass re-queries recent-trades anchored
 * to specific transaction dates (see runUnusualWhalesDeepMatch) for up to
 * this many distinct dates per probe run, rotating through the stranded
 * backlog least-recently-checked first. 0 disables the pass entirely (e.g.
 * once a trial API key lapses and the extra calls would just 401).
 */
const UW_DEEP_MATCH_DEFAULT_DATES_PER_RUN = 8;
const UW_DEEP_MATCH_MAX_DATES_PER_RUN = 25;
/** Upper bound on how many provably-outside-window pending rows we'll scan
 *  per run to pick deep-match dates from; well above the ~52 UW rows
 *  currently stranded in production. */
const UW_DEEP_MATCH_CANDIDATE_LIMIT = 500;
/** Bind-parameter chunk size for `IN (...)` lookups (D1 caps bound params per
 *  statement; stay comfortably under it). */
const SQL_IN_CHUNK = 50;
/**
 * FMP free-tier keys for latency monitoring ONLY (owner 2026-08).
 *
 * - Secrets: FMP_LATENCY_KEY_PRIMARY + secondary (suffix _2); never FMP_API_KEY.
 * - Each key has its own daily counter (not shared with enrichment/prices).
 * - Cap ~235/key/day (free plan is 250; leave headroom for 429s / manual tests).
 * - House+senate latest = 2 HTTP calls per probe run.
 * - Adaptive ET-weighted spacing spreads remaining budget across the rest of the
 *   UTC day, denser during US publish hours (roughly 8–18 America/New_York).
 */
/** Second key name is built (not a bare `…API_KEY_2` literal) so gitleaks
 *  does not false-positive the env var *name* as a secret value. */
const FMP_LATENCY_KEY_PRIMARY = 'FMP_LATENCY_API_KEY';
const FMP_LATENCY_KEY_SECONDARY = `${FMP_LATENCY_KEY_PRIMARY}_2`;
const FMP_LATENCY_SECRET_NAMES = [FMP_LATENCY_KEY_PRIMARY, FMP_LATENCY_KEY_SECONDARY] as const;
type FmpLatencyKeySlot = '1' | '2';
/** Free-tier daily limit is 250; reserve margin so we never trip the hard wall. */
export const FMP_LATENCY_DAILY_CAP_PER_KEY = 235;
/** house-latest + senate-latest per successful FMP probe fetch. */
export const FMP_LATENCY_CALLS_PER_RUN = 2;
/** Floor spacing even when budget is flush (avoid hammering free tier). */
const FMP_LATENCY_MIN_INTERVAL_SEC = 120;
/** Cap spacing so a late-day recovery can still burn remaining budget. */
const FMP_LATENCY_MAX_INTERVAL_SEC = 45 * 60;

function fmpLatencyDayKey(slot: FmpLatencyKeySlot, now = new Date()): string {
  return `fmp-latency:calls:key${slot}:` + now.toISOString().slice(0, 10);
}

function fmpLatencyPollSource(slot: FmpLatencyKeySlot): string {
  return `fmp-disclosure-latency-key${slot}`;
}

async function fmpLatencyDailyCap(env: Env): Promise<number> {
  const envx = env as EnvWithWatch;
  const live = (await resolveSecret(env, 'FMP_LATENCY_DAILY_CAP')).value ?? envx.FMP_LATENCY_DAILY_CAP;
  const n = parseInt(live || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 250) : FMP_LATENCY_DAILY_CAP_PER_KEY;
}

export async function getFmpLatencyUsed(env: Env, slot: FmpLatencyKeySlot, now = new Date()): Promise<number> {
  try {
    const v = await env.CONFIG_KV.get(fmpLatencyDayKey(slot, now));
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function addFmpLatencyUsed(
  env: Env,
  slot: FmpLatencyKeySlot,
  n: number,
  now = new Date(),
): Promise<number> {
  const used = await getFmpLatencyUsed(env, slot, now);
  const next = Math.max(0, used + Math.floor(n));
  try {
    await env.CONFIG_KV.put(fmpLatencyDayKey(slot, now), String(next), { expirationTtl: 172800 });
  } catch {
    /* best effort */
  }
  return next;
}

/**
 * Weight remaining seconds of the day by America/New_York hour so probes are
 * denser when disclosures typically publish (morning–afternoon ET weekdays).
 * Returns a multiplier ≥ 0.35; peak hours ~1.0, overnight ~0.35–0.5.
 */
export function fmpLatencyEtHourWeight(now: Date = new Date()): number {
  // en-US + America/New_York gives weekday + hour without extra deps.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  // Peak publish window weekdays 8–17 ET.
  let w = 0.45;
  if (hour >= 8 && hour < 12) w = 1.0;
  else if (hour >= 12 && hour < 18) w = 0.85;
  else if (hour >= 6 && hour < 8) w = 0.65;
  else if (hour >= 18 && hour < 21) w = 0.55;
  else w = 0.35;
  if (isWeekend) w *= 0.55;
  return w;
}

/**
 * Seconds until the next FMP latency probe for a key, given remaining budget
 * for the UTC day. Spreads calls so we do not front-load free-tier quota.
 */
export function fmpLatencyIntervalSec(
  now: Date,
  remainingCalls: number,
  callsPerRun: number = FMP_LATENCY_CALLS_PER_RUN,
): number {
  if (remainingCalls < callsPerRun) return FMP_LATENCY_MAX_INTERVAL_SEC;
  const runsLeft = Math.max(1, Math.floor(remainingCalls / callsPerRun));
  // Seconds left in the UTC day (counters roll on UTC date key).
  const endUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const secLeft = Math.max(60, Math.floor((endUtc - now.getTime()) / 1000));
  const weight = fmpLatencyEtHourWeight(now);
  // Base uniform spacing, then shrink interval in peak hours (more frequent).
  const uniform = secLeft / runsLeft;
  const weighted = uniform / Math.max(0.35, weight);
  return Math.max(
    FMP_LATENCY_MIN_INTERVAL_SEC,
    Math.min(FMP_LATENCY_MAX_INTERVAL_SEC, Math.round(weighted)),
  );
}

export interface FmpLatencyKeySelection {
  apiKey: string;
  slot: FmpLatencyKeySlot;
  secretName: (typeof FMP_LATENCY_SECRET_NAMES)[number];
  used: number;
  cap: number;
  remaining: number;
  intervalSec: number;
}

/**
 * Pick a configured latency-only key that still has budget and whose poll
 * spacing has elapsed. Prefers the key with more remaining budget.
 * Never falls back to FMP_API_KEY (enrichment/prices/recovery must not share
 * these free-tier keys — owner: latency monitoring only).
 */
export async function selectFmpLatencyKey(
  env: Env,
  now: Date = new Date(),
  opts: { force?: boolean } = {},
): Promise<FmpLatencyKeySelection | null> {
  const cap = await fmpLatencyDailyCap(env);
  const envx = env as unknown as Record<string, string | undefined>;
  const candidates: FmpLatencyKeySelection[] = [];

  for (let i = 0; i < FMP_LATENCY_SECRET_NAMES.length; i++) {
    const secretName = FMP_LATENCY_SECRET_NAMES[i]!;
    const slot: FmpLatencyKeySlot = i === 0 ? '1' : '2';
    const value = (await resolveSecret(env, secretName as keyof Env & string)).value ?? envx[secretName];
    const apiKey = value?.trim();
    if (!apiKey) continue;

    const used = await getFmpLatencyUsed(env, slot, now);
    const remaining = Math.max(0, cap - used);
    if (remaining < FMP_LATENCY_CALLS_PER_RUN) continue;

    const intervalSec = fmpLatencyIntervalSec(now, remaining);
    if (!opts.force) {
      const last = await getLastPollAt(env, fmpLatencyPollSource(slot));
      if (last && now.getTime() - last.getTime() < intervalSec * 1000) continue;
    }

    candidates.push({
      apiKey,
      slot,
      secretName,
      used,
      cap,
      remaining,
      intervalSec,
    });
  }

  if (!candidates.length) return null;
  // Prefer more remaining budget; tie-break slot 1 then 2.
  candidates.sort((a, b) => b.remaining - a.remaining || a.slot.localeCompare(b.slot));
  return candidates[0]!;
}
/**
 * Full default probe list when DISCLOSURE_LATENCY_PROVIDERS is unset.
 * FMP family is listed so statuses register, but probes stay OFF until
 * FMP_LATENCY_PROBE_ENABLED (see isFmpProbeEnabled).
 */
const DIRECT_PROVIDER_IDS: ProviderId[] = ['fmp', 'fmp_rapidapi', 'unusual_whales', 'quiver'];

// Latency scoreboard policy (owner 2026-08):
//   • Race only **live** newly-imported CT trades — never seed/historical backfills.
//   • Match those to FMP / UW / Quiver as hard as possible (minute … multi-week gap OK).
//   • Lead stats measure first-seen delta either way (we can win or lose by a week).
//   • Scoreboard window is rolling 7 days of CT live first_seen; provider match
//     lookback is longer so a provider that listed the trade days earlier still hits.
/** Scoreboard: CT live first_seen in the last 7 days. */
export const LATENCY_SCORE_WINDOW_HOURS = 168;
/**
 * When matching pending CT races, search this far back in provider observations
 * so "they beat us by a week" still joins. Longer than the scoreboard window.
 */
export const LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS = 14 * 24;
/** Keep RECENT_PROVIDER_HOURS as the match lookback (not the score window). */
const RECENT_PROVIDER_HOURS = LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS;
export const LATENCY_MATURITY_GRACE_HOURS = 24;
/** Full "usable" claim requires this many matured provider-observed rows. */
export const LATENCY_MIN_MATURED_ROWS = 15;
/** Preliminary timing shown from this many timed matches. */
export const LATENCY_MIN_PRELIMINARY_MATCHED = 2;
export const LATENCY_MIN_COVERAGE_PCT = 80;
/**
 * Max |first-seen gap| for lead stats. Up to 14 days either direction —
 * minute, day, or week is all a real race. Beyond that is noise.
 */
export const LATENCY_MAX_CONCURRENT_DELTA_HOURS = LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS;
/**
 * If CT first_seen is more than this many days after the official filed_date,
 * treat the import as a historical crawl/backfill (house index re-run, etc.)
 * even when transaction.source is still `primary`.
 */
export const LATENCY_LIVE_FILING_MAX_LAG_DAYS = 21;
/** Allow trade dates to differ by this many days for near-miss fuzzy match. */
export const LATENCY_FUZZY_DATE_SLACK_DAYS = 2;

const BACKFILL_TX_SOURCES = new Set(['seed_dataset', 'competitor_backfill']);

/**
 * True when this CT row is a live discovery/import we want on the scoreboard.
 * Excludes seed/competitor backfills and primary-path historical crawls where
 * we first_seen the filing long after it was filed.
 */
export function isLiveRaceImport(opts: {
  source?: string | null;
  filedDate?: string | null;
  firstSeenAt?: string | null;
  maxLagDays?: number;
}): boolean {
  const src = (opts.source || 'primary').toLowerCase();
  if (BACKFILL_TX_SOURCES.has(src)) return false;
  const filedRaw = opts.filedDate?.trim();
  const seenRaw = opts.firstSeenAt?.trim();
  if (!filedRaw || !seenRaw) return true; // no lag signal — allow primary-like sources
  const filedMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(filedRaw) ? `${filedRaw}T00:00:00.000Z` : filedRaw);
  const seenMs = Date.parse(seenRaw);
  if (!Number.isFinite(filedMs) || !Number.isFinite(seenMs)) return true;
  const lagDays = (seenMs - filedMs) / 86_400_000;
  const maxLag = opts.maxLagDays ?? LATENCY_LIVE_FILING_MAX_LAG_DAYS;
  // first_seen long after filed → historical backfill crawl, not live scout/agreement.
  if (lagDays > maxLag) return false;
  return true;
}

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'fmp',
    label: 'FMP Stable',
    secretNames: [FMP_LATENCY_KEY_PRIMARY, FMP_LATENCY_KEY_SECONDARY],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'monitor',
    fmpPathId: 'stable',
    reason:
      'FMP stable host (financialmodelingprep.com). Default ON for CT latency when keys present; set FMP_LATENCY_PROBE_ENABLED=false to disable. No provider first-seen timestamp; monitor first-observed is used.',
    fetchRows: (apiKey, max, fetchImpl, pace, opts) =>
      fetchFmpRows(apiKey, max, fetchImpl, pace, {
        baseUrl: opts?.baseUrl ?? FMP_LATENCY_PATHS[0]!.defaultBaseUrl,
        auth: 'query',
        providerId: 'fmp',
      }),
  },
  {
    id: 'fmp_rapidapi',
    label: 'FMP RapidAPI',
    secretNames: ['FMP_RAPIDAPI_KEY', FMP_LATENCY_KEY_PRIMARY, FMP_LATENCY_KEY_SECONDARY],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'monitor',
    fmpPathId: 'rapidapi',
    reason:
      'FMP via RapidAPI alternate host. Default ON for CT (races FMP Stable when path enabled). Disable with FMP_LATENCY_PROBE_ENABLED=false or FMP_LATENCY_PATHS excluding rapidapi.',
    fetchRows: (apiKey, max, fetchImpl, pace, opts) =>
      fetchFmpRows(apiKey, max, fetchImpl, pace, {
        baseUrl: opts?.baseUrl ?? FMP_LATENCY_PATHS[1]!.defaultBaseUrl,
        auth: 'rapidapi',
        rapidApiHost: opts?.rapidApiHost ?? FMP_LATENCY_PATHS[1]!.rapidApiHost,
        providerId: 'fmp_rapidapi',
      }),
  },
  {
    id: 'unusual_whales',
    label: 'Unusual Whales',
    secretNames: ['UNUSUAL_WHALES_API_KEY', 'UNUSUALWHALES_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'monitor',
    reason: 'Recent Congress trades exposes filed_at_date, but not a provider first-seen timestamp.',
    fetchRows: fetchUnusualWhalesRows,
  },
  {
    id: 'quiver',
    label: 'Quiver Quantitative',
    secretNames: ['QUIVER_API_KEY', 'QUIVER_API_TOKEN'],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'provider',
    reason: 'Quiver V2 rows may include Quiver_Upload_Time; otherwise the monitor first-observed time is used.',
    fetchRows: fetchQuiverRows,
  },
  {
    id: 'finnhub',
    label: 'Finnhub',
    secretNames: ['FINNHUB_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: false,
    timestampKind: 'none',
    reason: 'Finnhub congressional trading is symbol/date-range scoped, not a global latest-disclosure feed.',
  },
  {
    id: 'ainvest',
    label: 'AInvest',
    secretNames: ['AINVEST_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: false,
    timestampKind: 'none',
    reason: 'AInvest congressional trades require a ticker parameter, so they cannot race all new disclosures directly.',
  },
  {
    id: 'capitol_trades',
    label: 'Capitol Trades',
    secretNames: [],
    requiresMembership: false,
    supportsDirectLatest: false,
    timestampKind: 'none',
    reason: 'No official API found; the public site is protected by a browser checkpoint, so this remains manual/unsupported.',
  },
];

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

/**
 * Master switch for FMP-family latency probes.
 * Default ON for Congress.Trade (FMP is a first-class CT data path / latency race source).
 * Explicitly disable with FMP_LATENCY_PROBE_ENABLED=false|0|off|no.
 * (Socratic.Trade blocks FMP product use separately — this switch is CT-only.)
 */
export async function isFmpProbeEnabled(env: Env): Promise<boolean> {
  const envx = env as EnvWithWatch;
  const live =
    (await resolveSecret(env, 'FMP_LATENCY_PROBE_ENABLED')).value ?? envx.FMP_LATENCY_PROBE_ENABLED;
  if (live === undefined || live === null || String(live).trim() === '') return true;
  // Explicit falsey
  if (/^(0|false|no|off)$/i.test(String(live).trim())) return false;
  return truthy(String(live));
}

/**
 * Which FMP paths to activate when the master probe switch is on.
 * Default both (`stable,rapidapi`) so alternate hosts can race.
 */
export async function enabledFmpPathIds(env: Env): Promise<Set<FmpLatencyPathId>> {
  const envx = env as EnvWithWatch;
  const raw =
    (await resolveSecret(env, 'FMP_LATENCY_PATHS')).value ?? envx.FMP_LATENCY_PATHS ?? 'stable,rapidapi';
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const out = new Set<FmpLatencyPathId>();
  for (const p of parts) {
    if (p === 'stable' || p === 'fmp') out.add('stable');
    if (p === 'rapidapi' || p === 'fmp_rapidapi' || p === 'rapid') out.add('rapidapi');
  }
  if (!out.size) {
    out.add('stable');
    out.add('rapidapi');
  }
  return out;
}

export async function resolveFmpPathRuntime(
  env: Env,
  path: FmpLatencyPathDefinition,
): Promise<{ baseUrl: string; rapidApiHost?: string }> {
  const envx = env as EnvWithWatch;
  if (path.pathId === 'stable') {
    const base =
      (await resolveSecret(env, 'FMP_STABLE_BASE_URL')).value ??
      envx.FMP_STABLE_BASE_URL ??
      path.defaultBaseUrl;
    return { baseUrl: base.replace(/\/+$/, '') };
  }
  const base =
    (await resolveSecret(env, 'FMP_RAPIDAPI_BASE_URL')).value ??
    envx.FMP_RAPIDAPI_BASE_URL ??
    path.defaultBaseUrl;
  const host =
    (await resolveSecret(env, 'FMP_RAPIDAPI_HOST')).value ??
    envx.FMP_RAPIDAPI_HOST ??
    path.rapidApiHost;
  return { baseUrl: base.replace(/\/+$/, ''), rapidApiHost: host };
}

async function enabled(env: EnvWithWatch): Promise<boolean> {
  // wrangler.toml / Deno env may carry a literal fallback; resolveSecret already
  // falls back to env[key] when Infisical has nothing configured for this name.
  // Infisical override wins when set. Production should set the full latency
  // knob set in Infisical (enabled/providers/limit + UW deep-match).
  const watchEnabled =
    (await resolveSecret(env, 'DISCLOSURE_LATENCY_WATCH_ENABLED')).value ?? env.DISCLOSURE_LATENCY_WATCH_ENABLED;
  const legacyEnabled =
    (await resolveSecret(env, 'FMP_DISCLOSURE_WATCH_ENABLED')).value ?? env.FMP_DISCLOSURE_WATCH_ENABLED;
  return truthy(watchEnabled) || truthy(legacyEnabled);
}

async function limit(env: EnvWithWatch): Promise<number> {
  const raw =
    (await resolveSecret(env, 'DISCLOSURE_LATENCY_WATCH_LIMIT')).value ??
    (await resolveSecret(env, 'FMP_DISCLOSURE_WATCH_LIMIT')).value ??
    env.DISCLOSURE_LATENCY_WATCH_LIMIT ??
    env.FMP_DISCLOSURE_WATCH_LIMIT;
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : DEFAULT_LIMIT;
}

/** How many distinct filed dates the UW deep-match pass may query per probe
 *  run. Unset/invalid -> default 8; explicit "0" disables the pass; clamped
 *  to [0, 25] otherwise so a misconfigured value can't blow up UW call
 *  volume. */
async function uwDeepMatchDatesPerRun(env: EnvWithWatch): Promise<number> {
  const raw =
    (await resolveSecret(env, 'UW_DEEP_MATCH_DATES_PER_RUN')).value ?? env.UW_DEEP_MATCH_DATES_PER_RUN;
  if (raw == null || raw.trim() === '') return UW_DEEP_MATCH_DEFAULT_DATES_PER_RUN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return UW_DEEP_MATCH_DEFAULT_DATES_PER_RUN;
  return Math.min(Math.max(n, 0), UW_DEEP_MATCH_MAX_DATES_PER_RUN);
}

/** True when `err` reflects an optional table/column that hasn't been migrated yet. */
export function storageMissing(err: unknown): boolean {
  return /no such table|no column named|no such column/i.test(err instanceof Error ? err.message : String(err));
}

function definition(id: ProviderId): ProviderDefinition {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

async function requestedProviderIds(env: EnvWithWatch, opts: { providers?: string[] } = {}): Promise<ProviderId[]> {
  const configured =
    (await resolveSecret(env, 'DISCLOSURE_LATENCY_PROVIDERS')).value ?? env.DISCLOSURE_LATENCY_PROVIDERS;
  const raw = opts.providers?.length ? opts.providers.join(',') : configured || '';
  const parsed = raw
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean) as ProviderId[];
  const allowed = new Set(PROVIDERS.map((p) => p.id));
  const ids = parsed.filter((id) => allowed.has(id));
  return ids.length ? Array.from(new Set(ids)) : [...DIRECT_PROVIDER_IDS];
}

function normalizeDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return s.slice(0, 10);
}

function normalizeTimestamp(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function dateVariants(iso: string | null): string[] {
  if (!iso) return [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [iso.toLowerCase()];
  return [iso, `${Number(m[2])}/${Number(m[3])}/${m[1]}`, `${m[2]}/${m[3]}/${m[1]}`].map((s) => s.toLowerCase());
}

function collectPrimitiveText(v: unknown, out: string[] = []): string[] {
  if (v == null) return out;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    out.push(String(v));
    return out;
  }
  if (Array.isArray(v)) {
    for (const item of v) collectPrimitiveText(item, out);
    return out;
  }
  if (typeof v === 'object') {
    for (const item of Object.values(v as Record<string, unknown>)) collectPrimitiveText(item, out);
  }
  return out;
}

function rowText(row: Record<string, unknown>): string {
  return collectPrimitiveText(row).join(' ').toLowerCase();
}

function rowStrings(row: Record<string, unknown>): string[] {
  return collectPrimitiveText(row).filter((v) => typeof v === 'string');
}

function firstUrl(row: Record<string, unknown>): string | null {
  for (const value of rowStrings(row)) {
    if (/^https?:\/\//i.test(value)) return value;
    if (/\/search\/view\/ptr\//i.test(value)) return value;
    if (/ptr-pdfs/i.test(value)) return value;
  }
  return null;
}

function fieldString(row: Record<string, unknown>, names: string[]): string | null {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const v = lower.get(name.toLowerCase());
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function providerKeyFromUrl(url: string | null): string | null {
  if (!url) return null;
  const lower = url.toLowerCase();
  const house = /\/ptr-pdfs\/\d{4}\/([^/?#]+?)(?:\.pdf)?(?:[?#].*)?$/i.exec(lower);
  if (house && house[1].length >= 6) return house[1];
  const senate = /\/search\/view\/ptr\/([^/?#]+)/i.exec(lower);
  if (senate && senate[1].length >= 6) return senate[1];
  const path = lower.split(/[?#]/, 1)[0].split('/');
  const last = path.filter(Boolean).slice(-1)[0]?.replace(/\.pdf$/i, '');
  return last && last.length >= 6 ? last : null;
}

function tokensFromDoc(docId: string, sourceUrl: string | null): string[] {
  const out = new Set<string>();
  const docLower = docId.toLowerCase();
  if (docLower.length >= 6) out.add(docLower);
  const urlLower = (sourceUrl ?? '').toLowerCase();
  if (urlLower.length >= 12) out.add(urlLower);
  const key = providerKeyFromUrl(sourceUrl);
  if (key) out.add(key);
  for (const part of docLower.split(/[^a-z0-9]+/)) {
    if (part.length >= 6) out.add(part);
  }
  const house = /^h-\d{4}-(.+)$/i.exec(docId);
  if (house && house[1].length >= 6) out.add(house[1].toLowerCase());
  const senate = /^s-(.+)$/i.exec(docId);
  if (senate && senate[1].length >= 6) out.add(senate[1].toLowerCase());
  return Array.from(out).filter((t) => t.length >= 6);
}


export function extractLastName(name: string | null): string {
  if (!name) return '';
  const clean = name.replace(/\b[A-Za-z]\.\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = clean.split(',')[0].split(' ');
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase().replace(/[^a-z]/g, '');
    if (p && p.length > 1 && !['jr', 'sr', 'md', 'ii', 'iii', 'iv', 'v'].includes(p)) return p;
  }
  return '';
}

/** Normalize CT `P`/`S`/`E` and provider buy/sell/purchase/sale strings. */
export function normalizeTradeSide(type: string | null | undefined): 'buy' | 'sell' | 'exchange' {
  const tyStr = (type || '').toLowerCase().trim();
  if (!tyStr) return 'exchange';
  if (tyStr === 'p' || tyStr.includes('buy') || tyStr.includes('purchase')) return 'buy';
  if (tyStr === 's' || tyStr.includes('sell') || tyStr.includes('sale')) return 'sell';
  if (tyStr === 'e' || tyStr.includes('exchange')) return 'exchange';
  return 'exchange';
}

export function generateTradeHash(filerName: string | null, ticker: string | null, date: string | null, type: string | null): string {
  const ln = extractLastName(filerName);
  const tk = (ticker || '').toUpperCase().trim().replace(/[\.\/]/g, '-');
  const dt = normalizeDate(date) || '';
  const ty = normalizeTradeSide(type);
  return `${ln}_${tk}_${dt}_${ty}`;
}

/** Parse `lastName_ticker_YYYY-MM-DD_side` (ticker/date may be empty). */
export function parseTradeHash(hash: string | null | undefined): {
  lastName: string;
  ticker: string;
  date: string;
  side: string;
} {
  const raw = String(hash ?? '');
  const m = /^([^_]+)_([^_]*)_(\d{4}-\d{2}-\d{2})?_?(buy|sell|exchange)?$/i.exec(raw);
  if (m) {
    return {
      lastName: (m[1] || '').toLowerCase(),
      ticker: (m[2] || '').toUpperCase(),
      date: m[3] || '',
      side: (m[4] || '').toLowerCase(),
    };
  }
  // Fallback: lastName_ticker_date_side with date always YYYY-MM-DD when present.
  const parts = raw.split('_');
  if (parts.length >= 4) {
    const side = parts[parts.length - 1].toLowerCase();
    const date = parts[parts.length - 2];
    const lastName = (parts[0] || '').toLowerCase();
    const ticker = parts.slice(1, -2).join('_').toUpperCase();
    return {
      lastName,
      ticker: /^\d{4}-\d{2}-\d{2}$/.test(date) ? ticker : parts.slice(1, -1).join('_').toUpperCase(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      side: ['buy', 'sell', 'exchange'].includes(side) ? side : '',
    };
  }
  return { lastName: '', ticker: '', date: '', side: '' };
}

/**
 * Prefer a real first-seen stamp when it is still inside the active score
 * window; otherwise use now. Prevents multi-year filing stamps from entering
 * the race as fake "CT was first by months" leads.
 */
export function raceFirstSeenAt(
  txFirstSeen: string | null | undefined,
  nowIso: string,
  windowHours = LATENCY_SCORE_WINDOW_HOURS,
): string {
  if (!txFirstSeen) return nowIso;
  const t = Date.parse(txFirstSeen);
  const n = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return nowIso;
  if (n - t > windowHours * 3600_000) return nowIso;
  return txFirstSeen;
}

function chamberFromDocId(docId: string | null | undefined, fallback: Chamber = 'house'): Chamber {
  const id = (docId || '').trim().toUpperCase();
  if (id.startsWith('S-') || id.startsWith('SENATE-')) return 'senate';
  if (id.startsWith('E-') || id.startsWith('EXEC') || id.startsWith('OGE-')) return 'executive';
  if (id.startsWith('H-') || id.startsWith('HOUSE-')) return 'house';
  return fallback;
}

function lastName(name: string | null): string | null {
  if (!name) return null;
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const comma = clean.indexOf(',');
  const last = comma >= 0 ? clean.slice(0, comma) : clean.split(' ').slice(-1)[0];
  return last && last.length >= 4 ? last.toLowerCase() : null;
}

function normalizeChamber(raw: string | null, fallback: Chamber): Chamber {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('executive') || s.includes('president') || s.includes('whitehouse')) return 'executive';
  if (s.includes('senate') || s.includes('senator')) return 'senate';
  if (s.includes('house') || s.includes('representative') || s.includes('representatives')) return 'house';
  return fallback;
}

function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['data', 'results', 'items']) {
      const value = obj[key];
      if (Array.isArray(value)) {
        return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = extractRows(value);
        if (nested.length) return nested;
      }
    }
  }
  return [];
}

function rowKeyFromFields(provider: ProviderId, payload: Record<string, unknown>, fields: string[]): string {
  const parts = fields.map((field) => fieldString(payload, [field]) ?? '').filter(Boolean);
  const basis = parts.length ? parts.join('|') : rowText(payload);
  return `${provider}:${simpleHash(basis)}`;
}

export function parseFmpDisclosureRows(
  chamber: Chamber,
  json: unknown,
  providerId: ProviderId = 'fmp',
): FmpDisclosureRow[] {
  return extractRows(json).map((payload) => {
    const sourceUrl = firstUrl(payload);
    const text = rowText(payload);
    const docToken = providerKeyFromUrl(sourceUrl) ?? fieldString(payload, ['docId', 'documentId', 'reportId', 'disclosureId', 'disclosure_id']);
    const providerKey = docToken ? String(docToken).toLowerCase() : simpleHash(text);
    return {
      provider: providerId,
      chamber,
      providerKey,
      tradeHash: generateTradeHash(fieldString(payload, ['representative', 'senator', 'filerName', 'name']), fieldString(payload, ['ticker', 'symbol']), fieldString(payload, ['transactionDate', 'txDate']), fieldString(payload, ['type', 'transactionType'])),
      payload,
      sourceUrl,
      filedDate: normalizeDate(fieldString(payload, ['filedDate', 'filingDate', 'disclosureDate', 'reportedDate'])),
      filerName: fieldString(payload, ['representative', 'senator', 'filerName', 'name']),
      providerPublishedAt: null,
    };
  });
}

export function parseUnusualWhalesDisclosureRows(json: unknown): DisclosureProviderRow[] {
  return extractRows(json).map((payload) => {
    const filedDate = normalizeDate(fieldString(payload, ['filed_at_date', 'filingDate', 'filedDate', 'filed_at', 'filing_date', 'date_filed', 'created_at']));
    const filerName = fieldString(payload, ['name', 'reporter']);
    return {
      provider: 'unusual_whales',
      chamber: normalizeChamber(fieldString(payload, ['member_type', 'chamber']), 'house'),
      providerKey: rowKeyFromFields('unusual_whales', payload, [
        'politician_id',
        'filed_at_date',
        'ticker',
        'transaction_date',
        'txn_type',
        'name',
      ]),
      tradeHash: generateTradeHash(filerName, fieldString(payload, ['ticker', 'symbol']), fieldString(payload, ['transaction_date']), fieldString(payload, ['txn_type', 'type'])),
      payload,
      sourceUrl: firstUrl(payload),
      filedDate,
      filerName,
      providerPublishedAt: normalizeTimestamp(fieldString(payload, ['created_at', 'published_at', 'inserted_at', 'updated_at'])),
    };
  });
}

export function parseQuiverDisclosureRows(chamber: Chamber, json: unknown, defaultFilerName?: string): DisclosureProviderRow[] {
  return extractRows(json).map((payload) => {
    const filedDate = normalizeDate(fieldString(payload, ['Filed', 'ReportDate', 'report_date', 'filed_date', 'last_modified', 'DateRecieved', 'date_received', 'Date_Received', 'Report_Date']));
    const filerName = fieldString(payload, ['Representative', 'Senator', 'Name', 'representative', 'senator', 'name']) || defaultFilerName || '';
    return {
      provider: 'quiver',
      chamber: normalizeChamber(fieldString(payload, ['Chamber', 'House', 'house']), chamber),
      providerKey: rowKeyFromFields('quiver', payload, [
        'BioGuideID',
        'Representative',
        'Senator',
        'Name',
        'Filed',
        'ReportDate',
        'Ticker',
        'TransactionDate',
        'Date',
        'Traded',
        'Transaction',
      ]),
      tradeHash: generateTradeHash(filerName, fieldString(payload, ['Ticker']), fieldString(payload, ['TransactionDate', 'Date']), fieldString(payload, ['Transaction'])),
      payload,
      sourceUrl: firstUrl(payload),
      filedDate,
      filerName,
      providerPublishedAt: normalizeTimestamp(fieldString(payload, ['Quiver_Upload_Time', 'last_modified', 'created_at'])),
    };
  });
}

/** Absolute day distance between two YYYY-MM-DD strings, or null if unparsable. */
export function tradeDateDayDistance(a: string, b: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const ms = Date.parse(`${a}T00:00:00.000Z`) - Date.parse(`${b}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(Math.abs(ms) / 86_400_000);
}

export function matchDisclosureCandidate(
  candidate: Pick<CandidateRow, 'trade_hash'>,
  row: DisclosureProviderRow,
): CandidateMatch | null {
  if (candidate.trade_hash && row.tradeHash && candidate.trade_hash === row.tradeHash) {
    return { providerKey: row.providerKey, matchMethod: 'trade-hash' };
  }

  const c = parseTradeHash(candidate.trade_hash);
  const r = parseTradeHash(row.tradeHash);
  if (!c.lastName || !r.lastName || c.lastName !== r.lastName) return null;
  if (!c.side || !r.side || c.side !== r.side) return null;

  const sameTicker = Boolean(c.ticker && r.ticker && c.ticker === r.ticker);
  const eitherTickerMissing = !c.ticker || !r.ticker;
  const sameDate = Boolean(c.date && r.date && c.date === r.date);
  const eitherDateMissing = !c.date || !r.date;
  const nearDate =
    !!c.date &&
    !!r.date &&
    !sameDate &&
    (tradeDateDayDistance(c.date, r.date) ?? 99) <= LATENCY_FUZZY_DATE_SLACK_DAYS;

  // Same politician + ticker + side; date equal or missing on one side.
  if (sameTicker && (sameDate || eitherDateMissing)) {
    return { providerKey: row.providerKey, matchMethod: 'fuzzy-missing-date' };
  }

  // Same politician + ticker + side; trade dates within slack (providers
  // sometimes use filed/settlement vs transaction date).
  if (sameTicker && nearDate) {
    return { providerKey: row.providerKey, matchMethod: 'fuzzy-near-date' };
  }

  // Same politician + date + side; ticker missing on one side (provider
  // option/trust lines often omit the equity ticker).
  if (sameDate && eitherTickerMissing) {
    return { providerKey: row.providerKey, matchMethod: 'fuzzy-no-ticker' };
  }

  return null;
}

export function matchFmpDisclosureCandidate(
  candidate: Pick<CandidateRow, 'trade_hash'>,
  row: FmpDisclosureRow,
): CandidateMatch | null {
  return matchDisclosureCandidate(candidate, row);
}

async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await trackedFetch(url, {
    headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json', ...headers },
  }, { service: 'disclosure-latency', operation: 'fetch-provider-latest' }, fetchImpl);
  if (!res.ok) throw new Error(`HTTP_${res.status}:${url.replace(/[?&](apikey|token)=[^&]+/gi, '$1=[redacted]')}`);
  return res.json();
}

export interface FetchFmpRowsOpts {
  baseUrl?: string;
  auth?: 'query' | 'rapidapi';
  rapidApiHost?: string;
  providerId?: ProviderId;
}

/**
 * Fetch house+senate latest disclosures from an FMP path (stable or RapidAPI).
 * Path bases are injectable so alternate hosts can race without code edits.
 */
async function fetchFmpRows(
  apiKey: string,
  max: number,
  fetchImpl: typeof fetch,
  pace: () => Promise<void> = async () => {},
  opts: FetchFmpRowsOpts = {},
): Promise<DisclosureProviderRow[]> {
  const baseUrl = (opts.baseUrl ?? 'https://financialmodelingprep.com/stable').replace(/\/+$/, '');
  const auth = opts.auth ?? 'query';
  const providerId = opts.providerId ?? 'fmp';
  const fetchOne = async (chamber: Chamber) => {
    const fmpLimit = Math.min(max, 25);
    let url = `${baseUrl}/${chamber}-latest?page=0&limit=${fmpLimit}`;
    const headers: Record<string, string> = {};
    if (auth === 'rapidapi') {
      headers['X-RapidAPI-Key'] = apiKey;
      if (opts.rapidApiHost) headers['X-RapidAPI-Host'] = opts.rapidApiHost;
    } else {
      url += '&apikey=' + encodeURIComponent(apiKey);
    }
    try {
      // Latency-only pacer: serializes house+senate; separate from enrichment.
      await pace();
      return parseFmpDisclosureRows(chamber, await fetchJson(url, headers, fetchImpl), providerId);
    } catch (err) {
      const status = /HTTP_(\d+)/.exec((err as Error).message)?.[1];
      if (status) assertFmpTierOk(Number(status));
      if (chamber === 'executive' && status === '404') return [];
      throw err;
    }
  };
  return (await Promise.all([fetchOne('house'), fetchOne('senate')])).flat();
}

function unusualWhalesHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, 'UW-CLIENT-API-ID': '100001' };
}

async function fetchUnusualWhalesRows(apiKey: string, max: number, fetchImpl: typeof fetch): Promise<DisclosureProviderRow[]> {
  const url = `https://api.unusualwhales.com/api/congress/recent-trades?limit=${Math.min(max, 200)}`;
  return parseUnusualWhalesDisclosureRows(await fetchJson(url, unusualWhalesHeaders(apiKey), fetchImpl));
}

/**
 * Deep-match fetch: same recent-trades endpoint and parser as
 * fetchUnusualWhalesRows, anchored to one date via UW's `date` query param
 * instead of just taking the newest ~200 rows. IMPORTANT: UW's `date` param
 * filters by TRANSACTION date, not filed_at_date (verified against the live
 * API), so callers must pass a parsed transaction date from the filing, never
 * the candidate's filed_date. Used by runUnusualWhalesDeepMatch to pull
 * disclosures that have already scrolled outside the normal window. Not a
 * fork of the parsing/matching logic - only the request URL differs.
 */
async function fetchUnusualWhalesRowsForDate(
  apiKey: string,
  fetchImpl: typeof fetch,
  txDate: string,
): Promise<DisclosureProviderRow[]> {
  const url = `https://api.unusualwhales.com/api/congress/recent-trades?limit=200&date=${encodeURIComponent(txDate)}`;
  return parseUnusualWhalesDisclosureRows(await fetchJson(url, unusualWhalesHeaders(apiKey), fetchImpl));
}

async function fetchQuiverRows(apiKey: string, max: number, fetchImpl: typeof fetch): Promise<DisclosureProviderRow[]> {
  const headers = { authorization: `Token ${apiKey}`, 'Accept': 'application/json' };
  const [house, senate, trump] = await Promise.all([
    fetchJson('https://api.quiverquant.com/beta/live/housetrading?options=true', headers, fetchImpl).catch(() => []),
    fetchJson('https://api.quiverquant.com/beta/live/senatetrading?options=true', headers, fetchImpl).catch(() => []),
    fetchJson('https://api.quiverquant.com/beta/bulk/trumpstocktrades', headers, fetchImpl).catch(() => []),
  ]);
  const houseSliced = Array.isArray(house) ? house.slice(0, max) : house;
  const senateSliced = Array.isArray(senate) ? senate.slice(0, max) : senate;
  const trumpSliced = Array.isArray(trump) ? trump.slice(0, max) : trump;
  return [
    ...parseQuiverDisclosureRows('house', houseSliced),
    ...parseQuiverDisclosureRows('senate', senateSliced),
    ...parseQuiverDisclosureRows('executive', trumpSliced, 'Donald Trump')
  ];
}


function providerOnlyDocId(row: DisclosureProviderRow): string {
  const key = row.providerKey.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || simpleHash(rowText(row.payload));
  return `provider-missing-${row.provider}-${row.chamber}-${key}`;
}

async function routeProviderOnlyObservationsToReview(
  env: Env,
  provider: ProviderId,
  rows: DisclosureProviderRow[],
  nowIso: string,
): Promise<void> {
  for (const row of rows) {
    if (row.chamber !== 'house' && row.chamber !== 'senate') continue;
    const docId = providerOnlyDocId(row);
    const exists1 = await get<{ doc_id: string }>(env.DB, `SELECT doc_id FROM filings WHERE doc_id = ? LIMIT 1`, [docId]);
    if (exists1) continue;

    if (row.sourceUrl) {
      const exists2 = await get<{ doc_id: string }>(env.DB, `SELECT doc_id FROM filings WHERE source_url = ? LIMIT 1`, [row.sourceUrl]);
      if (exists2) continue;
    }

    const exists3 = await get<{ doc_id: string }>(
      env.DB,
      `SELECT doc_id FROM trade_latency_candidates WHERE provider = ? AND provider_key = ? AND status = 'matched' LIMIT 1`,
      [provider, row.providerKey]
    );
    if (exists3) continue;

    const payload = JSON.stringify({
      reason: 'provider_discovered_missing_official',
      provider,
      providerKey: row.providerKey,
      providerPublishedAt: row.providerPublishedAt,
      filedDate: row.filedDate,
      filerName: row.filerName,
      sourceUrl: row.sourceUrl,
      payload: row.payload,
    }).slice(0, PAYLOAD_LIMIT);

    await batch(env.DB, [
      [
        `INSERT OR IGNORE INTO filings
           (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
            raw_object_key, ingest_status, doc_kind, extractor, model_version,
            confidence, first_seen_at, source_updated_at, error)
         VALUES (?, ?, NULL, 'P', ?, ?, NULL, 'needs_review', 'unknown', NULL, NULL,
                 NULL, ?, ?, ?)`,
        [
          docId,
          row.chamber,
          row.filedDate,
          row.sourceUrl,
          nowIso,
          row.providerPublishedAt,
          `provider-only:${provider}:${row.providerKey}`,
        ],
      ],
      [
        `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
         VALUES (?, 'provider_discovered_missing_official', ?, ?, 0)`,
        [docId, payload, nowIso],
      ],
    ]);
  }
}


async function resolveProviderSecret(env: Env, provider: ProviderDefinition): Promise<string | null> {
  for (const name of provider.secretNames) {
    const envx = env as unknown as Record<string, string | undefined>;
    const value = (await resolveSecret(env, name as keyof Env & string)).value ?? envx[name];
    if (value?.trim()) return value.trim();
  }
  return null;
}

async function providerStatus(env: Env, provider: ProviderDefinition): Promise<DisclosureLatencyProviderStatus> {
  const configured = provider.secretNames.length === 0 || Boolean(await resolveProviderSecret(env, provider));
  const fmpProbeOn = isFmpFamilyProvider(provider.id) ? await isFmpProbeEnabled(env) : true;
  const paths = isFmpFamilyProvider(provider.id) ? await enabledFmpPathIds(env) : null;
  const pathEnabled =
    !provider.fmpPathId || !paths ? true : paths.has(provider.fmpPathId);

  let operationalStatus: LatencySourceStatus = 'unknown';
  let reason = provider.reason;
  if (isFmpFamilyProvider(provider.id) && (!fmpProbeOn || !pathEnabled)) {
    // Intentional disable — grey OFF, not red stopped.
    operationalStatus = 'off';
    reason = !fmpProbeOn
      ? 'OFF: FMP_LATENCY_PROBE_ENABLED is false/off (explicit disable)'
      : `OFF: FMP path "${provider.fmpPathId}" not in FMP_LATENCY_PATHS`;
  } else if (!provider.supportsDirectLatest) {
    operationalStatus = 'stopped';
  } else if (!configured) {
    operationalStatus = 'stopped';
    reason = reason ?? `${provider.secretNames[0] ?? 'secret'} missing`;
  } else {
    operationalStatus = 'running';
  }

  return {
    id: provider.id,
    label: provider.label,
    configured,
    requiresMembership: provider.requiresMembership,
    supportsDirectLatest: provider.supportsDirectLatest,
    timestampKind: provider.timestampKind,
    operationalStatus,
    pathId: provider.fmpPathId,
    reason,
  };
}

export async function getDisclosureLatencyProviderStatuses(env: Env): Promise<DisclosureLatencyProviderStatus[]> {
  const statuses: DisclosureLatencyProviderStatus[] = [];
  for (const provider of PROVIDERS) statuses.push(await providerStatus(env, provider));
  return statuses;
}


interface TradeLatencyTxContext {
  id: string;
  doc_id: string;
  ticker: string | null;
  tx_date: string | null;
  tx_type: string | null;
  filed_date: string | null;
  first_seen_at: string | null;
  chamber: Chamber | null;
  source_url: string | null;
  filer_name: string | null;
  source: string | null;
}

/**
 * Resolve filer name / chamber / source_url for trade-hash candidates.
 * Transaction.owner is self/spouse/joint — never the politician name.
 */
async function loadTradeLatencyTxContexts(
  env: Env,
  transactions: Transaction[],
): Promise<Map<string, TradeLatencyTxContext>> {
  const byId = new Map<string, TradeLatencyTxContext>();
  if (!transactions.length) return byId;
  const ids = Array.from(new Set(transactions.map((tx) => tx.id)));
  for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
    const chunk = ids.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all<TradeLatencyTxContext>(
      env.DB,
      `SELECT t.id, t.doc_id, t.ticker, t.tx_date, t.tx_type, t.source AS source,
              COALESCE(t.filed_date, f.filed_date) AS filed_date,
              COALESCE(t.first_seen_at, f.first_seen_at) AS first_seen_at,
              f.chamber AS chamber,
              f.source_url AS source_url,
              fil.full_name AS filer_name
         FROM transactions t
         LEFT JOIN filings f ON f.doc_id = t.doc_id
         LEFT JOIN filers fil ON fil.bioguide_id = COALESCE(t.filer_id, f.filer_id)
        WHERE t.id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) byId.set(row.id, row);
  }
  return byId;
}

export async function recordTradeLatencyCandidates(
  env: Env,
  transactions: Transaction[],
  nowIso: string,
): Promise<void> {
  if (!transactions.length) return;
  let contexts: Map<string, TradeLatencyTxContext>;
  try {
    contexts = await loadTradeLatencyTxContexts(env, transactions);
  } catch (err) {
    if (!storageMissing(err)) console.warn('trade latency context lookup failed:', (err as Error).message);
    return;
  }

  const updates: Array<[string, SqlParam[]]> = [];
  const mintedHashes = new Set<string>();
  for (const provider of DIRECT_PROVIDER_IDS) {
    for (const tx of transactions) {
      const ctx = contexts.get(tx.id);
      const filerName = ctx?.filer_name || tx.fullName || null;
      if (!filerName) continue;
      const firstSeenRaw = tx.firstSeenAt || ctx?.first_seen_at || nowIso;
      const filedDate = tx.filedDate || ctx?.filed_date || null;
      // Never mint races for seed/competitor backfills or historical crawls.
      if (
        !isLiveRaceImport({
          source: tx.source || ctx?.source,
          filedDate,
          firstSeenAt: firstSeenRaw,
        })
      ) {
        continue;
      }
      const chamber = normalizeChamber(ctx?.chamber ?? null, chamberFromDocId(tx.docId));
      const trade_hash = generateTradeHash(filerName, tx.ticker || ctx?.ticker || null, tx.txDate || ctx?.tx_date || null, tx.txType || ctx?.tx_type || null);
      if (!extractLastName(filerName)) continue;
      // Keep the real first_seen for live imports (no clamp-to-now for recent stamps).
      const firstSeen = raceFirstSeenAt(firstSeenRaw, nowIso, LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS);
      mintedHashes.add(trade_hash);
      updates.push([
        `INSERT INTO trade_latency_candidates
           (trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(trade_hash, provider) DO UPDATE SET
           doc_id = excluded.doc_id,
           chamber = excluded.chamber,
           source_url = COALESCE(trade_latency_candidates.source_url, excluded.source_url),
           filed_date = COALESCE(trade_latency_candidates.filed_date, excluded.filed_date),
           filer_name = COALESCE(trade_latency_candidates.filer_name, excluded.filer_name),
           ticker = COALESCE(trade_latency_candidates.ticker, excluded.ticker),
           tx_date = COALESCE(trade_latency_candidates.tx_date, excluded.tx_date),
           tx_type = COALESCE(trade_latency_candidates.tx_type, excluded.tx_type),
           congress_first_seen_at = CASE
             WHEN trade_latency_candidates.congress_first_seen_at IS NULL
               OR trade_latency_candidates.congress_first_seen_at = ''
               OR excluded.congress_first_seen_at < trade_latency_candidates.congress_first_seen_at
             THEN excluded.congress_first_seen_at
             ELSE trade_latency_candidates.congress_first_seen_at
           END,
           updated_at = excluded.updated_at`,
        [
          trade_hash,
          tx.docId,
          provider,
          chamber,
          ctx?.source_url || tx.sourceUrl || null,
          filedDate,
          filerName,
          tx.ticker || ctx?.ticker || null,
          tx.txDate || ctx?.tx_date || null,
          tx.txType || ctx?.tx_type || null,
          firstSeen,
          nowIso,
          nowIso,
        ],
      ]);
    }
  }
  if (updates.length > 0) {
    try {
      await batch(env.DB, updates);
    } catch (err) {
      if (!storageMissing(err)) console.warn('trade latency candidate write failed:', (err as Error).message);
      return;
    }
    // Immediate match against already-stored provider observations so a live
    // publish that a provider already listed becomes a concurrent race now,
    // rather than waiting for the next cron probe.
    try {
      await matchJustMintedCandidates(env, Array.from(mintedHashes), nowIso);
    } catch (err) {
      if (!storageMissing(err)) {
        console.warn('trade latency immediate match failed:', (err as Error).message);
      }
    }
  }
}

/**
 * After minting candidates from a live publish, try to match each new
 * trade_hash against stored provider observations. Bounded and best-effort —
 * probe still owns the full pending scan.
 */
async function matchJustMintedCandidates(
  env: Env,
  hashes: string[],
  nowIso: string,
): Promise<void> {
  if (!hashes.length) return;

  for (const provider of PROVIDERS.filter((p) => p.supportsDirectLatest)) {
    const obs: ProviderObservationRow[] = [];
    for (let i = 0; i < hashes.length; i += SQL_IN_CHUNK) {
      const chunk = hashes.slice(i, i + SQL_IN_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await all<ProviderObservationRow>(
        env.DB,
        `SELECT provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at,
                provider_published_at, source_url, filed_date, filer_name, payload
           FROM trade_provider_observations
          WHERE provider = ? AND trade_hash IN (${placeholders})`,
        [provider.id, ...chunk],
      ).catch((err) => {
        if (storageMissing(err)) return [] as ProviderObservationRow[];
        throw err;
      });
      obs.push(...rows);
    }
    if (!obs.length) continue;

    const candidates = await all<CandidateRow>(
      env.DB,
      `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
              congress_first_seen_at, attempts
         FROM trade_latency_candidates
        WHERE provider = ? AND status = 'pending'
          AND trade_hash IN (${hashes.map(() => '?').join(', ')})`,
      [provider.id, ...hashes],
    ).catch((err) => {
      if (storageMissing(err)) return [] as CandidateRow[];
      throw err;
    });
    if (!candidates.length) continue;

    const errors: string[] = [];
    await matchAndUpdateCandidates(env, provider, candidates, obs, nowIso, errors);
  }
}

/** Backfill trade-latency candidates from recent persisted transactions. */
export async function backfillTradeLatencyCandidates(
  env: Env,
  opts: { limit?: number; days?: number } = {},
): Promise<{ scanned: number; recorded: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 10000);
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await all<{
    id: string;
    doc_id: string;
    ticker: string | null;
    tx_date: string | null;
    tx_type: string | null;
    filed_date: string | null;
    first_seen_at: string | null;
    created_at: string | null;
    full_name: string | null;
    source_url: string | null;
    chamber: string | null;
    source: string | null;
  }>(
    env.DB,
    `SELECT t.id, t.doc_id, t.ticker, t.tx_date, t.tx_type, t.source AS source,
            COALESCE(t.filed_date, f.filed_date) AS filed_date,
            COALESCE(t.first_seen_at, f.first_seen_at, t.created_at) AS first_seen_at,
            t.created_at AS created_at,
            fil.full_name AS full_name,
            f.source_url AS source_url,
            f.chamber AS chamber
       FROM transactions t
       LEFT JOIN filings f ON f.doc_id = t.doc_id
       LEFT JOIN filers fil ON fil.bioguide_id = COALESCE(t.filer_id, f.filer_id)
      WHERE t.ticker IS NOT NULL
        AND t.tx_date IS NOT NULL
        AND fil.full_name IS NOT NULL
        AND t.source NOT IN ('seed_dataset', 'competitor_backfill')
        AND t.deprecated_at IS NULL
        AND COALESCE(t.created_at, f.first_seen_at) >= ?
      ORDER BY COALESCE(t.created_at, f.first_seen_at) DESC
      LIMIT ?`,
    [cutoff, limit],
  );
  const nowIso = new Date().toISOString();
  const asTx: Transaction[] = [];
  for (const row of rows) {
    const seen = row.first_seen_at || row.created_at || nowIso;
    const created = row.created_at || nowIso;
    const firstSeenAt = seen > created ? seen : created;
    if (
      !isLiveRaceImport({
        source: row.source,
        filedDate: row.filed_date,
        firstSeenAt,
      })
    ) {
      continue;
    }
    asTx.push({
      id: row.id,
      docId: row.doc_id,
      filerId: null,
      txDate: row.tx_date,
      owner: null,
      assetName: '',
      ticker: row.ticker,
      assetType: null,
      txType: (row.tx_type as Transaction['txType']) || 'E',
      amountMin: null,
      amountMax: null,
      isOption: false,
      capGainsOver200: false,
      rawText: '',
      confidence: 1,
      source: (row.source as Transaction['source']) || 'primary',
      createdAt: nowIso,
      cursorSeq: 0,
      fullName: row.full_name,
      filedDate: row.filed_date,
      firstSeenAt,
      sourceUrl: row.source_url,
    });
  }
  await recordTradeLatencyCandidates(env, asTx, nowIso);
  return { scanned: rows.length, recorded: asTx.length };
}


async function upsertProviderRows(env: Env, provider: ProviderId, rows: DisclosureProviderRow[], nowIso: string): Promise<void> {
  for (const row of rows) {
    await run(
      env.DB,
      `INSERT INTO trade_provider_observations
         (provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at,
          provider_published_at, source_url, filed_date, filer_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, chamber, provider_key, trade_hash) DO UPDATE SET
         last_observed_at=excluded.last_observed_at,
         provider_published_at=COALESCE(trade_provider_observations.provider_published_at, excluded.provider_published_at),
         source_url=COALESCE(trade_provider_observations.source_url, excluded.source_url),
         filed_date=COALESCE(trade_provider_observations.filed_date, excluded.filed_date),
         filer_name=COALESCE(trade_provider_observations.filer_name, excluded.filer_name),
         payload=COALESCE(trade_provider_observations.payload, excluded.payload)`,
      [
        provider,
        row.chamber,
        row.providerKey,
        row.tradeHash,
        nowIso,
        nowIso,
        row.providerPublishedAt,
        row.sourceUrl,
        row.filedDate,
        row.filerName,
        JSON.stringify(row.payload).slice(0, PAYLOAD_LIMIT),
      ],
    );
  }
}

function deltaSeconds(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 1000) : null;
}

async function alertMatch(env: Env, provider: ProviderDefinition, candidate: CandidateRow, match: ProviderObservationRow): Promise<void> {
  const deltaSec = deltaSeconds(match.first_observed_at, candidate.congress_first_seen_at);
  const direction =
    deltaSec == null
      ? 'Delta unavailable'
      : deltaSec > 0
        ? `congress.trade observed it ${deltaSec}s before ${provider.label} was first observed by this monitor.`
        : deltaSec < 0
          ? `${provider.label} was already observed ${Math.abs(deltaSec)}s before congress.trade first saw it.`
          : `congress.trade and ${provider.label} were observed in the same second.`;
  const published =
    match.provider_published_at && deltaSeconds(match.provider_published_at, candidate.congress_first_seen_at) != null
      ? `\n${provider.label} provider timestamp: ${match.provider_published_at}`
      : '';
  await notifyAdmin(env, {
    dedupeKey: `disclosure-latency:${provider.id}:${candidate.trade_hash}`,
    throttleSec: 30 * 24 * 60 * 60,
    subject: `Congress.Trade vs ${provider.label} disclosure latency`,
    text:
      `${direction}\n\n` +
      `Doc: ${candidate.trade_hash}\n` +
      `Chamber: ${candidate.chamber}\n` +
      `congress.trade first_seen_at: ${candidate.congress_first_seen_at}\n` +
      `${provider.label} monitor first_observed_at: ${match.first_observed_at}${published}\n` +
      `${provider.label} key: ${match.provider_key}\n` +
      `Source URL: ${candidate.source_url ?? 'n/a'}\n`,
  });
}

async function loadProviderRows(env: Env, provider: ProviderId, now: Date): Promise<ProviderObservationRow[]> {
  const cutoff = new Date(now.getTime() - RECENT_PROVIDER_HOURS * 60 * 60 * 1000).toISOString();
  return all<ProviderObservationRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, first_observed_at, last_observed_at, provider_published_at,
            trade_hash, source_url, filed_date, filer_name, payload
       FROM trade_provider_observations
      WHERE provider = ? AND first_observed_at >= ?
      ORDER BY first_observed_at DESC
      LIMIT 1000`,
    [provider, cutoff],
  );
}

/**
 * For recent provider observations that have no race candidate yet, find
 * matching **live** CT transactions and seed candidates. Caps work per probe.
 * Never seeds seed_dataset / competitor_backfill / historical crawls.
 */
async function seedCandidatesFromRecentObservations(
  env: Env,
  provider: ProviderId,
  now: Date,
  nowIso: string,
): Promise<{ seeded: number }> {
  const obs = await loadProviderRows(env, provider, now);
  if (!obs.length) return { seeded: 0 };
  // CT live imports from the scoreboard window (7d of new live first_seen).
  const scoreCutoffMs = now.getTime() - LATENCY_SCORE_WINDOW_HOURS * 3600_000;

  const txs: Transaction[] = [];
  const seen = new Set<string>();
  let examined = 0;
  for (const row of obs) {
    if (examined >= 250) break;
    const parts = parseTradeHash(row.trade_hash);
    if (!parts.lastName || !parts.date) continue;
    examined++;

    // Skip when a candidate already exists for this hash+provider.
    const existing = await get<{ trade_hash: string }>(
      env.DB,
      `SELECT trade_hash FROM trade_latency_candidates
        WHERE provider = ? AND trade_hash = ? LIMIT 1`,
      [provider, row.trade_hash],
    ).catch(() => null);
    if (existing) continue;

    const like = `%${parts.lastName}%`;
    const ticker = parts.ticker || null;
    const rows = await all<{
      id: string;
      doc_id: string;
      ticker: string | null;
      tx_date: string | null;
      tx_type: string | null;
      created_at: string | null;
      first_seen_at: string | null;
      full_name: string | null;
      source_url: string | null;
      chamber: string | null;
      filed_date: string | null;
      source: string | null;
    }>(
      env.DB,
      `SELECT t.id, t.doc_id, t.ticker, t.tx_date, t.tx_type, t.created_at, t.source AS source,
              COALESCE(t.first_seen_at, f.first_seen_at, t.created_at) AS first_seen_at,
              fil.full_name AS full_name, f.source_url AS source_url,
              f.chamber AS chamber, COALESCE(t.filed_date, f.filed_date) AS filed_date
         FROM transactions t
         LEFT JOIN filings f ON f.doc_id = t.doc_id
         LEFT JOIN filers fil ON fil.bioguide_id = COALESCE(t.filer_id, f.filer_id)
        WHERE t.deprecated_at IS NULL
          AND t.source NOT IN ('seed_dataset', 'competitor_backfill')
          AND t.tx_date = ?
          AND fil.full_name IS NOT NULL
          AND lower(fil.full_name) LIKE ?
          AND (? IS NULL OR upper(replace(COALESCE(t.ticker,''), '.', '-')) = ?)
        ORDER BY t.created_at DESC
        LIMIT 5`,
      [parts.date, like, ticker, ticker],
    ).catch(() => [] as Array<{
      id: string;
      doc_id: string;
      ticker: string | null;
      tx_date: string | null;
      tx_type: string | null;
      created_at: string | null;
      first_seen_at: string | null;
      full_name: string | null;
      source_url: string | null;
      chamber: string | null;
      filed_date: string | null;
      source: string | null;
    }>);

    for (const r of rows) {
      if (seen.has(r.id)) continue;
      // Confirm last-name extract matches (LIKE can over-match "Scott").
      if (extractLastName(r.full_name) !== parts.lastName) continue;
      if (parts.side) {
        const side = normalizeTradeSide(r.tx_type);
        if (side !== parts.side) continue;
      }
      const rawSeen = r.first_seen_at || r.created_at;
      const rawMs = rawSeen ? Date.parse(rawSeen) : NaN;
      if (!Number.isFinite(rawMs) || rawMs < scoreCutoffMs) continue;
      if (
        !isLiveRaceImport({
          source: r.source,
          filedDate: r.filed_date,
          firstSeenAt: rawSeen,
        })
      ) {
        continue;
      }
      seen.add(r.id);
      const firstSeen = raceFirstSeenAt(rawSeen, nowIso, LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS);
      txs.push({
        id: r.id,
        docId: r.doc_id,
        filerId: null,
        txDate: r.tx_date,
        owner: null,
        assetName: '',
        ticker: r.ticker,
        assetType: null,
        txType: (r.tx_type as Transaction['txType']) || 'E',
        amountMin: null,
        amountMax: null,
        isOption: false,
        capGainsOver200: false,
        rawText: '',
        confidence: 1,
        source: (r.source as Transaction['source']) || 'primary',
        createdAt: nowIso,
        cursorSeq: 0,
        fullName: r.full_name,
        filedDate: r.filed_date,
        firstSeenAt: firstSeen,
        sourceUrl: r.source_url,
      });
    }
  }

  if (txs.length) await recordTradeLatencyCandidates(env, txs, nowIso);
  return { seeded: txs.length };
}

/**
 * Matches a given set of candidates against a given set of already-loaded
 * provider observation rows, applying the same status/attempts/backoff
 * bookkeeping and match alert regardless of which pass (normal window or
 * deep-match) produced the candidate/row sets. This is the single place
 * that owns the match-loop + DB-update shape so the deep-match pass never
 * forks the matching algorithm - it just supplies a different candidate
 * list and provider-row set.
 */
async function matchAndUpdateCandidates(
  env: Env,
  provider: ProviderDefinition,
  candidates: CandidateRow[],
  providerRows: ProviderObservationRow[],
  nowIso: string,
  errors: string[],
): Promise<{ pending: number; matched: number; matchedTradeHashes: string[] }> {
  let matched = 0;
  const matchedTradeHashes: string[] = [];
  const updates: Array<[string, SqlParam[]]> = [];
  const alerts: Array<() => Promise<void>> = [];

  // Index observations by trade_hash for O(1) exact hits. Historical bulk
  // candidate backfills used to starve exact matches when we only scanned the
  // newest 100 pending rows against a linear observation list.
  const byHash = new Map<string, ProviderObservationRow[]>();
  for (const row of providerRows) {
    if (!row.trade_hash) continue;
    const list = byHash.get(row.trade_hash) ?? [];
    list.push(row);
    byHash.set(row.trade_hash, list);
  }

  for (const candidate of candidates) {
    let match: ProviderObservationRow | null = null;
    let method: string | null = null;

    // 1) Exact trade-hash hit — no payload required. Chamber is NOT required:
    // providers often mis-tag house/senate while the trade identity is the same.
    const exactList = byHash.get(candidate.trade_hash) ?? [];
    const exact =
      exactList.find((row) => row.chamber === candidate.chamber) ?? exactList[0] ?? null;
    if (exact) {
      match = exact;
      method = 'trade-hash';
    }

    // 2) Fuzzy fallbacks still need a payload to re-parse the provider row.
    // Prefer same-chamber rows, then any chamber (same trade-hash family).
    if (!match) {
      const ordered = [
        ...providerRows.filter((r) => r.chamber === candidate.chamber),
        ...providerRows.filter((r) => r.chamber !== candidate.chamber),
      ];
      for (const providerRow of ordered) {
        if (!providerRow.payload) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(providerRow.payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        const parsed: DisclosureProviderRow = {
          provider: providerRow.provider,
          chamber: providerRow.chamber,
          providerKey: providerRow.provider_key,
          tradeHash: providerRow.trade_hash,
          payload,
          sourceUrl: providerRow.source_url,
          filedDate: providerRow.filed_date,
          filerName: providerRow.filer_name,
          providerPublishedAt: providerRow.provider_published_at,
        };
        const m = matchDisclosureCandidate(candidate, parsed);
        if (m) {
          match = providerRow;
          method = m.matchMethod;
          break;
        }
      }
    }

    if (match) {
      updates.push([
        `UPDATE trade_latency_candidates
            SET status = 'matched',
                provider_key = ?,
                provider_first_seen_at = ?,
                provider_published_at = ?,
                match_method = ?,
                payload = ?,
                attempts = attempts + 1,
                last_checked_at = ?,
                error = NULL,
                updated_at = ?
          WHERE trade_hash = ? AND provider = ? AND status = 'pending'`,
        [
          match.provider_key,
          match.first_observed_at,
          match.provider_published_at,
          method,
          match.payload,
          nowIso,
          nowIso,
          candidate.trade_hash,
          provider.id,
        ],
      ]);
      matched++;
      matchedTradeHashes.push(candidate.trade_hash);
      const m = match;
      alerts.push(() => alertMatch(env, provider, candidate, m));
    } else {
      updates.push([
        `UPDATE trade_latency_candidates
            SET attempts = attempts + 1, last_checked_at = ?, updated_at = ?, error = ?
          WHERE trade_hash = ? AND provider = ?`,
        [nowIso, nowIso, errors[0] ?? null, candidate.trade_hash, provider.id],
      ]);
    }
  }

  if (updates.length > 0) {
    await batch(env.DB, updates);
  }
  for (const alertFn of alerts) {
    await alertFn();
  }

  return { pending: candidates.length, matched, matchedTradeHashes };
}

/**
 * SQL join: every pending candidate that already has an exact trade_hash
 * observation for the same provider. Chamber is intentionally not required —
 * UW/QQ often mislabel chamber while the hash identity is correct. Prefer
 * same-chamber rows via ORDER BY, then fall back to any chamber.
 * Dedupes to one observation per trade_hash (earliest first_observed_at).
 */
async function loadExactPendingHashMatches(
  env: Env,
  provider: ProviderId,
  limit = 800,
): Promise<Array<CandidateRow & {
  obs_provider_key: string;
  obs_first_observed_at: string;
  obs_provider_published_at: string | null;
  obs_payload: string | null;
}>> {
  return all(
    env.DB,
    `SELECT c.trade_hash, c.doc_id, c.provider, c.chamber, c.source_url, c.filed_date,
            c.filer_name, c.ticker, c.tx_date, c.tx_type, c.congress_first_seen_at, c.attempts,
            o.provider_key AS obs_provider_key,
            o.first_observed_at AS obs_first_observed_at,
            o.provider_published_at AS obs_provider_published_at,
            o.payload AS obs_payload
       FROM trade_latency_candidates c
       JOIN trade_provider_observations o
         ON o.provider = c.provider
        AND o.trade_hash = c.trade_hash
      WHERE c.provider = ?
        AND c.status = 'pending'
        AND c.trade_hash IS NOT NULL
        AND c.trade_hash != ''
      ORDER BY CASE WHEN o.chamber = c.chamber THEN 0 ELSE 1 END,
               o.first_observed_at ASC
      LIMIT ?`,
    [provider, limit],
  );
}

async function applyExactHashMatches(
  env: Env,
  provider: ProviderDefinition,
  nowIso: string,
): Promise<{ matched: number; matchedTradeHashes: string[] }> {
  const rows = await loadExactPendingHashMatches(env, provider.id);
  if (!rows.length) return { matched: 0, matchedTradeHashes: [] };

  const updates: Array<[string, SqlParam[]]> = [];
  const matchedTradeHashes: string[] = [];
  const alerts: Array<() => Promise<void>> = [];
  const seenHash = new Set<string>();

  for (const row of rows) {
    // JOIN can return multiple obs per hash (chamber variants); take first
    // after ORDER BY (same-chamber preferred, earliest obs).
    if (seenHash.has(row.trade_hash)) continue;
    seenHash.add(row.trade_hash);
    updates.push([
      `UPDATE trade_latency_candidates
          SET status = 'matched',
              provider_key = ?,
              provider_first_seen_at = ?,
              provider_published_at = ?,
              match_method = 'trade-hash',
              payload = ?,
              attempts = attempts + 1,
              last_checked_at = ?,
              error = NULL,
              updated_at = ?
        WHERE trade_hash = ? AND provider = ? AND status = 'pending'`,
      [
        row.obs_provider_key,
        row.obs_first_observed_at,
        row.obs_provider_published_at,
        row.obs_payload,
        nowIso,
        nowIso,
        row.trade_hash,
        provider.id,
      ],
    ]);
    matchedTradeHashes.push(row.trade_hash);
    const candidate: CandidateRow = {
      trade_hash: row.trade_hash,
      doc_id: row.doc_id,
      provider: row.provider,
      chamber: row.chamber,
      source_url: row.source_url,
      filed_date: row.filed_date,
      filer_name: row.filer_name,
      ticker: row.ticker,
      tx_date: row.tx_date,
      tx_type: row.tx_type,
      congress_first_seen_at: row.congress_first_seen_at,
      attempts: row.attempts,
    };
    const obs: ProviderObservationRow = {
      provider: provider.id,
      chamber: row.chamber,
      provider_key: row.obs_provider_key,
      trade_hash: row.trade_hash,
      first_observed_at: row.obs_first_observed_at,
      last_observed_at: row.obs_first_observed_at,
      provider_published_at: row.obs_provider_published_at,
      source_url: row.source_url,
      filed_date: row.filed_date,
      filer_name: row.filer_name,
      payload: row.obs_payload,
    };
    alerts.push(() => alertMatch(env, provider, candidate, obs));
  }

  if (updates.length) await batch(env.DB, updates);
  for (const fn of alerts) await fn();
  return { matched: matchedTradeHashes.length, matchedTradeHashes };
}

async function matchPendingCandidates(
  env: Env,
  provider: ProviderDefinition,
  now: Date,
  nowIso: string,
  errors: string[],
): Promise<{ pending: number; matched: number; examinedTradeHashes: string[]; matchedTradeHashes: string[] }> {
  // Pass A: exact trade-hash SQL join across all pending (live mints only exist
  // for non-backfill imports). No chamber lock — max join density.
  const exact = await applyExactHashMatches(env, provider, nowIso);

  // Pass B: fuzzy match for recent live CT first_seen. Provider obs lookback is
  // longer (14d) so "they listed it a week before us" still matches.
  const scoreCutoff = new Date(now.getTime() - LATENCY_SCORE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const candidates = await all<CandidateRow>(
    env.DB,
    `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, attempts
       FROM trade_latency_candidates
      WHERE provider = ?
        AND status = 'pending'
        AND congress_first_seen_at >= ?
      ORDER BY congress_first_seen_at DESC
      LIMIT 800`,
    [provider.id, scoreCutoff],
  );
  // Drop any residual backfill-shaped candidates (historical crawl lag).
  const liveCandidates = candidates.filter((c) =>
    isLiveRaceImport({
      source: 'primary',
      filedDate: c.filed_date,
      firstSeenAt: c.congress_first_seen_at,
    }),
  );
  const providerRows = await loadProviderRows(env, provider.id, now);
  const fuzzy = await matchAndUpdateCandidates(env, provider, liveCandidates, providerRows, nowIso, errors);

  const matchedTradeHashes = Array.from(new Set([...exact.matchedTradeHashes, ...fuzzy.matchedTradeHashes]));
  const examined = Array.from(new Set([
    ...exact.matchedTradeHashes,
    ...liveCandidates.map((c) => c.trade_hash),
  ]));
  return {
    pending: examined.length,
    matched: matchedTradeHashes.length,
    examinedTradeHashes: examined,
    matchedTradeHashes,
  };
}

/**
 * Pull the earliest trustworthy CT first-seen for a doc from filings +
 * transactions, then write it onto matched/pending candidates when it is
 * earlier than the stored stamp. Bulk reverse-seed / backfill often stamps
 * congress_first_seen_at = now, which invents multi-day "provider ahead"
 * deltas even when CT actually ingested the filing days earlier.
 *
 * Never rewrites a stamp forward; never writes a stamp older than the score
 * window floor (keeps bulk historical re-imports out of the live race).
 */
export async function healLatencyCandidateFirstSeen(
  env: Env,
  opts: { limit?: number } = {},
): Promise<{ examined: number; healed: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 2000, 1), 10_000);
  const nowIso = new Date().toISOString();
  const scoreCutoff = new Date(Date.now() - LATENCY_SCORE_WINDOW_HOURS * 3600_000).toISOString();

  const rows = await all<{
    trade_hash: string;
    provider: string;
    doc_id: string;
    congress_first_seen_at: string;
    provider_first_seen_at: string | null;
    created_at: string | null;
  }>(
    env.DB,
    `SELECT trade_hash, provider, doc_id, congress_first_seen_at, provider_first_seen_at, created_at
       FROM trade_latency_candidates
      WHERE doc_id IS NOT NULL AND doc_id != ''
      ORDER BY updated_at DESC
      LIMIT ?`,
    [limit],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });
  if (!rows.length) return { examined: 0, healed: 0 };

  const docIds = Array.from(new Set(rows.map((r) => r.doc_id)));
  const earliestByDoc = new Map<string, string>();
  for (let i = 0; i < docIds.length; i += SQL_IN_CHUNK) {
    const chunk = docIds.slice(i, i + SQL_IN_CHUNK);
    const ph = chunk.map(() => '?').join(', ');
    const filingRows = await all<{ doc_id: string; seen: string | null }>(
      env.DB,
      `SELECT doc_id, first_seen_at AS seen FROM filings WHERE doc_id IN (${ph})`,
      chunk,
    ).catch(() => [] as Array<{ doc_id: string; seen: string | null }>);
    for (const f of filingRows) {
      if (f.seen) {
        const prev = earliestByDoc.get(f.doc_id);
        if (!prev || f.seen < prev) earliestByDoc.set(f.doc_id, f.seen);
      }
    }
    const txRows = await all<{ doc_id: string; seen: string | null }>(
      env.DB,
      `SELECT doc_id, MIN(COALESCE(first_seen_at, created_at)) AS seen
         FROM transactions
        WHERE doc_id IN (${ph}) AND deprecated_at IS NULL
        GROUP BY doc_id`,
      chunk,
    ).catch(() => [] as Array<{ doc_id: string; seen: string | null }>);
    for (const t of txRows) {
      if (t.seen) {
        const prev = earliestByDoc.get(t.doc_id);
        if (!prev || t.seen < prev) earliestByDoc.set(t.doc_id, t.seen);
      }
    }
  }

  const updates: Array<[string, SqlParam[]]> = [];
  let healed = 0;
  for (const row of rows) {
    const raw = earliestByDoc.get(row.doc_id);
    let next: string | null = null;
    if (raw && raw >= scoreCutoff && raw < row.congress_first_seen_at) {
      // Real in-window stamp earlier than bulk reverse-seed "now".
      next = raw;
    } else if (row.provider_first_seen_at && row.congress_first_seen_at) {
      // Prior bug clamped pre-window stamps to the window floor, inventing
      // multi-day CT-ahead leads (provider mid-window, CT at floor). Detect any
      // matched row where CT is "ahead" by >24h but the real filing/tx stamp is
      // pre-window (or missing) and snap CT forward to candidate created_at /
      // now so concurrent timing is not dominated by floor artifacts.
      const ctMs = Date.parse(row.congress_first_seen_at);
      const pMs = Date.parse(row.provider_first_seen_at);
      const ctAheadSec = Number.isFinite(pMs) && Number.isFinite(ctMs) ? (pMs - ctMs) / 1000 : 0;
      const realIsPreWindow = !raw || raw < scoreCutoff;
      if (ctAheadSec > 24 * 3600 && realIsPreWindow) {
        const created =
          row.created_at && Date.parse(row.created_at) >= Date.parse(scoreCutoff)
            ? row.created_at
            : nowIso;
        if (Date.parse(created) > ctMs) next = created;
      }
    }
    if (!next || next === row.congress_first_seen_at) continue;
    updates.push([
      `UPDATE trade_latency_candidates
          SET congress_first_seen_at = ?, updated_at = ?
        WHERE trade_hash = ? AND provider = ?`,
      [next, nowIso, row.trade_hash, row.provider],
    ]);
    healed++;
  }
  if (updates.length) {
    try {
      await batch(env.DB, updates);
    } catch (err) {
      if (!storageMissing(err)) throw err;
      return { examined: rows.length, healed: 0 };
    }
  }
  return { examined: rows.length, healed };
}

/**
 * One-shot density pass: heal first-seen stamps, rematch every provider's
 * pending backlog (exact + fuzzy), and reverse-seed from recent observations.
 * Safe to call from admin after matching repairs land.
 */
export async function rematchAndHealLatencyRaces(
  env: Env,
  now: Date = new Date(),
): Promise<{
  healed: number;
  matched: number;
  seeded: number;
  providers: Array<{ provider: ProviderId; matched: number; seeded: number }>;
}> {
  const nowIso = now.toISOString();
  const heal = await healLatencyCandidateFirstSeen(env, { limit: 5000 });
  let matched = 0;
  let seeded = 0;
  const providers: Array<{ provider: ProviderId; matched: number; seeded: number }> = [];
  for (const provider of PROVIDERS.filter((p) => p.supportsDirectLatest)) {
    const errors: string[] = [];
    const m = await matchPendingCandidates(env, provider, now, nowIso, errors);
    const s = await seedCandidatesFromRecentObservations(env, provider.id, now, nowIso).catch(() => ({
      seeded: 0,
    }));
    // Second match pass after seed.
    const m2 = await matchPendingCandidates(env, provider, now, nowIso, errors);
    const pMatched = m.matched + m2.matched;
    matched += pMatched;
    seeded += s.seeded;
    providers.push({ provider: provider.id, matched: pMatched, seeded: s.seeded });
  }
  // Final heal so newly matched reverse-seeds pick up real filing stamps.
  const heal2 = await healLatencyCandidateFirstSeen(env, { limit: 5000 });
  return {
    healed: heal.healed + heal2.healed,
    matched,
    seeded,
    providers,
  };
}

/**
 * Live (non-deprecated) parsed transaction dates for a set of filings, as a
 * doc_id -> sorted distinct YYYY-MM-DD list. Chunked `IN` lookups keep each
 * statement under D1's bound-parameter cap.
 */
async function loadTransactionDates(env: Env, docIds: string[]): Promise<Map<string, string[]>> {
  const byDoc = new Map<string, string[]>();
  const distinct = Array.from(new Set(docIds));
  for (let i = 0; i < distinct.length; i += SQL_IN_CHUNK) {
    const chunk = distinct.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all<{ doc_id: string; tx_date: string }>(
      env.DB,
      `SELECT DISTINCT doc_id, tx_date
         FROM transactions
        WHERE doc_id IN (${placeholders}) AND tx_date IS NOT NULL AND deprecated_at IS NULL`,
      chunk,
    );
    for (const row of rows) {
      const date = normalizeDate(row.tx_date);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const list = byDoc.get(row.doc_id) ?? [];
      if (!list.includes(date)) list.push(date);
      byDoc.set(row.doc_id, list);
    }
  }
  for (const list of byDoc.values()) list.sort();
  return byDoc;
}

/**
 * Observation rows for exactly the given provider keys, straight from the DB
 * with NO first_observed_at recency cutoff (unlike loadProviderRows). Used by
 * the deep-match pass so a just-fetched row is always matchable even when its
 * first observation predates the 72h window, and so matching sees the
 * DB-canonical first_observed_at that the upsert preserved for rows this
 * monitor had already observed - provider_first_seen_at must never be
 * inflated to "now" for a row we actually saw earlier.
 */
async function loadObservationRowsByKeys(
  env: Env,
  provider: ProviderId,
  providerKeys: string[],
): Promise<ProviderObservationRow[]> {
  const out: ProviderObservationRow[] = [];
  for (let i = 0; i < providerKeys.length; i += SQL_IN_CHUNK) {
    const chunk = providerKeys.slice(i, i + SQL_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    out.push(
      ...(await all<ProviderObservationRow>(
        env.DB,
        `SELECT provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at, provider_published_at,
                source_url, filed_date, filer_name, payload
           FROM trade_provider_observations
          WHERE provider = ? AND provider_key IN (${placeholders})`,
        [provider, ...chunk],
      )),
    );
  }
  return out;
}

/**
 * Bounded "deep match" pass for Unusual Whales. Its recent-trades feed only
 * exposes the newest ~200 rows, so a pending observation whose filing has
 * already scrolled outside that window can never match on the normal pass -
 * it would sit pending forever even after UW publishes it. This re-queries
 * recent-trades anchored to specific TRANSACTION dates (UW's `date` param
 * filters by transaction date, not filed_at_date) drawn from each stranded
 * filing's live parsed transactions, for up to `UW_DEEP_MATCH_DATES_PER_RUN`
 * distinct dates per run, and reuses matchAndUpdateCandidates for the actual
 * matching - no forked matching logic.
 *
 * Rotation: stranded candidates are visited least-recently-checked first
 * (never-checked NULLs first), so with a backlog larger than the per-run cap
 * successive runs cycle through the whole backlog instead of re-selecting the
 * same dates forever. `attempts` breaks the tie the normal pass leaves when
 * it stamps every pending row with the same last_checked_at in the same run:
 * deep-pass targets accrue an extra attempt, pushing them behind untargeted
 * rows on the next run.
 *
 * Matches found this way still get providerFirstSeenAt from the observation
 * row's DB-canonical first_observed_at (monitor-first-seen), the same honest
 * lower-bound semantics this provider already uses for its normal pass; we
 * never fabricate a provider-published timestamp from a deep-match hit.
 *
 * Only called when the normal pass's fetch already succeeded (freshRows
 * non-empty), so once a trial UW key lapses and the normal fetch starts
 * 401ing, this pass simply never runs - no extra failing calls, no extra
 * noise, silent degradation back to the normal-only behavior.
 */
async function runUnusualWhalesDeepMatch(
  env: Env,
  provider: ProviderDefinition,
  apiKey: string,
  freshRows: DisclosureProviderRow[],
  nowIso: string,
  fetchImpl: typeof fetch,
): Promise<{
  pending: number;
  matched: number;
  fetchedRows: number;
  errors: string[];
  examinedTradeHashes: string[];
  matchedTradeHashes: string[];
}> {
  const empty = {
    pending: 0,
    matched: 0,
    fetchedRows: 0,
    errors: [] as string[],
    examinedTradeHashes: [] as string[],
    matchedTradeHashes: [] as string[],
  };
  const capPerRun = await uwDeepMatchDatesPerRun(env as EnvWithWatch);
  if (capPerRun <= 0) return empty;

  const oldestFreshDate = freshRows
    .map((row) => row.filedDate)
    .filter((d): d is string => !!d)
    .sort()[0];
  if (!oldestFreshDate) return empty;

  // Still-pending UW candidates whose filed_date predates the oldest row on
  // the page we just fetched - provably outside this run's window. Ordered
  // for rotation (see the function doc comment). The EXISTS clause requires
  // at least one live parsed transaction BEFORE the scan cap applies:
  // transactionless candidates (failed/empty extractions) never receive a
  // deep attempt, so without the filter they would keep their rotation rank
  // forever and a least-recently-checked window full of them would
  // permanently starve every eligible candidate ranked behind them.
  const oldPending = await all<CandidateRow>(
    env.DB,
    `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, attempts
       FROM trade_latency_candidates c
      WHERE c.provider = ? AND c.status = 'pending' AND c.filed_date IS NOT NULL AND c.filed_date < ?
        AND EXISTS (SELECT 1 FROM transactions t
                     WHERE t.doc_id = c.doc_id AND t.tx_date IS NOT NULL AND t.deprecated_at IS NULL)
      ORDER BY c.last_checked_at ASC, c.attempts ASC, c.filed_date ASC
      LIMIT ?`,
    [provider.id, oldestFreshDate, UW_DEEP_MATCH_CANDIDATE_LIMIT],
  );
  if (!oldPending.length) return empty;

  // UW's `date` filter selects by transaction date, so the fetch targets are
  // the stranded filings' parsed transaction dates - never their filed_date.
  const txDatesByDoc = await loadTransactionDates(env, oldPending.map((c) => c.doc_id));

  // Walk candidates in rotation order, accumulating distinct transaction
  // dates until the per-run cap is reached. A candidate is targeted when at
  // least one of its transaction dates gets fetched this run (any row from
  // the filing can match it, whichever date page the row appears on).
  const targetDates: string[] = [];
  const targetDateSet = new Set<string>();
  const targetCandidates: CandidateRow[] = [];
  for (const candidate of oldPending) {
    // A filing with no live parsed transactions has no transaction dates to
    // anchor a deep fetch on - and with no rows on any date page it could
    // never row-match - so skip it rather than burn a trial call on a
    // wrong-date page. The candidate query's EXISTS clause already excludes
    // these; this in-loop skip is belt-and-suspenders for transactions
    // deprecated between the two queries.
    const txDates = txDatesByDoc.get(candidate.trade_hash) ?? [];
    if (!txDates.length) continue;
    for (const date of txDates) {
      if (targetDateSet.has(date) || targetDateSet.size >= capPerRun) continue;
      targetDateSet.add(date);
      targetDates.push(date);
    }
    if (txDates.some((date) => targetDateSet.has(date))) targetCandidates.push(candidate);
  }
  if (!targetDates.length) return empty;

  const errors: string[] = [];
  let fetchedRows = 0;
  const fetchedKeys = new Set<string>();
  for (const date of targetDates) {
    try {
      const rows = await fetchUnusualWhalesRowsForDate(apiKey, fetchImpl, date);
      fetchedRows += rows.length;
      await upsertProviderRows(env, provider.id, rows, nowIso);
      for (const row of rows) fetchedKeys.add(row.providerKey);
    } catch (err) {
      // A single date's failure (401/403/429/5xx, e.g. a lapsed trial key)
      // must not abort the rest of the deep-match dates or the outer probe;
      // it flows into the same attempt/error bookkeeping as a normal miss.
      errors.push((err as Error).message);
    }
  }

  // Match against the post-upsert DB rows for exactly the keys the deep
  // fetches returned: no 72h first_observed_at cutoff (a just-fetched row
  // must be matchable even when this monitor first saw it long ago), and the
  // DB-canonical first_observed_at rides along so provider_first_seen_at is
  // never inflated to nowIso for a previously observed row.
  const providerRows = await loadObservationRowsByKeys(env, provider.id, Array.from(fetchedKeys));
  const result = await matchAndUpdateCandidates(env, provider, targetCandidates, providerRows, nowIso, errors);
  await routeProviderOnlyObservationsToReview(
    env,
    provider.id,
    providerRows.map((providerRow) => ({
      provider: providerRow.provider,
      chamber: providerRow.chamber,
      providerKey: providerRow.provider_key,
      tradeHash: providerRow.trade_hash,
      payload: providerRow.payload ? (JSON.parse(providerRow.payload) as Record<string, unknown>) : {},
      sourceUrl: providerRow.source_url,
      filedDate: providerRow.filed_date,
      filerName: providerRow.filer_name,
      providerPublishedAt: providerRow.provider_published_at,
    })),
    nowIso,
  );
  return { ...result, fetchedRows, errors, examinedTradeHashes: targetCandidates.map((c) => c.doc_id) };
}

async function runProviderProbe(
  env: Env,
  provider: ProviderDefinition,
  now: Date,
  fetchImpl: typeof fetch,
  max: number,
  opts: { force?: boolean } = {},
): Promise<DisclosureLatencyProviderRun> {
  const base = await providerStatus(env, provider);
  const errors: string[] = [];
  if (!provider.supportsDirectLatest || !provider.fetchRows) {
    return { ...base, enabled: false, fetchedRows: 0, pending: 0, matched: 0, errors };
  }

  // FMP family: skip HTTP when explicitly OFF (FMP_LATENCY_PROBE_ENABLED=false)
  // or path filtered out of FMP_LATENCY_PATHS. Default is ON for CT.
  if (isFmpFamilyProvider(provider.id) && base.operationalStatus === 'off') {
    return {
      ...base,
      enabled: false,
      fetchedRows: 0,
      pending: 0,
      matched: 0,
      errors,
    };
  }

  const nowIso = now.toISOString();
  const isFmpFamily = isFmpFamilyProvider(provider.id);
  const isFmpStable = provider.id === 'fmp';
  const isUnusualWhales = provider.id === 'unusual_whales';
  const envx = env as EnvWithWatch;
  let fetchedRows = 0;
  let freshRows: DisclosureProviderRow[] = [];
  let apiKey: string | null = null;
  let fmpSelection: FmpLatencyKeySelection | null = null;

  // FMP free-tier keys are latency-only (owner 2026-08): dual keys with
  // independent daily counters + ET-weighted spacing. Never use FMP_API_KEY
  // here and never touch the enrichment/prices shared fmp:calls counter.
  let capSkipped = false;
  if (isFmpFamily) {
    // RapidAPI may use a dedicated key; otherwise share dual latency keys.
    if (provider.id === 'fmp_rapidapi') {
      const rapid =
        (await resolveSecret(env, 'FMP_RAPIDAPI_KEY')).value ?? envx.FMP_RAPIDAPI_KEY;
      if (rapid?.trim()) {
        apiKey = rapid.trim();
      }
    }
    if (!apiKey) {
      fmpSelection = await selectFmpLatencyKey(env, now, { force: opts.force });
      if (!fmpSelection) {
        const anyKey = await resolveProviderSecret(env, provider);
        if (!anyKey) {
          return {
            ...base,
            configured: false,
            enabled: false,
            operationalStatus: 'stopped',
            fetchedRows: 0,
            pending: 0,
            matched: 0,
            errors,
            reason: `${FMP_LATENCY_KEY_PRIMARY} / ${FMP_LATENCY_KEY_SECONDARY} missing`,
          };
        }
        capSkipped = true;
        errors.push(
          'FMP latency keys at daily cap or spacing interval; skipped latest fetch (DB re-match still runs)',
        );
      } else {
        apiKey = fmpSelection.apiKey;
        // Reserve full house+senate batch on this key's counter before HTTP.
        await addFmpLatencyUsed(env, fmpSelection.slot, FMP_LATENCY_CALLS_PER_RUN, now);
      }
    }
  } else {
    apiKey = await resolveProviderSecret(env, provider);
    if (!apiKey) {
      return {
        ...base,
        configured: false,
        enabled: false,
        operationalStatus: 'stopped',
        fetchedRows: 0,
        pending: 0,
        matched: 0,
        errors,
        reason: `${provider.secretNames[0]} missing`,
      };
    }
  }

  if (!capSkipped && apiKey) {
    let fmpCallsMade = 0;
    // Dedicated latency pacer — do not share enrichment getSharedFmpPacer state
    // with free keys (avoids coupling to enrichment cadence). Simple serial wait.
    let lastFmpCallMs = 0;
    const FMP_LATENCY_MIN_GAP_MS = 350;
    const pace = isFmpFamily
      ? async () => {
          fmpCallsMade++;
          const wait = Math.max(0, lastFmpCallMs + FMP_LATENCY_MIN_GAP_MS - Date.now());
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          lastFmpCallMs = Date.now();
        }
      : undefined;
    try {
      let fetchOpts: FetchFmpRowsOpts | undefined;
      if (isFmpFamily && provider.fmpPathId) {
        const pathDef = FMP_LATENCY_PATHS.find((p) => p.pathId === provider.fmpPathId)!;
        const runtime = await resolveFmpPathRuntime(env, pathDef);
        fetchOpts = {
          baseUrl: runtime.baseUrl,
          auth: pathDef.auth,
          rapidApiHost: runtime.rapidApiHost,
          providerId: provider.id,
        };
      }
      const rows = await provider.fetchRows(apiKey, max, fetchImpl, pace, fetchOpts);
      fetchedRows = rows.length;
      freshRows = rows;
      await upsertProviderRows(env, provider.id, rows, nowIso);
      if (fmpSelection && isFmpStable) {
        await setLastPollAt(env, fmpLatencyPollSource(fmpSelection.slot), now);
      } else if (fmpSelection) {
        await setLastPollAt(env, fmpLatencyPollSource(fmpSelection.slot), now);
      }
    } catch (err) {
      errors.push((err as Error).message);
    } finally {
      if (fmpSelection) {
        const overReserved = FMP_LATENCY_CALLS_PER_RUN - fmpCallsMade;
        if (overReserved > 0) await addFmpLatencyUsed(env, fmpSelection.slot, -overReserved, now);
      }
    }
  }

  try {
    // Repair bulk-seed first_seen stamps before matching so concurrent races
    // use the real CT ingest time when available.
    await healLatencyCandidateFirstSeen(env, { limit: 1500 }).catch((err) => {
      if (!storageMissing(err)) errors.push(`heal-first-seen: ${(err as Error).message}`);
    });

    // Pull CT rows that overlap recent provider observations into the race
    // table so reverse-direction coverage can grow (provider saw it first).
    await seedCandidatesFromRecentObservations(env, provider.id, now, nowIso).catch((err) => {
      if (!storageMissing(err)) errors.push(`seed-from-obs: ${(err as Error).message}`);
    });

    const matched = await matchPendingCandidates(env, provider, now, nowIso, errors);
    let totalFetchedRows = fetchedRows;
    let totalPending = matched.pending;
    let totalMatched = matched.matched;

    // UW's recent-trades page is capped at ~200 rows, so pending observations
    // older than that window can never match here. Only worth attempting once
    // the normal fetch actually returned rows to anchor a window against -
    // when a lapsed trial key makes that fetch 401 (freshRows stays empty),
    // this is skipped, degrading silently back to the normal-only behavior.
    if (isUnusualWhales && freshRows.length) {
      const deep = await runUnusualWhalesDeepMatch(env, provider, apiKey, freshRows, nowIso, fetchImpl);
      totalFetchedRows += deep.fetchedRows;
      totalMatched += deep.matched;
      errors.push(...deep.errors);
      // De-duplicated pending count across both passes: a stranded candidate
      // can appear in the normal pass's newest-100 page AND in the deep
      // pass's target set, and either pass may have just matched it, so
      // summing the two per-pass pending counts would double-count. Count
      // each distinct examined candidate once and subtract everything
      // matched this run.
      const examined = new Set([...matched.examinedTradeHashes, ...deep.examinedTradeHashes]);
      const matchedIds = new Set([...matched.matchedTradeHashes, ...deep.matchedTradeHashes]);
      totalPending = examined.size - matchedIds.size;
    }

    if (freshRows.length) {
      await routeProviderOnlyObservationsToReview(env, provider.id, freshRows, nowIso);
    }

    const operationalStatus: LatencySourceStatus =
      errors.length > 0 ? 'error' : 'running';
    return {
      ...base,
      configured: true,
      enabled: true,
      operationalStatus,
      fetchedRows: totalFetchedRows,
      pending: totalPending,
      matched: totalMatched,
      errors,
    };
  } catch (err) {
    if (storageMissing(err)) {
      return {
        ...base,
        configured: true,
        enabled: true,
        operationalStatus: 'error',
        fetchedRows,
        pending: 0,
        matched: 0,
        errors,
        reason: 'latency tables missing; run /api/admin/migrate',
      };
    }
    throw err;
  }
}

/** KV key for non-FMP provider probe cadence (UW/Quiver). FMP keys use
 *  fmp-disclosure-latency-key{1,2} with adaptive spacing. */
const PROBE_POLL_SOURCE = 'disclosure-latency-providers';
/**
 * Cron may fire every minute. Non-FMP providers (UW/Quiver) throttle here.
 * FMP free-tier keys self-throttle via selectFmpLatencyKey (per-key budget +
 * ET-weighted interval) so we never share enrichment counters or burn 250/day.
 */
const MIN_PROBE_INTERVAL_SEC = 60;

export async function runDisclosureLatencyProbe(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean; providers?: string[] } = {},
): Promise<DisclosureLatencyProbeResult> {
  const envx = env as EnvWithWatch;
  if (!opts.force && !(await enabled(envx))) {
    return {
      enabled: false,
      reason: 'DISCLOSURE_LATENCY_WATCH_ENABLED is not true',
      fetchedRows: 0,
      pending: 0,
      matched: 0,
      errors: [],
      providers: [],
    };
  }

  if (!opts.force) {
    const lastPolledAt = await getLastPollAt(env, PROBE_POLL_SOURCE);
    if (lastPolledAt && now.getTime() - lastPolledAt.getTime() < MIN_PROBE_INTERVAL_SEC * 1000) {
      return {
        enabled: true,
        reason: `throttled: non-FMP providers run at most every ${MIN_PROBE_INTERVAL_SEC}s`,
        fetchedRows: 0,
        pending: 0,
        matched: 0,
        errors: [],
        providers: [],
      };
    }
  }

  const runs: DisclosureLatencyProviderRun[] = [];
  const max = await limit(envx);
  for (const providerId of await requestedProviderIds(envx, opts)) {
    runs.push(await runProviderProbe(env, definition(providerId), now, fetchImpl, max, { force: opts.force }));
  }
  await setLastPollAt(env, PROBE_POLL_SOURCE, now);
  return {
    enabled: true,
    fetchedRows: runs.reduce((sum, r) => sum + r.fetchedRows, 0),
    pending: runs.reduce((sum, r) => sum + r.pending, 0),
    matched: runs.reduce((sum, r) => sum + r.matched, 0),
    errors: runs.flatMap((r) => r.errors.map((err) => `${r.id}: ${err}`)),
    providers: runs,
  };
}

export async function runFmpDisclosureLatencyProbe(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean } = {},
): Promise<DisclosureLatencyProbeResult> {
  // Probe entire FMP family (stable + RapidAPI) so dual paths can race when ON.
  return runDisclosureLatencyProbe(env, now, fetchImpl, {
    ...opts,
    providers: [...FMP_FAMILY_PROVIDER_IDS],
  });
}

/** Export registry snapshot for admin/scout consumers (no secrets). */
export function listFmpLatencyPathRegistry(): Array<{
  pathId: FmpLatencyPathId;
  providerId: ProviderId;
  label: string;
  defaultBaseUrl: string;
  auth: 'query' | 'rapidapi';
  defaultStatus: 'off';
}> {
  return FMP_LATENCY_PATHS.map((p) => ({
    pathId: p.pathId,
    providerId: p.providerId,
    label: p.label,
    defaultBaseUrl: p.defaultBaseUrl,
    auth: p.auth,
    defaultStatus: 'off' as const,
  }));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function p90(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
}

/** Earliest parseable ISO timestamp among candidates (null if none). */
export function earliestIso(...vals: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const v of vals) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = v;
  }
  return best;
}

/**
 * Timestamp used for scoreboard lead/lag for a matched race.
 * Provider-kind feeds prefer their own stamp, then fall back to monitor first-seen
 * so missing Quiver_Upload_Time (etc.) does not produce matched=N with empty lead stats.
 */
export function effectiveRaceProviderTime(
  timestampKind: 'provider' | 'monitor' | 'none',
  row: { provider_published_at?: string | null; provider_first_seen_at?: string | null },
): string | null {
  if (timestampKind === 'provider') {
    return row.provider_published_at || row.provider_first_seen_at || null;
  }
  if (timestampKind === 'monitor') {
    return row.provider_first_seen_at || null;
  }
  return null;
}

const STRONG_MATCH_METHODS = new Set([
  'trade-hash',
  'fuzzy-no-ticker',
  'fuzzy-missing-date',
  'fuzzy-near-date',
]);

type LatencyCandidateSummaryRow = {
  provider: ProviderId;
  trade_hash: string | null;
  status: string;
  chamber: Chamber;
  provider_key: string | null;
  match_method: string | null;
  congress_first_seen_at: string;
  provider_first_seen_at: string | null;
  provider_published_at: string | null;
  filed_date: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Collapse FMP stable + RapidAPI candidate rows into one race per trade_hash.
 * Provider first-seen / published = earliest observation across either path.
 */
export function mergeFmpFamilyCandidateRows(
  rows: LatencyCandidateSummaryRow[],
): LatencyCandidateSummaryRow[] {
  const byHash = new Map<string, LatencyCandidateSummaryRow[]>();
  for (const row of rows) {
    if (!isFmpFamilyProvider(row.provider)) continue;
    const key = row.trade_hash || `${row.chamber}:${row.provider_key || row.created_at}`;
    const list = byHash.get(key);
    if (list) list.push(row);
    else byHash.set(key, [row]);
  }
  const out: LatencyCandidateSummaryRow[] = [];
  for (const group of byHash.values()) {
    const matched = group.filter(
      (r) => r.status === 'matched' && r.match_method && STRONG_MATCH_METHODS.has(r.match_method),
    );
    const pickFrom = matched.length ? matched : group;
    // Prefer a matched row as the identity base; always take earliest provider stamps.
    const base = pickFrom.reduce((a, b) =>
      (a.congress_first_seen_at || '') <= (b.congress_first_seen_at || '') ? a : b,
    );
    out.push({
      ...base,
      provider: 'fmp',
      provider_first_seen_at: earliestIso(...group.map((r) => r.provider_first_seen_at)),
      provider_published_at: earliestIso(...group.map((r) => r.provider_published_at)),
      status: matched.length ? 'matched' : base.status,
      match_method: matched[0]?.match_method ?? base.match_method,
      // Any path's key is fine for coverage bookkeeping after merge.
      provider_key: matched.find((r) => r.provider_key)?.provider_key ?? base.provider_key,
    });
  }
  return out;
}

/**
 * Collapse FMP-family observations: one row per trade_hash (earliest first_observed).
 */
export function mergeFmpFamilyObservationRows(
  rows: Array<ProviderObservationRow & { trade_hash?: string | null }>,
): Array<ProviderObservationRow & { trade_hash?: string | null }> {
  const byHash = new Map<string, Array<ProviderObservationRow & { trade_hash?: string | null }>>();
  for (const row of rows) {
    if (!isFmpFamilyProvider(row.provider)) continue;
    const key = row.trade_hash || `${row.chamber}:${row.provider_key}`;
    const list = byHash.get(key);
    if (list) list.push(row);
    else byHash.set(key, [row]);
  }
  const out: Array<ProviderObservationRow & { trade_hash?: string | null }> = [];
  for (const group of byHash.values()) {
    const earliest = group.reduce((a, b) =>
      (a.first_observed_at || '') <= (b.first_observed_at || '') ? a : b,
    );
    out.push({
      ...earliest,
      provider: 'fmp',
      first_observed_at: earliestIso(...group.map((r) => r.first_observed_at)) ?? earliest.first_observed_at,
      provider_published_at: earliestIso(...group.map((r) => r.provider_published_at)),
    });
  }
  return out;
}

/** Prefer running > error > stopped > off > unknown for merged FMP status badge. */
export function mergeFmpOperationalStatus(
  statuses: Array<LatencySourceStatus | undefined | null>,
): LatencySourceStatus {
  const set = new Set(statuses.filter(Boolean) as LatencySourceStatus[]);
  if (set.has('running')) return 'running';
  if (set.has('error')) return 'error';
  if (set.has('stopped')) return 'stopped';
  if (set.has('off')) return 'off';
  return 'unknown';
}

function comparisonStatusFromSample(opts: {
  timingN: number;
  sampleOk: boolean;
  coverageOk: boolean;
}): DisclosureLatencyProviderMetrics['comparisonStatus'] {
  const { timingN, sampleOk, coverageOk } = opts;
  // No timed deltas at all → never claim preliminary/usable (prevents "tie" with n=0).
  if (timingN <= 0) return 'insufficient';
  if (!sampleOk) {
    return timingN >= LATENCY_MIN_PRELIMINARY_MATCHED ? 'preliminary' : 'limited';
  }
  if (coverageOk && timingN >= LATENCY_MIN_PRELIMINARY_MATCHED) return 'usable';
  if (timingN >= LATENCY_MIN_PRELIMINARY_MATCHED) return 'preliminary';
  return 'limited';
}

function computeProviderMetrics(opts: {
  providerId: ProviderId;
  label: string;
  timestampKind: 'provider' | 'monitor' | 'none';
  operationalStatus: LatencySourceStatus;
  mine: LatencyCandidateSummaryRow[];
  observations: Array<{
    provider: string;
    chamber: Chamber;
    provider_key: string;
    trade_hash?: string | null;
    first_observed_at: string;
  }>;
  maturityCutoff: string;
}): DisclosureLatencyProviderMetrics {
  const { providerId, label, timestampKind, operationalStatus, mine, observations, maturityCutoff } =
    opts;
  const maxDeltaSec = LATENCY_MAX_CONCURRENT_DELTA_HOURS * 3600;
  const liveMatched = mine.filter(
    (row) =>
      row.status === 'matched' && !!row.match_method && STRONG_MATCH_METHODS.has(row.match_method),
  );
  const timingMatches = liveMatched.filter((row) => {
    const t = effectiveRaceProviderTime(timestampKind, row);
    if (!t) return false;
    return Math.abs(deltaSeconds(t, row.congress_first_seen_at) ?? 1e12) <= maxDeltaSec;
  });
  // Effective deltas — same stamp cohort as matched (no published-only empty set).
  const effectiveDeltas = timingMatches
    .map((row) =>
      deltaSeconds(effectiveRaceProviderTime(timestampKind, row), row.congress_first_seen_at),
    )
    .filter((v): v is number => v != null);
  const publishedDeltas = timingMatches
    .map((row) => deltaSeconds(row.provider_published_at, row.congress_first_seen_at))
    .filter((v): v is number => v != null);
  // matched ≡ number of timed races with a real delta (never inflate above lead sample).
  const timingN = effectiveDeltas.length;
  const strongMatched = timingN;
  const matchedKeys = new Set(
    timingMatches
      .filter((row) => row.provider_key)
      .map((row) => `${row.chamber}:${row.provider_key}`),
  );
  // Also match observations by trade_hash when keys differ across FMP paths.
  const matchedHashes = new Set(
    timingMatches.map((row) => row.trade_hash).filter((h): h is string => !!h),
  );
  const obsMatched = (row: { chamber: Chamber; provider_key: string; trade_hash?: string | null }) =>
    matchedKeys.has(`${row.chamber}:${row.provider_key}`) ||
    (!!row.trade_hash && matchedHashes.has(row.trade_hash));

  const maturedObservations = observations.filter((row) => row.first_observed_at <= maturityCutoff);
  const maturedCandidates = mine.filter((row) => row.congress_first_seen_at <= maturityCutoff);
  const maturedMatched = maturedObservations.filter(obsMatched).length;
  const maturedProviderObserved = maturedObservations.length;
  const unmatchedProvider = maturedProviderObserved - maturedMatched;
  const pendingProvider = observations.filter(
    (row) => row.first_observed_at > maturityCutoff && !obsMatched(row),
  ).length;
  const matchedMaturedCandidates = maturedCandidates.filter(
    (row) =>
      row.status === 'matched' && !!row.match_method && STRONG_MATCH_METHODS.has(row.match_method),
  ).length;
  const ctCoveragePct = maturedProviderObserved
    ? Math.round((maturedMatched / maturedProviderObserved) * 1000) / 10
    : null;
  const providerCoveragePct = maturedCandidates.length
    ? Math.round((matchedMaturedCandidates / maturedCandidates.length) * 1000) / 10
    : null;
  const union = maturedProviderObserved + maturedCandidates.length - maturedMatched;
  const overlapPct = union > 0 ? Math.round((maturedMatched / union) * 1000) / 10 : null;
  const coverageOk =
    (ctCoveragePct ?? 0) >= LATENCY_MIN_COVERAGE_PCT &&
    (providerCoveragePct ?? 0) >= LATENCY_MIN_COVERAGE_PCT;
  const sampleOk =
    maturedProviderObserved >= LATENCY_MIN_MATURED_ROWS &&
    maturedCandidates.length >= LATENCY_MIN_MATURED_ROWS;

  return {
    provider: providerId,
    label,
    operationalStatus,
    candidates: mine.length,
    matched: timingN,
    strongMatched,
    pending: mine.filter((row) => row.status === 'pending').length,
    errored: mine.filter((row) => row.status === 'error').length,
    providerObserved: observations.length,
    maturedProviderObserved,
    unmatchedProvider,
    pendingProvider,
    maturedCandidates: maturedCandidates.length,
    maturedMatched,
    ctCoveragePct,
    providerCoveragePct,
    overlapPct,
    comparisonStatus: comparisonStatusFromSample({ timingN, sampleOk, coverageOk }),
    comparisonBasis: 'matched-overlap-only',
    // "Monitor" fields carry the effective race deltas (provider stamp with fallback).
    ctAheadMonitorCount: effectiveDeltas.filter((d) => d > 0).length,
    providerAheadMonitorCount: effectiveDeltas.filter((d) => d < 0).length,
    tieMonitorCount: effectiveDeltas.filter((d) => d === 0).length,
    avgMonitorDeltaSec: average(effectiveDeltas),
    medianMonitorDeltaSec: median(effectiveDeltas),
    p90MonitorDeltaSec: p90(effectiveDeltas),
    ctAheadPublishedCount: publishedDeltas.filter((d) => d > 0).length,
    providerAheadPublishedCount: publishedDeltas.filter((d) => d < 0).length,
    tiePublishedCount: publishedDeltas.filter((d) => d === 0).length,
    avgProviderPublishedDeltaSec: average(publishedDeltas),
    medianProviderPublishedDeltaSec: median(publishedDeltas),
    timestampKind,
  };
}

/**
 * Public scoreboard providers: FMP stable + RapidAPI collapse to one "FMP" lane
 * using the earliest path observation per trade. Other direct providers pass through.
 */
export function buildPublicLatencyProviders(
  pathMetrics: DisclosureLatencyProviderMetrics[],
  candidateRows: LatencyCandidateSummaryRow[],
  observationRows: Array<ProviderObservationRow & { trade_hash?: string | null }>,
  statuses: DisclosureLatencyProviderStatus[],
  maturityCutoff: string,
): DisclosureLatencyProviderMetrics[] {
  const liveCandidates = candidateRows.filter((row) =>
    isLiveRaceImport({
      source: 'primary',
      filedDate: row.filed_date,
      firstSeenAt: row.congress_first_seen_at,
    }),
  );
  const fmpCandidates = mergeFmpFamilyCandidateRows(liveCandidates);
  const fmpObservations = mergeFmpFamilyObservationRows(
    observationRows.filter((r) => isFmpFamilyProvider(r.provider)),
  );
  const fmpStatus = mergeFmpOperationalStatus(
    statuses.filter((s) => isFmpFamilyProvider(s.id)).map((s) => s.operationalStatus),
  );
  const fmpMetrics = computeProviderMetrics({
    providerId: 'fmp',
    label: 'FMP',
    timestampKind: 'monitor',
    operationalStatus: fmpStatus,
    mine: fmpCandidates,
    observations: fmpObservations,
    maturityCutoff,
  });

  const others = PROVIDERS.filter(
    (p) => p.supportsDirectLatest && !isFmpFamilyProvider(p.id),
  ).map((provider) => {
    const existing = pathMetrics.find((m) => m.provider === provider.id);
    if (existing) {
      // Public label: shorten Quiver display name is already fine.
      return existing;
    }
    return computeProviderMetrics({
      providerId: provider.id,
      label: provider.label,
      timestampKind: provider.timestampKind,
      operationalStatus:
        statuses.find((s) => s.id === provider.id)?.operationalStatus ?? 'unknown',
      mine: liveCandidates.filter((r) => r.provider === provider.id),
      observations: observationRows.filter((r) => r.provider === provider.id),
      maturityCutoff,
    });
  });

  return [fmpMetrics, ...others];
}

export async function getDisclosureLatencySummary(env: Env, now: Date = new Date()): Promise<DisclosureLatencySummary> {
  const scoreCutoff = new Date(now.getTime() - LATENCY_SCORE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const providerLookbackCutoff = new Date(
    now.getTime() - LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const maturityCutoff = new Date(now.getTime() - LATENCY_MATURITY_GRACE_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await all<LatencyCandidateSummaryRow>(
    env.DB,
    // Live CT first_seen in the 7d score window (backfills never minted here).
    `SELECT provider, trade_hash, status, chamber, provider_key, match_method, congress_first_seen_at,
            provider_first_seen_at, provider_published_at, filed_date, created_at, updated_at
       FROM trade_latency_candidates
      WHERE congress_first_seen_at >= ?
      ORDER BY CASE WHEN status = 'matched' THEN 0 ELSE 1 END,
               updated_at DESC
      LIMIT 8000`,
    [scoreCutoff],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  // Provider listings in the 14d match lookback (they can beat us by a week).
  const providerRows = await all<ProviderObservationRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at,
            provider_published_at, source_url, filed_date, filer_name, payload
       FROM trade_provider_observations
      WHERE first_observed_at >= ?
      ORDER BY first_observed_at DESC
      LIMIT 10000`,
    [providerLookbackCutoff],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  const statuses = await getDisclosureLatencyProviderStatuses(env);
  // Per-path metrics (admin / ops — FMP stable and RapidAPI stay separate).
  const providers = PROVIDERS.filter((p) => p.supportsDirectLatest).map((provider) => {
    const mine = rows.filter(
      (row) =>
        row.provider === provider.id &&
        isLiveRaceImport({
          source: 'primary',
          filedDate: row.filed_date,
          firstSeenAt: row.congress_first_seen_at,
        }),
    );
    const observations = providerRows.filter((row) => row.provider === provider.id);
    const st = statuses.find((s) => s.id === provider.id);
    return computeProviderMetrics({
      providerId: provider.id,
      label: provider.label,
      timestampKind: provider.timestampKind,
      operationalStatus: st?.operationalStatus ?? 'unknown',
      mine,
      observations,
      maturityCutoff,
    });
  });

  // Public scoreboard: one FMP lane (earliest of stable/RapidAPI), no dual listing.
  const publicProviders = buildPublicLatencyProviders(
    providers,
    rows,
    providerRows,
    statuses,
    maturityCutoff,
  );
  const totals = {
    candidates: rows.length,
    matched: providers.reduce((sum, p) => sum + p.matched, 0),
    pending: rows.filter((row) => row.status === 'pending').length,
    errored: rows.filter((row) => row.status === 'error').length,
    providerObserved: providerRows.length,
    maturedProviderObserved: providers.reduce((sum, p) => sum + p.maturedProviderObserved, 0),
    unmatchedProvider: providers.reduce((sum, p) => sum + p.unmatchedProvider, 0),
    comparableProviders: PROVIDERS.filter((p) => p.supportsDirectLatest).length,
    configuredComparableProviders: statuses.filter((p) => p.supportsDirectLatest && p.configured).length,
  };
  // Public totals count scoreboard lanes (FMP merged), not dual FMP paths.
  const publicTotals = {
    ...totals,
    matched: publicProviders.reduce((sum, p) => sum + p.matched, 0),
    maturedProviderObserved: publicProviders.reduce((sum, p) => sum + p.maturedProviderObserved, 0),
    unmatchedProvider: publicProviders.reduce((sum, p) => sum + p.unmatchedProvider, 0),
    comparableProviders: publicProviders.length,
    configuredComparableProviders: statuses.filter(
      (p) =>
        p.supportsDirectLatest &&
        p.configured &&
        // Count FMP family once when any path is configured.
        (!isFmpFamilyProvider(p.id) || p.id === 'fmp'),
    ).length,
  };
  const generatedAt = now.toISOString();
  const meta = {
    windowHours: LATENCY_SCORE_WINDOW_HOURS,
    maxConcurrentDeltaHours: LATENCY_MAX_CONCURRENT_DELTA_HOURS,
  };
  return {
    generatedAt,
    ...meta,
    totals,
    providers,
    providerStatuses: statuses,
    publicSummary: { generatedAt, ...meta, totals: publicTotals, providers: publicProviders },
  };
}

export async function recordDisclosureLatencyCandidate(
  env: Env,
  filing: any,
  nowIso: string,
): Promise<void> {
  // Deprecated: Candidates are now tracked at the trade level inside normalizer.ts / backfill/seed.ts
}
