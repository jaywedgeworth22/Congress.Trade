/**
 * Scout handoff: server-first latency probes; Mac residential scout takes over
 * when a source fails, is blocked, or has gone quiet. Also lists filings that
 * still need raw bytes in R2 so the scout can upload from a residential IP.
 */
import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';

export const LATENCY_PROBE_HEALTH_KV_KEY = 'latency-probe-health:v1';

/** Quiet for this long → scout should cover the provider (sooner than the 48h health alarm). */
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
  /** True when residential scout should run this provider's latency poll. */
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
    needScout: false,
    needScoutReason: null,
    updatedAt: nowIso,
  };
}

async function readHealthMap(env: Env): Promise<HealthMap> {
  if (!env.CONFIG_KV) return {};
  try {
    const raw = await env.CONFIG_KV.get(LATENCY_PROBE_HEALTH_KV_KEY, 'json');
    if (!raw || typeof raw !== 'object') return {};
    return raw as HealthMap;
  } catch {
    return {};
  }
}

async function writeHealthMap(env: Env, map: HealthMap): Promise<void> {
  if (!env.CONFIG_KV) return;
  await env.CONFIG_KV.put(LATENCY_PROBE_HEALTH_KV_KEY, JSON.stringify(map));
}

/**
 * Derive needScout from a probe outcome.
 * - HTTP/config errors → scout immediately
 * - Budget/spacing skip alone → scout only if already silent past threshold
 * - Success → clear needScout
 */
export function computeNeedScout(opts: {
  nowMs: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  kind: 'success' | 'error' | 'budget_skip' | 'not_configured' | 'disabled';
  silenceHours?: number;
}): { needScout: boolean; needScoutReason: string | null } {
  const silenceH = opts.silenceHours ?? LATENCY_SCOUT_SILENCE_HOURS;
  if (opts.kind === 'disabled') {
    return { needScout: false, needScoutReason: null };
  }
  if (opts.kind === 'not_configured') {
    return { needScout: true, needScoutReason: 'provider not configured on server' };
  }
  if (opts.kind === 'error') {
    return {
      needScout: true,
      needScoutReason: opts.lastError ? `server probe error: ${opts.lastError.slice(0, 200)}` : 'server probe error',
    };
  }
  if (opts.kind === 'success') {
    return { needScout: false, needScoutReason: null };
  }
  // budget_skip: only hand off if we have not had a real success recently
  if (!opts.lastSuccessAt) {
    return { needScout: true, needScoutReason: 'no successful server probe yet (budget/spacing skip)' };
  }
  const successMs = Date.parse(opts.lastSuccessAt);
  if (!Number.isFinite(successMs)) {
    return { needScout: true, needScoutReason: 'unparseable last success; scout cover' };
  }
  const ageH = (opts.nowMs - successMs) / 3_600_000;
  if (ageH >= silenceH) {
    return {
      needScout: true,
      needScoutReason: `server quiet ${Math.round(ageH)}h (budget/spacing; threshold ${silenceH}h)`,
    };
  }
  return { needScout: false, needScoutReason: null };
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
  const lastSuccessAt =
    outcome.kind === 'success' ? nowIso : prev.lastSuccessAt;
  const lastError =
    outcome.kind === 'error' || outcome.kind === 'not_configured'
      ? (outcome.error ?? prev.lastError)
      : outcome.kind === 'success'
        ? null
        : prev.lastError;
  const { needScout, needScoutReason } = computeNeedScout({
    nowMs: now.getTime(),
    lastSuccessAt,
    lastError,
    kind: outcome.kind,
  });
  const next: LatencyProbeHealth = {
    provider,
    lastAttemptAt: nowIso,
    lastSuccessAt,
    lastError,
    lastFetchedRows: outcome.fetchedRows ?? (outcome.kind === 'success' ? prev.lastFetchedRows : 0),
    lastSource: outcome.source ?? 'server',
    needScout,
    needScoutReason,
    updatedAt: nowIso,
  };
  // Also re-evaluate silence for providers that "succeed" with zero rows? No —
  // zero rows can be a valid empty day; success clears needScout.
  map[provider] = next;
  await writeHealthMap(env, map);
  return next;
}

/**
 * Recompute needScout from wall-clock silence (for plan endpoint, even if no
 * probe ran this minute). Merges KV health with DB last_observed_at.
 */
export async function refreshLatencySilenceFromDb(
  env: Env,
  now: Date = new Date(),
): Promise<HealthMap> {
  const map = await readHealthMap(env);
  const nowMs = now.getTime();
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
    // Prefer the later of KV success and DB observation.
    const candidates = [prev.lastSuccessAt, dbLast].filter(Boolean) as string[];
    let lastSuccessAt = prev.lastSuccessAt;
    for (const c of candidates) {
      if (!lastSuccessAt || Date.parse(c) > Date.parse(lastSuccessAt)) lastSuccessAt = c;
    }
    // If already needScout for a hard error, keep it.
    if (prev.needScout && prev.needScoutReason && /error|not configured/i.test(prev.needScoutReason)) {
      map[provider] = { ...prev, lastSuccessAt, updatedAt: nowIso };
      continue;
    }
    if (!lastSuccessAt) {
      map[provider] = {
        ...prev,
        lastSuccessAt: null,
        needScout: true,
        needScoutReason: prev.needScoutReason ?? 'no observations yet — scout should cover',
        updatedAt: nowIso,
      };
      continue;
    }
    const ageH = (nowMs - Date.parse(lastSuccessAt)) / 3_600_000;
    if (Number.isFinite(ageH) && ageH >= LATENCY_SCOUT_SILENCE_HOURS) {
      map[provider] = {
        ...prev,
        lastSuccessAt,
        needScout: true,
        needScoutReason: `provider quiet ${Math.round(ageH)}h (scout silence ${LATENCY_SCOUT_SILENCE_HOURS}h)`,
        updatedAt: nowIso,
      };
    } else {
      map[provider] = {
        ...prev,
        lastSuccessAt,
        needScout: false,
        needScoutReason: null,
        updatedAt: nowIso,
      };
    }
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

export async function buildScoutPlan(env: Env, now: Date = new Date()): Promise<ScoutPlan> {
  const map = await refreshLatencySilenceFromDb(env, now);
  const latency = PROVIDER_IDS.map((id) => map[id] ?? emptyHealth(id, now.toISOString()));
  const latencyNeedScout = latency.filter((h) => h.needScout);
  const rawFetch = await listFilingsNeedingRaw(env, 20);
  const notes: string[] = [
    'Server runs latency probes first (cron). Scout covers providers with needScout=true.',
    'Scout should POST provider payloads to /api/ingest/latency-payload and raw bytes to /api/ingest/raw.',
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
  };
}
