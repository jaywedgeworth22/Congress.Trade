/**
 * Scout handoff: server-first latency probes; Mac residential scout covers a
 * provider only after N successive *server* hard failures (not mere silence or
 * budget/spacing skips). Scout success fills observations but does not clear
 * the handoff — server must succeed again to reclaim the lane.
 *
 * Also lists filings that still need raw bytes in R2 so the scout can upload
 * from a residential IP.
 */
import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';

/** Bumped when handoff semantics change so stale "quiet 6h" claims do not stick. */
export const LATENCY_PROBE_HEALTH_KV_KEY = 'latency-probe-health:v2';

/**
 * Hand off to the Mac scout after this many successive *server* probe errors.
 * Owner 2026-08-11: 2nd or 3rd successive error — default 3.
 * Not triggered by budget/spacing skips or wall-clock silence alone.
 */
export const LATENCY_SCOUT_CONSECUTIVE_ERRORS = 3;

/**
 * @deprecated Silence no longer triggers handoff (owner 2026-08-11). Kept as a
 * named export so older tests/docs that imported it keep compiling; value is
 * unused by computeNeedScout.
 */
export const LATENCY_SCOUT_SILENCE_HOURS = 6;

export type LatencyProbeSource = 'server' | 'scout';

export type LatencyProbeProviderId =
  | 'fmp'
  | 'fmp_rapidapi'
  | 'unusual_whales'
  | 'quiver';

export interface LatencyProbeHealth {
  provider: LatencyProbeProviderId;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastFetchedRows: number;
  lastSource: LatencyProbeSource;
  /**
   * Consecutive *server* hard failures since last server success.
   * Scout outcomes never increment this; server success zeros it.
   */
  consecutiveServerErrors: number;
  /** True when residential scout should poll this provider. */
  needScout: boolean;
  needScoutReason: string | null;
  updatedAt: string;
}

export interface ScoutRawNeed {
  docId: string;
  chamber: string;
  sourceUrl: string;
  reason: 'missing_raw' | 'fetch_error';
  error: string | null;
  firstSeenAt: string | null;
}

export interface ScoutPlan {
  generatedAt: string;
  latency: LatencyProbeHealth[];
  /** Providers the scout should actively poll this cycle. */
  latencyNeedScout: LatencyProbeHealth[];
  rawFetch: ScoutRawNeed[];
  notes: string[];
  /**
   * Hint for Mac dual free-tier keys: prefer the secondary FMP free key when
   * covering FMP so the server primary key is not double-spent.
   */
  fmpPreferSecondaryKey: boolean;
}

type HealthMap = Partial<Record<LatencyProbeProviderId, LatencyProbeHealth>>;

const PROVIDER_IDS: LatencyProbeProviderId[] = [
  'fmp',
  'fmp_rapidapi',
  'unusual_whales',
  'quiver',
];

function emptyHealth(provider: LatencyProbeProviderId, nowIso: string): LatencyProbeHealth {
  return {
    provider,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastFetchedRows: 0,
    lastSource: 'server',
    consecutiveServerErrors: 0,
    needScout: false,
    needScoutReason: null,
    updatedAt: nowIso,
  };
}

/** Coerce legacy v1 health rows (no consecutiveServerErrors) into v2 shape. */
function normalizeHealth(
  provider: LatencyProbeProviderId,
  raw: Partial<LatencyProbeHealth> | undefined,
  nowIso: string,
): LatencyProbeHealth {
  const base = emptyHealth(provider, nowIso);
  if (!raw || typeof raw !== 'object') return base;
  const consecutive =
    typeof raw.consecutiveServerErrors === 'number' && Number.isFinite(raw.consecutiveServerErrors)
      ? Math.max(0, Math.floor(raw.consecutiveServerErrors))
      : 0;
  // Drop permanent silence / "no observations yet" claims from v1.
  const reason = raw.needScoutReason ?? null;
  const legacySilence =
    !!reason &&
    (/quiet \d+h/i.test(reason) ||
      /scout silence/i.test(reason) ||
      /no observations yet/i.test(reason) ||
      /no successful server probe yet/i.test(reason));
  let needScout = Boolean(raw.needScout) && !legacySilence;
  let needScoutReason = legacySilence ? null : reason;
  // Reconcile with consecutive count (source of truth for handoff).
  if (consecutive >= LATENCY_SCOUT_CONSECUTIVE_ERRORS) {
    needScout = true;
    needScoutReason =
      needScoutReason && /successive/i.test(needScoutReason)
        ? needScoutReason
        : `server probe failed ${consecutive} successive times (threshold ${LATENCY_SCOUT_CONSECUTIVE_ERRORS})`;
  } else if (!needScoutReason || /quiet|silence|no observations/i.test(needScoutReason)) {
    needScout = false;
    needScoutReason = null;
  }
  // not_configured is sticky until a server success / reconfigure.
  if (reason && /not configured/i.test(reason)) {
    needScout = true;
    needScoutReason = reason;
  }
  return {
    provider,
    lastAttemptAt: raw.lastAttemptAt ?? null,
    lastSuccessAt: raw.lastSuccessAt ?? null,
    lastError: raw.lastError ?? null,
    lastFetchedRows: typeof raw.lastFetchedRows === 'number' ? raw.lastFetchedRows : 0,
    lastSource: raw.lastSource === 'scout' ? 'scout' : 'server',
    consecutiveServerErrors: consecutive,
    needScout,
    needScoutReason,
    updatedAt: raw.updatedAt ?? nowIso,
  };
}

