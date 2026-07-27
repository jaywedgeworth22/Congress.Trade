/**
 * Deno Deploy cost profile.
 *
 * Free-tier quotas (Deno Deploy Free, 2026) are tight for an always-on ingestion
 * worker: ~1M requests, 20GB egress, 450k KV reads / 300k KV writes, and on the
 * current (non-Classic) product 15h CPU / 350 GB-h memory. We burned a full
 * month in ~4 days largely because the Deno cron fired every minute and each
 * tick could claim + process heavy extraction work.
 *
 * NOTE: Deno Deploy forbids custom env var names starting with `DENO_`. Use the
 * `CT_*` names below (Congress.Trade). Legacy `DENO_*` names are still read for
 * local tests only; they cannot be set on Deploy.
 *
 * Profiles trade discovery/queue latency for billable wall-clock. Set via
 * `CT_COST_PROFILE=free|balanced|paid` (default: free). Optional overrides:
 *   CT_CRON_SCHEDULE           — crontab expression for Deno.cron
 *   CT_DRAIN_LIMIT             — max durable-queue messages completed per tick
 *   CT_DRAIN_CLAIM_SIZE        — messages claimed per SQL batch
 *   CT_OUTBOX_LIMIT            — max outbox rows flushed per tick (each outbox)
 *   CT_DISABLE_INTERNAL_CRON=true — skip Deno.cron; drive ticks externally
 *     (e.g. Coolify/GitHub Actions calling POST /api/admin/runtime-tick)
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
  // Survive free tier: ~2.9k cron ticks/mo, tiny per-tick extract budget.
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
  // Prior behavior: every minute, larger batches (paid / Pro headroom).
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
 * Defaults to **free**. Prefer CT_* names (Deploy-safe). Legacy DENO_* aliases
 * are accepted for local tests only.
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

  // Prefer Deploy-safe CT_* keys; fall back to legacy DENO_* for local tests.
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
