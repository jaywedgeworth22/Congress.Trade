/**
 * src/shared/config.ts
 * Poll configuration + adaptive scheduling logic. Implemented (not a stub).
 *
 * The watcher (src/ingestion/watcher.ts) runs every minute (cron) and calls
 * shouldPollNow() to decide whether to actually hit the sources. The schedule
 * lives in D1 (poll_config) and is cached in CONFIG_KV for hot reads/writes.
 */

import type { Env, PollConfig, PollWindow } from './types';
import { get, run, parseJson, fromBool, toBool } from './db';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * DEFAULT_SCHEDULE — adaptive poll cadence (all hours America/New_York):
 *   Mon–Fri 08:00–19:00 ET  => every 300s  (active disclosure hours)
 *   Mon–Fri 19:00–24:00 ET  => every 1200s (evening)
 *   Mon–Fri 00:00–08:00 ET  => every 1200s (overnight)
 *   Sat/Sun 00:00–24:00 ET  => every 3600s (weekend)
 *
 * When aggressiveMode is true, the Mon–Fri 08:00–19:00 window interval drops to
 * 180s (see effectiveInterval()).
 */
export const DEFAULT_SCHEDULE: PollWindow[] = [
  { daysOfWeek: [1, 2, 3, 4, 5], startHourET: 8, endHourET: 19, intervalSec: 300 },
  { daysOfWeek: [1, 2, 3, 4, 5], startHourET: 19, endHourET: 24, intervalSec: 1200 },
  { daysOfWeek: [1, 2, 3, 4, 5], startHourET: 0, endHourET: 8, intervalSec: 1200 },
  { daysOfWeek: [0, 6], startHourET: 0, endHourET: 24, intervalSec: 3600 },
];

