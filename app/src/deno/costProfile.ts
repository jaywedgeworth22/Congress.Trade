/**
 * Runtime cost profile (Coolify Deno-in-Docker).
 *
 * Deno Deploy is retired.  Production is Coolify on Hetzner with
 * `CT_COST_PROFILE=paid` (cron `* * * * *` on `/api/health`).  Do not set
 * these knobs "in Deno Deploy" and do not size live ops around Deploy
 * free-tier quotas (~1M requests / 20GB egress / 15h CPU).  Those limits
 * were why the `free` profile existed (2026-07); they are not the live
 * cost model.
 *
 * `CT_*` names are the operator knobs.  Legacy `DENO_*` aliases remain for
 * local tests only (Deploy used to reject custom `DENO_*` keys).
 *
 * Profiles trade discovery/queue latency for tick frequency. Set via
 * `CT_COST_PROFILE=free|balanced|paid` in Infisical / Coolify (code default
 * is still `free` if unset). Optional overrides:
 *   CT_CRON_SCHEDULE           — crontab expression for Deno.cron
 *   CT_DRAIN_LIMIT             — max durable-queue messages completed per tick
 *   CT_DRAIN_CLAIM_SIZE        — messages claimed per SQL batch
 *   CT_OUTBOX_LIMIT            — max outbox rows flushed per tick (each outbox)
 *   CT_DISABLE_INTERNAL_CRON=true — skip Deno.cron; drive ticks externally
 *     (POST /api/admin/runtime-tick).  Not the production path.
 */

export type DenoCostProfileName = 'free' | 'balanced' | 'paid';

export interface DenoCostProfile {
  name: DenoCostProfileName;
  /** Crontab for Deno.cron. */
  cronSchedule: string;
  /** Max messages processed across claim loops per queue per tick. */
  drainLimit: number;
  /** Claim batch size (rows leased at once; still handled serially). */
  drainClaimSize: number;
  /** Max rows per ingestion/delivery outbox flush. */
  outboxLimit: number;
  /** When true, main.ts does not register Deno.cron. */
  disableInternalCron: boolean;
  /**
   * When true, skip outbox flush + queue drain when a cheap probe finds no
   * pending work (watcher + daily jobs still run).
   */
  idleShortCircuit: boolean;
}

const PROFILES: Record<DenoCostProfileName, Omit<DenoCostProfile, 'disableInternalCron'>> = {
  // Leftover Deno Deploy free-tier survival profile.  Not production.
  free: {
    name: 'free',
    cronSchedule: '*/15 * * * *',
    drainLimit: 2,
    drainClaimSize: 1,
    outboxLimit: 10,
    idleShortCircuit: true,
  },
  // Middle ground: ~21k ticks/mo, modest drain — good if Pro is temporary.
  balanced: {
    name: 'balanced',
    cronSchedule: '*/2 * * * *',
    drainLimit: 8,
    drainClaimSize: 2,
    outboxLimit: 40,
    idleShortCircuit: true,
  },
  // Live Coolify production: every minute, larger batches.
  // idleShortCircuit stays on; probePendingWork includes eligible-due
  // review rows so a quiet tick cannot skip claimable extract work.
  paid: {
    name: 'paid',
    cronSchedule: '* * * * *',
    drainLimit: 25,
    drainClaimSize: 10,
    outboxLimit: 100,
    idleShortCircuit: true,
  },
};

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseProfileName(raw: string | undefined): DenoCostProfileName {
  const v = (raw ?? 'free').trim().toLowerCase();
  if (v === 'paid' || v === 'pro' || v === 'full') return 'paid';
  if (v === 'balanced' || v === 'default' || v === 'medium') return 'balanced';
  return 'free';
}

function truthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Resolve the active cost profile from environment values (Deno.env or Env).
 * Code default is **free** if unset.  Production must set `CT_COST_PROFILE=paid`
 * in Infisical / Coolify.  Prefer CT_* names.  Legacy DENO_* aliases are
 * accepted for local tests only.
 */
export function resolveDenoCostProfile(
  env: Record<string, string | undefined> | { get?: (k: string) => string | undefined } = {},
): DenoCostProfile {
  const read = (key: string): string | undefined => {
    if (typeof (env as { get?: (k: string) => string | undefined }).get === 'function') {
      return (env as { get: (k: string) => string | undefined }).get(key) ?? undefined;
    }
    return (env as Record<string, string | undefined>)[key];
  };

  // Prefer CT_* keys; fall back to legacy DENO_* for local tests.
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = read(key);
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };

  const base = PROFILES[parseProfileName(pick('CT_COST_PROFILE', 'DENO_COST_PROFILE'))];
  const cronOverride = pick('CT_CRON_SCHEDULE', 'DENO_CRON_SCHEDULE')?.trim();
  return {
    ...base,
    cronSchedule: cronOverride && cronOverride.length > 0 ? cronOverride : base.cronSchedule,
    drainLimit: parsePositiveInt(
      pick('CT_DRAIN_LIMIT', 'DENO_DRAIN_LIMIT'),
      base.drainLimit,
      100,
    ),
    drainClaimSize: parsePositiveInt(
      pick('CT_DRAIN_CLAIM_SIZE', 'DENO_DRAIN_CLAIM_SIZE'),
      base.drainClaimSize,
      25,
    ),
    outboxLimit: parsePositiveInt(
      pick('CT_OUTBOX_LIMIT', 'DENO_OUTBOX_LIMIT'),
      base.outboxLimit,
      200,
    ),
    disableInternalCron: truthy(
      pick('CT_DISABLE_INTERNAL_CRON', 'DENO_DISABLE_INTERNAL_CRON'),
    ),
    idleShortCircuit: !truthy(pick('CT_FORCE_FULL_TICK', 'DENO_FORCE_FULL_TICK')),
  };
}

/** Public-safe summary for /api/health and admin diagnostics (no secrets). */
export function costProfilePublicSummary(profile: DenoCostProfile): Record<string, unknown> {
  return {
    name: profile.name,
    cronSchedule: profile.cronSchedule,
    drainLimit: profile.drainLimit,
    drainClaimSize: profile.drainClaimSize,
    outboxLimit: profile.outboxLimit,
    disableInternalCron: profile.disableInternalCron,
    idleShortCircuit: profile.idleShortCircuit,
  };
}