async function readHealthMap(env: Env): Promise<HealthMap> {
  if (!env.CONFIG_KV) return {};
  try {
    // Prefer v2; fall back to v1 once for migration.
    let raw = await env.CONFIG_KV.get(LATENCY_PROBE_HEALTH_KV_KEY, 'json');
    if (!raw || typeof raw !== 'object') {
      raw = await env.CONFIG_KV.get('latency-probe-health:v1', 'json');
    }
    if (!raw || typeof raw !== 'object') return {};
    const nowIso = new Date().toISOString();
    const out: HealthMap = {};
    for (const id of PROVIDER_IDS) {
      const row = (raw as Record<string, unknown>)[id];
      out[id] = normalizeHealth(
        id,
        row && typeof row === 'object' ? (row as Partial<LatencyProbeHealth>) : undefined,
        nowIso,
      );
    }
    return out;
  } catch {
    return {};
  }
}

async function writeHealthMap(env: Env, map: HealthMap): Promise<void> {
  if (!env.CONFIG_KV) return;
  await env.CONFIG_KV.put(LATENCY_PROBE_HEALTH_KV_KEY, JSON.stringify(map));
}

/**
 * Derive needScout + consecutive error count from a probe outcome.
 *
 * - Server success → consecutive=0, needScout=false (server reclaims lane)
 * - Server error → consecutive+=1; needScout after threshold
 * - Server not_configured → needScout=true (server cannot probe)
 * - Server disabled / budget_skip → do not hand off; do not increment errors
 * - Scout success/error → never changes consecutive; needScout stays until server recovers
 */
export function computeNeedScout(opts: {
  kind: 'success' | 'error' | 'budget_skip' | 'not_configured' | 'disabled';
  source?: LatencyProbeSource;
  lastError?: string | null;
  prevConsecutiveServerErrors?: number;
  threshold?: number;
}): {
  needScout: boolean;
  needScoutReason: string | null;
  consecutiveServerErrors: number;
} {
  const threshold = opts.threshold ?? LATENCY_SCOUT_CONSECUTIVE_ERRORS;
  const source = opts.source ?? 'server';
  const prev = Math.max(0, Math.floor(opts.prevConsecutiveServerErrors ?? 0));

  if (source === 'scout') {
    // Scout fills observations; it does not clear or open handoff by itself.
    // Keep prior consecutive count; needScout stays true while threshold met
    // so the Mac keeps covering until the server succeeds again.
    const needScout = prev >= threshold;
    return {
      consecutiveServerErrors: prev,
      needScout,
      needScoutReason: needScout
        ? `server probe failed ${prev} successive times (threshold ${threshold}); scout covering until server recovers`
        : null,
    };
  }

  // Server path
  if (opts.kind === 'disabled' || opts.kind === 'budget_skip') {
    // Intentional skip / off — do not hand off, do not count as failure.
    return {
      consecutiveServerErrors: prev,
      needScout: prev >= threshold,
      needScoutReason:
        prev >= threshold
          ? `server probe failed ${prev} successive times (threshold ${threshold})`
          : null,
    };
  }
  if (opts.kind === 'not_configured') {
    return {
      consecutiveServerErrors: prev,
      needScout: true,
      needScoutReason: 'provider not configured on server',
    };
  }
  if (opts.kind === 'success') {
    return {
      consecutiveServerErrors: 0,
      needScout: false,
      needScoutReason: null,
    };
  }
  // error
  const consecutive = prev + 1;
  if (consecutive >= threshold) {
    const err = opts.lastError ? opts.lastError.slice(0, 160) : 'error';
    return {
      consecutiveServerErrors: consecutive,
      needScout: true,
      needScoutReason: `server probe failed ${consecutive} successive times (threshold ${threshold}): ${err}`,
    };
  }
  return {
    consecutiveServerErrors: consecutive,
    needScout: false,
    needScoutReason: null,
  };
}

