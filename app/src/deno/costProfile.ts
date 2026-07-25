/**
 * Deno Deploy cost profile.
 *
 * Free-tier quotas (Deno Deploy Free, 2026) are tight for a always-on ingestion
 * worker: ~1M requests, 20GB egress, 450k KV reads / 300k KV writes, and on
 * non-Classic runtimes 15h CPU / 350 GB-h memory. We burned a full month in ~4
 * days largely because the Deno cron fired every minute and each tick could
 * claim + process heavy extraction work.
 *
 * Profiles trade discovery/queue latency for billable wall-clock. Set via
 * `DENO_COST_PROFILE=free|balanced|paid` (default: free). Optional overrides:
 *   DENO_CRON_SCHEDULE       — crontab expression for Deno.cron
 *   DENO_DRAIN_LIMIT         — max durable-queue messages completed per tick
 *   DENO_DRAIN_CLAIM_SIZE    — messages claimed per SQL batch
 *   DENO_OUTBOX_LIMIT        — max outbox rows flushed per tick (each outbox)
 *   DENO_DISABLE_INTERNAL_CRON=true — skip Deno.cron; drive ticks externally
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
  // Survive free tier: ~8.6k cron ticks/mo, tiny per-tick extract budget.
  free: {
    name: 'free',
    cronSchedule: '*/5 * * * *',
    drainLimit: 3,
    drainClaimSize: 1,
    outboxLimit: 20,
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
 * Defaults to **free** so production survives after the Aug 1 quota reset
 * without requiring a config change; set DENO_COST_PROFILE=paid while on Pro.
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

  const base = PROFILES[parseProfileName(read('DENO_COST_PROFILE'))];
  const cronOverride = read('DENO_CRON_SCHEDULE')?.trim();
  return {
    ...base,
    cronSchedule: cronOverride && cronOverride.length > 0 ? cronOverride : base.cronSchedule,
    drainLimit: parsePositiveInt(read('DENO_DRAIN_LIMIT'), base.drainLimit, 100),
    drainClaimSize: parsePositiveInt(read('DENO_DRAIN_CLAIM_SIZE'), base.drainClaimSize, 25),
    outboxLimit: parsePositiveInt(read('DENO_OUTBOX_LIMIT'), base.outboxLimit, 200),
    disableInternalCron: truthy(read('DENO_DISABLE_INTERNAL_CRON')),
    idleShortCircuit: !truthy(read('DENO_FORCE_FULL_TICK')),
  };
}