export const DEFAULT_CONFIG: PollConfig = {
  schedule: DEFAULT_SCHEDULE,
  aggressiveMode: false,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/** Aggressive-mode interval for the Mon–Fri active window. */
const AGGRESSIVE_ACTIVE_INTERVAL_SEC = 180;
/** The active window we accelerate under aggressive mode. */
const ACTIVE_WINDOW = { startHourET: 8, endHourET: 19 };

const KV_CONFIG_KEY = 'poll_config';
const KV_LAST_POLL_PREFIX = 'last_poll:';

// ---------------------------------------------------------------------------
// Eastern Time computation (DST-aware, no external deps)
// ---------------------------------------------------------------------------

/**
 * Compute the wall-clock hour (0–23) and weekday (0=Sun..6=Sat) in
 * America/New_York for the given instant.
 *
 * Implementation: we use Intl.DateTimeFormat with timeZone:'America/New_York',
 * which the Workers runtime supports and which applies US DST rules correctly
 * (EDT = UTC-4 spring/summer, EST = UTC-5 fall/winter). We parse the formatted
 * parts rather than doing manual offset math so DST transitions are exact.
 */
export function etParts(now: Date): { hourET: number; dayOfWeekET: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const lookup = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';

  // hour: '00'..'24' — Intl can emit '24' at midnight; normalize to 0.
  let hourET = parseInt(lookup('hour'), 10);
  if (!Number.isFinite(hourET) || hourET === 24) hourET = 0;

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeekET = weekdayMap[lookup('weekday')] ?? new Date(now).getUTCDay();

  return { hourET, dayOfWeekET };
}

/** Find the matching window for the current ET day/hour, or null if none. */
export function activeWindow(now: Date, cfg: PollConfig): PollWindow | null {
  const { hourET, dayOfWeekET } = etParts(now);
  for (const w of cfg.schedule) {
    if (!w.daysOfWeek.includes(dayOfWeekET)) continue;
    if (hourET >= w.startHourET && hourET < w.endHourET) return w;
  }
  return null;
}

/**
 * The effective interval for the matched window, applying aggressiveMode to the
 * Mon–Fri active (08–19 ET) window.
 */
export function effectiveInterval(window: PollWindow, cfg: PollConfig): number {
  const isActiveWindow =
    window.startHourET === ACTIVE_WINDOW.startHourET &&
    window.endHourET === ACTIVE_WINDOW.endHourET;
  if (cfg.aggressiveMode && isActiveWindow) return AGGRESSIVE_ACTIVE_INTERVAL_SEC;
  return window.intervalSec;
}

/**
 * Decide whether the watcher should poll *now*.
 *
 * Returns true iff:
 *   1. the current America/New_York day+hour falls inside a schedule window, AND
 *   2. at least the window's effective intervalSec has elapsed since lastPollAt
 *      (or lastPollAt is null, i.e. we have never polled).
 */
export function shouldPollNow(now: Date, cfg: PollConfig, lastPollAt: Date | null): boolean {
  const window = activeWindow(now, cfg);
  if (!window) return false;

  if (lastPollAt === null) return true;

  const intervalMs = effectiveInterval(window, cfg) * 1000;
  const elapsedMs = now.getTime() - lastPollAt.getTime();
  return elapsedMs >= intervalMs;
}

// ---------------------------------------------------------------------------
// Persistence: poll_config row (D1) + CONFIG_KV cache
// ---------------------------------------------------------------------------

interface PollConfigRow {
  schedule: string | null;
  aggressive_mode: number | null;
  updated_at: string | null;
}

/**
 * Read the current PollConfig. Prefers the CONFIG_KV cache; on miss, reads the
 * D1 poll_config row, repopulates KV, and returns it. Falls back to
 * DEFAULT_CONFIG if neither exists.
 */
export async function getConfig(env: Env): Promise<PollConfig> {
  const cached = await env.CONFIG_KV.get(KV_CONFIG_KEY, 'json');
  if (cached) return cached as PollConfig;

  const row = await get<PollConfigRow>(
    env.DB,
    'SELECT schedule, aggressive_mode, updated_at FROM poll_config WHERE id = 1',
  );
  if (!row) return DEFAULT_CONFIG;

  const cfg: PollConfig = {
    schedule: parseJson<PollWindow[]>(row.schedule, DEFAULT_SCHEDULE),
    aggressiveMode: toBool(row.aggressive_mode),
    updatedAt: row.updated_at ?? DEFAULT_CONFIG.updatedAt,
  };
  await env.CONFIG_KV.put(KV_CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

/**
 * Persist a new PollConfig to D1 (poll_config row 1) and refresh the KV cache.
 * Stamps updatedAt with the current time.
 */
export async function setConfig(env: Env, cfg: PollConfig): Promise<PollConfig> {
  const next: PollConfig = { ...cfg, updatedAt: new Date().toISOString() };
  await run(
    env.DB,
    `INSERT INTO poll_config (id, schedule, aggressive_mode, updated_at)
       VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       schedule = excluded.schedule,
       aggressive_mode = excluded.aggressive_mode,
       updated_at = excluded.updated_at`,
    [JSON.stringify(next.schedule), fromBool(next.aggressiveMode), next.updatedAt],
  );
  await env.CONFIG_KV.put(KV_CONFIG_KEY, JSON.stringify(next));
  return next;
}

/**
 * Read the last poll timestamp for a given source ('house' | 'senate'), or null
 * if never polled. Stored in CONFIG_KV (hot path; not worth a D1 round-trip).
 */
export async function getLastPollAt(env: Env, source: string): Promise<Date | null> {
  const iso = await env.CONFIG_KV.get(`${KV_LAST_POLL_PREFIX}${source}`);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Record the last poll timestamp for a source. Defaults to now. */
export async function setLastPollAt(env: Env, source: string, when: Date = new Date()): Promise<void> {
  await env.CONFIG_KV.put(`${KV_LAST_POLL_PREFIX}${source}`, when.toISOString());
}

const KV_LAST_ATTEMPT_PREFIX = 'last_attempt:';

/**
 * Read the last poll ATTEMPT timestamp for a source (stamped before the poll
 * runs, unlike last_poll:* which only advances on success). The pair drives
 * per-source failure backoff: attempt newer than success == last attempt
 * failed. Defensive about CONFIG_KV so unit fakes without KV stay valid.
 */
export async function getLastAttemptAt(env: Env, source: string): Promise<Date | null> {
  if (!env.CONFIG_KV) return null;
  const iso = await env.CONFIG_KV.get(`${KV_LAST_ATTEMPT_PREFIX}${source}`);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Record a poll attempt timestamp for a source. Defaults to now. */
export async function setLastAttemptAt(env: Env, source: string, when: Date = new Date()): Promise<void> {
  if (!env.CONFIG_KV) return;
  await env.CONFIG_KV.put(`${KV_LAST_ATTEMPT_PREFIX}${source}`, when.toISOString());
}