export async function recordLatencyProbeOutcome(
  env: Env,
  provider: LatencyProbeProviderId,
  outcome: {
    source?: LatencyProbeSource;
    kind: 'success' | 'error' | 'budget_skip' | 'not_configured' | 'disabled';
    error?: string | null;
    fetchedRows?: number;
    now?: Date;
  },
): Promise<LatencyProbeHealth> {
  const now = outcome.now ?? new Date();
  const nowIso = now.toISOString();
  const map = await readHealthMap(env);
  const prev = map[provider] ?? emptyHealth(provider, nowIso);
  const source = outcome.source ?? 'server';

  const lastSuccessAt =
    outcome.kind === 'success' ? nowIso : prev.lastSuccessAt;
  const lastError =
    outcome.kind === 'error' || outcome.kind === 'not_configured'
      ? (outcome.error ?? prev.lastError)
      : outcome.kind === 'success' && source === 'server'
        ? null
        : prev.lastError;

  const derived = computeNeedScout({
    kind: outcome.kind,
    source,
    lastError,
    prevConsecutiveServerErrors: prev.consecutiveServerErrors,
  });

  const next: LatencyProbeHealth = {
    provider,
    lastAttemptAt: nowIso,
    lastSuccessAt,
    lastError,
    lastFetchedRows:
      outcome.fetchedRows ?? (outcome.kind === 'success' ? prev.lastFetchedRows : 0),
    lastSource: source,
    consecutiveServerErrors: derived.consecutiveServerErrors,
    needScout: derived.needScout,
    needScoutReason: derived.needScoutReason,
    updatedAt: nowIso,
  };
  map[provider] = next;
  await writeHealthMap(env, map);
  return next;
}

/**
 * Refresh lastSuccessAt from DB observations for display only.
 * Does **not** open needScout based on wall-clock silence (owner 2026-08-11).
 */
export async function refreshLatencySilenceFromDb(
  env: Env,
  now: Date = new Date(),
): Promise<HealthMap> {
  const map = await readHealthMap(env);
  const nowIso = now.toISOString();
  let rows: Array<{ provider: string; last_observed: string }> = [];
  try {
    rows = await all<{ provider: string; last_observed: string }>(
      env.DB,
      `SELECT provider, MAX(last_observed_at) AS last_observed
         FROM trade_provider_observations
        GROUP BY provider`,
    );
  } catch {
    rows = [];
  }
  const byProvider = new Map(rows.map((r) => [r.provider, r.last_observed]));
  for (const provider of PROVIDER_IDS) {
    const prev = map[provider] ?? emptyHealth(provider, nowIso);
    const dbLast = byProvider.get(provider) ?? null;
    const candidates = [prev.lastSuccessAt, dbLast].filter(Boolean) as string[];
    let lastSuccessAt = prev.lastSuccessAt;
    for (const c of candidates) {
      if (!lastSuccessAt || Date.parse(c) > Date.parse(lastSuccessAt)) lastSuccessAt = c;
    }
    // Re-apply threshold without incrementing (display-only refresh).
    const consecutive = prev.consecutiveServerErrors;
    const stickyNotConfigured =
      !!prev.needScoutReason && /not configured/i.test(prev.needScoutReason);
    const needScout =
      stickyNotConfigured || consecutive >= LATENCY_SCOUT_CONSECUTIVE_ERRORS;
    const needScoutReason = stickyNotConfigured
      ? prev.needScoutReason
      : needScout
        ? `server probe failed ${consecutive} successive times (threshold ${LATENCY_SCOUT_CONSECUTIVE_ERRORS})`
        : null;
    map[provider] = {
      ...prev,
      lastSuccessAt,
      consecutiveServerErrors: consecutive,
      needScout,
      needScoutReason,
      updatedAt: nowIso,
    };
  }
  await writeHealthMap(env, map);
  return map;
}

