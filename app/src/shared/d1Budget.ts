/**
 * src/shared/d1Budget.ts
 *
 * App-level D1 rows-read / rows-written daily budget guard.
 *
 * Cloudflare D1 bills per row read/written and has NO hard spend cap — a runaway
 * scan or backfill accrues cost with only after-the-fact budget *alerts*, which
 * is how a $10 budget got blown. This module gives the app its own ceiling:
 *
 *   - METER: every all()/run()/batch() through shared/db.ts reports its
 *     D1Meta.rows_read / rows_written here (recordD1Meta), accumulated per
 *     isolate and flushed once per invocation to an atomic D1 day-counter.
 *   - ALERT (default, always on): flushD1Budget() warns + sends a Sentry
 *     message when the day's total crosses a soft fraction of the budget, so a
 *     spike is visible in hours, not at invoice time. No blocking.
 *   - ENFORCE (opt-in, default OFF): when D1_ROW_BUDGET_ENFORCE is truthy AND
 *     the day's total exceeds the hard budget, isD1RowBudgetExceeded() returns
 *     true so discretionary batch work (the daily enrichment/price/backfill
 *     jobs) can self-abort. It never gates health, auth, billing, delivery, or
 *     the public read path.
 *
 * Everything here FAILS OPEN: any D1/KV/meta error is swallowed so the guard
 * can never take the app down. D1's atomic counter prevents concurrent isolate
 * flushes from losing increments; reconcile against D1's own Row Metrics for
 * the authoritative number.
 *
 * NOTE: get() in shared/db.ts uses .first(), which returns the row directly and
 * carries no D1Meta, so single-row point reads are intentionally unmetered. The
 * expensive unindexed point reads that motivated this are addressed by indexing
 * (migration 0044) + caching, not here.
 */

import * as Sentry from '@sentry/cloudflare';
import type { Env } from './types';
import { resolveSecret } from '../secrets/infisical';

interface RowDelta {
  read: number;
  written: number;
}

/**
 * Per-isolate accumulator. Reused across invocations in the same isolate until
 * flushed; flushD1Budget() snapshots + resets it. Cross-invocation/cross-isolate
 * attribution is fuzzy by design — only the daily totals need to be roughly right.
 */
let pending: RowDelta = { read: 0, written: 0 };

/** Best-known day totals from the last flush, so the enforce check can usually
 *  answer without a KV round trip. */

/** Day we last emitted a soft-threshold warning for (once per isolate per day). */
let warnedDay: string | null = null;

// Reads are cheap ($0.001/M, 25B/mo included ≈ 833M/day free), so this is really
// an anomaly tripwire for scan storms rather than a dollar cap. Writes are the
// expensive dimension ($1/M, 50M/mo included ≈ 1.66M/day); 2M/day ≈ 60M/mo ≈
// ~$10/mo of billable writes, matching the owner's budget. Both Infisical-tunable.
const DEFAULT_READ_BUDGET = 200_000_000;
const DEFAULT_WRITTEN_BUDGET = 2_000_000;
const SOFT_RATIO = 0.8;
const DAY_TTL_SEC = 172_800; // 2 days, same as the FMP counter

function dayStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dayKey(kind: 'read' | 'written', now: Date): string {
  return `d1:rows_${kind}:${dayStr(now)}`;
}

interface DayTotals {
  read: number;
  written: number;
}

function intVar(v: string | undefined, fallback: number): number {
  const n = parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

interface RowBudgets {
  read: number;
  written: number;
}

async function rowBudgets(env: Env): Promise<RowBudgets> {
  try {
    const [read, written] = await Promise.all([
      resolveSecret(env, 'D1_DAILY_ROWS_READ_BUDGET'),
      resolveSecret(env, 'D1_DAILY_ROWS_WRITTEN_BUDGET'),
    ]);
    return {
      read: intVar(read.value ?? env.D1_DAILY_ROWS_READ_BUDGET, DEFAULT_READ_BUDGET),
      written: intVar(written.value ?? env.D1_DAILY_ROWS_WRITTEN_BUDGET, DEFAULT_WRITTEN_BUDGET),
    };
  } catch {
    return {
      read: intVar(env.D1_DAILY_ROWS_READ_BUDGET, DEFAULT_READ_BUDGET),
      written: intVar(env.D1_DAILY_ROWS_WRITTEN_BUDGET, DEFAULT_WRITTEN_BUDGET),
    };
  }
}

/**
 * Record a D1 result's metered rows. Called on the hot path (every all/run/batch),
 * so it is synchronous, allocation-free, and never throws.
 */
export function recordD1Meta(
  meta: { rows_read?: number; rows_written?: number } | null | undefined,
): void {
  if (!meta) return;
  const r = meta.rows_read;
  const w = meta.rows_written;
  if (typeof r === 'number' && r > 0) pending.read += r;
  if (typeof w === 'number' && w > 0) pending.written += w;
}

/** Atomically add both dimensions in one D1 statement. Returns null only when
 * the binding/schema is unavailable, allowing the compatibility fallback. */
async function bumpD1Totals(env: Env, delta: RowDelta, now: Date): Promise<DayTotals | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    await db.prepare(
      `INSERT INTO d1_budget (day, rows_read, rows_written) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         rows_read = rows_read + excluded.rows_read,
         rows_written = rows_written + excluded.rows_written`,
    ).bind(dayStr(now), delta.read, delta.written).run();
    const row = await db
      .prepare('SELECT rows_read, rows_written FROM d1_budget WHERE day = ?')
      .bind(dayStr(now))
      .first<{ rows_read: number; rows_written: number }>();
    return {
      read: Number(row?.rows_read ?? 0),
      written: Number(row?.rows_written ?? 0),
    };
  } catch {
    return null;
  }
}

/** Compatibility path for isolates running before migration 0045 is applied. */
async function bumpKvTotals(env: Env, delta: RowDelta, now: Date): Promise<DayTotals> {
  const readKey = dayKey('read', now);
  const writtenKey = dayKey('written', now);
  const [read, written] = await Promise.all([env.CONFIG_KV.get(readKey), env.CONFIG_KV.get(writtenKey)]);
  const totals = {
    read: (parseInt(read ?? '0', 10) || 0) + delta.read,
    written: (parseInt(written ?? '0', 10) || 0) + delta.written,
  };
  await Promise.all([
    env.CONFIG_KV.put(readKey, String(totals.read), { expirationTtl: DAY_TTL_SEC }),
    env.CONFIG_KV.put(writtenKey, String(totals.written), { expirationTtl: DAY_TTL_SEC }),
  ]);
  return totals;
}

async function readD1Totals(env: Env, now: Date): Promise<DayTotals | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = await db
      .prepare('SELECT rows_read, rows_written FROM d1_budget WHERE day = ?')
      .bind(dayStr(now))
      .first<{ rows_read: number; rows_written: number }>();
    return {
      read: Number(row?.rows_read ?? 0),
      written: Number(row?.rows_written ?? 0),
    };
  } catch {
    return null;
  }
}

function warnIfOverSoft(
  day: string,
  readTotal: number | null,
  writtenTotal: number | null,
  budgets: RowBudgets,
): void {
  const rB = budgets.read;
  const wB = budgets.written;
  const overRead = readTotal != null && readTotal >= rB * SOFT_RATIO;
  const overWritten = writtenTotal != null && writtenTotal >= wB * SOFT_RATIO;
  if (!overRead && !overWritten) return;
  if (warnedDay === day) return; // at most once per isolate per day
  warnedDay = day;
  const msg =
    `D1 daily row budget >= ${SOFT_RATIO * 100}% soft threshold: ` +
    `read ${readTotal ?? '?'}/${rB}, written ${writtenTotal ?? '?'}/${wB}`;
  console.warn(msg);
  try {
    Sentry.captureMessage(msg, 'warning');
  } catch {
    /* best-effort alert */
  }
}

/**
 * Flush the isolate's accumulated D1 row usage to today's atomic D1 counter, and warn
 * if the day's total crossed the soft threshold. Call once at an invocation tail
 * (via ctx.waitUntil). No-op when nothing is pending; fails open.
 */
export async function flushD1Budget(env: Env, now = new Date()): Promise<void> {
  const snap = pending;
  if (snap.read === 0 && snap.written === 0) return;
  pending = { read: 0, written: 0 };
  try {
    const day = dayStr(now);
    // The atomic D1 counter update is itself one D1 row write. Include that
    // write in the D1 budget so read-only traffic cannot evade the write alarm
    // merely because its application queries reported rows_written = 0.
    const d1Delta = { read: snap.read, written: snap.written + 1 };
    const totals = (await bumpD1Totals(env, d1Delta, now)) ?? (await bumpKvTotals(env, snap, now));
    const { read: readTotal, written: writtenTotal } = totals;
    warnIfOverSoft(day, readTotal, writtenTotal, await rowBudgets(env));
  } catch {
    /* best-effort meter; never surface an error to the caller */
  }
}

async function enforceEnabled(env: Env): Promise<boolean> {
  try {
    const live = (await resolveSecret(env, 'D1_ROW_BUDGET_ENFORCE')).value ?? env.D1_ROW_BUDGET_ENFORCE;
    return truthy(live);
  } catch {
    return truthy(env.D1_ROW_BUDGET_ENFORCE);
  }
}

/**
 * True only when enforcement is armed (D1_ROW_BUDGET_ENFORCE truthy) AND today's
 * metered D1 rows read/written already exceeded the hard budget. Used by the
 * discretionary daily jobs to self-abort. Fails open (returns false) on any error.
 */
export async function isD1RowBudgetExceeded(env: Env, now = new Date()): Promise<boolean> {
  try {
    if (!(await enforceEnabled(env))) return false;
    // Flush local work first, then always read the shared counters. The
    await flushD1Budget(env, now);
    const totals = (await readD1Totals(env, now)) ?? {
      read: parseInt((await env.CONFIG_KV.get(dayKey('read', now))) ?? '0', 10) || 0,
      written: parseInt((await env.CONFIG_KV.get(dayKey('written', now))) ?? '0', 10) || 0,
    };
    const budgets = await rowBudgets(env);
    return totals.read >= budgets.read || totals.written >= budgets.written;
  } catch {
    return false;
  }
}