export async function listFilingsNeedingRaw(
  env: Env,
  limit = 20,
): Promise<ScoutRawNeed[]> {
  const cap = Math.max(1, Math.min(50, Math.floor(limit)));
  try {
    const rows = await all<{
      doc_id: string;
      chamber: string | null;
      source_url: string | null;
      ingest_status: string | null;
      error: string | null;
      first_seen_at: string | null;
      raw_object_key: string | null;
    }>(
      env.DB,
      `SELECT doc_id, chamber, source_url, ingest_status, error, first_seen_at, raw_object_key
         FROM filings
        WHERE source_url IS NOT NULL AND TRIM(source_url) != ''
          AND (
            raw_object_key IS NULL
            OR (
              ingest_status = 'error'
              AND error IS NOT NULL
              AND (
                error LIKE '%403%'
                OR error LIKE '%429%'
                OR error LIKE '%Imperva%'
                OR error LIKE '%agreement wall%'
                OR error LIKE '%fetch failed%'
                OR error LIKE '%ECONN%'
                OR error LIKE '%timeout%'
              )
            )
          )
        ORDER BY COALESCE(first_seen_at, '') DESC
        LIMIT ?`,
      [cap],
    );
    return rows
      .filter((r) => r.source_url)
      .map((r) => ({
        docId: r.doc_id,
        chamber: r.chamber || 'house',
        sourceUrl: r.source_url!,
        reason: r.raw_object_key ? ('fetch_error' as const) : ('missing_raw' as const),
        error: r.error,
        firstSeenAt: r.first_seen_at,
      }));
  } catch {
    return [];
  }
}

/**
 * Providers that are intentionally off / not in the server probe set should
 * never appear in latencyNeedScout (e.g. fmp_rapidapi when paths=stable only).
 */
export async function eligibleHandoffProviders(env: Env): Promise<Set<LatencyProbeProviderId>> {
  const eligible = new Set<LatencyProbeProviderId>(['unusual_whales', 'quiver', 'fmp']);
  try {
    // Dynamic import keeps scoutHandoff free of heavy tradeLatency cycles in tests
    // that only mock CONFIG_KV/DB.
    const { isFmpProbeEnabled, enabledFmpPathIds } = await import('./tradeLatency.ts');
    if (!(await isFmpProbeEnabled(env))) {
      eligible.delete('fmp');
      return eligible;
    }
    const paths = await enabledFmpPathIds(env);
    if (paths.has('rapidapi')) eligible.add('fmp_rapidapi');
    // stable is the default fmp provider id
    if (!paths.has('stable') && !paths.has('rapidapi')) {
      // empty set after parse → treat as stable-only (matches enabledFmpPathIds default)
    }
    if (!paths.has('stable') && paths.has('rapidapi')) {
      eligible.delete('fmp');
    }
  } catch {
    // On import/env failure keep fmp eligible; never force rapidapi.
  }
  return eligible;
}

export async function buildScoutPlan(env: Env, now: Date = new Date()): Promise<ScoutPlan> {
  const map = await refreshLatencySilenceFromDb(env, now);
  const eligible = await eligibleHandoffProviders(env);
  const latency = PROVIDER_IDS.map((id) => {
    const row = map[id] ?? emptyHealth(id, now.toISOString());
    if (!eligible.has(id)) {
      // Disabled path: never hand off (clears stale "no observations" rapidapi claims).
      return {
        ...row,
        needScout: false,
        needScoutReason: null,
        consecutiveServerErrors: 0,
      };
    }
    return row;
  });
  const latencyNeedScout = latency.filter((h) => h.needScout);
  const rawFetch = await listFilingsNeedingRaw(env, 20);
  const fmpPreferSecondaryKey = latencyNeedScout.some(
    (h) => h.provider === 'fmp' || h.provider === 'fmp_rapidapi',
  );
  const notes: string[] = [
    `Server probes first. Scout covers a provider only after ${LATENCY_SCOUT_CONSECUTIVE_ERRORS} successive server errors (not silence alone).`,
    'Scout success fills observations; server success clears needScout and reclaims the lane.',
    'When covering FMP, prefer the secondary free-tier key (FMP_LATENCY_API_KEY_2 / FMP_API_KEY) so the server primary is not double-spent.',
    'fmp_rapidapi is eligible for handoff only when FMP_LATENCY_PATHS includes rapidapi.',
    'Filing storage is Cloudflare R2 (RAW_FILES), not Backblaze.',
  ];
  if (latencyNeedScout.length) {
    notes.push(
      `Scout latency cover: ${latencyNeedScout.map((h) => `${h.provider} (${h.needScoutReason})`).join('; ')}`,
    );
  }
  if (rawFetch.length) {
    notes.push(`Scout raw cover: ${rawFetch.length} filing(s) need residential download → R2`);
  }
  return {
    generatedAt: now.toISOString(),
    latency,
    latencyNeedScout,
    rawFetch,
    notes,
    fmpPreferSecondaryKey,
  };
}
