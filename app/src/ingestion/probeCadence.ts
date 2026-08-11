/**
 * src/ingestion/probeCadence.ts
 * OWNER: cadence lane (claude/probe-cadence)
 *
 * WHAT THIS IS
 * ------------
 * A pure, budget-exact tiered probe schedule. It answers exactly one question:
 * **how often should we probe in a given America/New_York hour**, given a fixed
 * daily API budget.
 *
 * It deliberately does NOT decide *who* probes (server vs Mac). That is the
 * lease's job (see scoutHandoff / scheduledTick). This module is the "how
 * often" half and is safe for the lease code to import: every export here is a
 * pure function with no I/O, no env access, and no shared mutable state.
 *
 * WHY THE WINDOWS LOOK LIKE THIS (measured 2026-08-11, not guessed)
 * -----------------------------------------------------------------
 * Measured against production `filings` (all ingestion paths), restricted to
 * "fresh" arrivals (first_seen_at within 3 days of filed_date, which excludes
 * the bulk backfill runs that otherwise dominate the table), 2026-06-21 →
 * 2026-08-11:
 *
 *   HOUSE  — 23 of 29 active days had their arrival in the 09:00 ET hour.
 *            The House Clerk regenerates the yearly bulk ZIP roughly daily and
 *            it lands ~09:00 ET. Volume outside 09:00–11:00 ET is one-off.
 *   SENATE — genuinely intraday, concentrated 16:00–20:00 ET (8 of 15
 *            day-hour events), with a thin overnight ~02:00 ET refresh.
 *   WEEKEND— 3 of 257 fresh filings (1.2%) landed on Sat/Sun.
 *
 * The important consequence: the House and Senate peaks are at *different times
 * of day*. A single global "business hours" peak is wrong for one of them. The
 * pre-existing global band table (tradeLatency.disclosurePublishYieldBand)
 * peaks at 08–12 ET, which is right for the House and inverted for the Senate
 * (Senate's real peak, 16–20 ET, is that table's `mid` tier). Hence the
 * per-chamber weight tables below, plus a COMBINED table for provider probes,
 * which cover both chambers in one call and therefore want the union.
 *
 * SAMPLE-SIZE CAVEAT (read before retuning)
 * -----------------------------------------
 * The House 09:00 ET spike is strong (23/29 days, one mechanism, corroborated
 * by two independent instruments). The Senate shape rests on 30 fresh filings
 * across 13 active days and is INDICATIVE ONLY. No hour is ever given weight 0
 * — every hour keeps a floor so a mis-measured window can still self-correct
 * instead of making us permanently blind there.
 *
 * BUDGET SAFETY
 * -------------
 * This is a REALLOCATION, not an increase. `allocateRunsByHour` distributes a
 * fixed daily run budget across the 24 ET hours in proportion to weight, then
 * clamps each hour to [minIntervalSec, maxIntervalSec] and redistributes any
 * budget freed by clamping. The returned allocation is guaranteed never to
 * exceed the cap (see `totalRuns` in the returned plan, asserted by tests).
 * Probing denser at 09:00 ET is paid for by probing sparser overnight.
 */

/** Tier names, highest yield first. */
export type ProbeTier = 'surge' | 'high' | 'base' | 'trough';

/** Which arrival rhythm a caller is scheduling against. */
export type CadenceProfile = 'house' | 'senate' | 'combined';

/**
 * Relative probe frequency per tier.
 *
 * surge:trough is 20:1 and surge:base is 4:1. The owner asked for "at least 2
 * different frequencies, 3-4 or more if wise", with peak 2–3× trough as a
 * floor. Four tiers is the right number here because the measurement shows four
 * genuinely distinguishable regimes (a one-hour daily House spike, a four-hour
 * Senate afternoon, a low-but-nonzero midday tail, and a near-dead overnight) —
 * three would have to merge the House spike into the midday tail and lose most
 * of the benefit, and five would be splitting hairs the sample cannot support.
 */
export const PROBE_TIER_WEIGHT: Record<ProbeTier, number> = {
  surge: 6.0,
  high: 3.0,
  base: 1.5,
  trough: 0.3,
};

/** Weekend downshift: one tier down, floored at trough (weekends ≈ 1.2%). */
const WEEKEND_DOWNSHIFT: Record<ProbeTier, ProbeTier> = {
  surge: 'high',
  high: 'base',
  base: 'trough',
  trough: 'trough',
};

/**
 * Per-profile ET-hour → tier tables (weekday shape; weekends are downshifted
 * from these by `probeTier`). Index is the ET hour, 0–23.
 */
const HOUSE_HOURS: ProbeTier[] = [
  /* 00 */ 'trough', 'trough', 'trough', 'trough', 'trough', 'trough',
  /* 06 */ 'trough', 'trough',
  /* 08 */ 'base', // pre-spike guard: the ZIP sometimes lands early
  /* 09 */ 'surge', // 23 of 29 active days land here
  /* 10 */ 'surge', // spillover + late-landing rebuilds
  /* 11 */ 'base',
  /* 12 */ 'base', 'base', 'base', 'base',
  /* 16 */ 'base',
  /* 17 */ 'base', 'base', 'base',
  /* 20 */ 'trough', 'trough', 'trough', 'trough',
];

const SENATE_HOURS: ProbeTier[] = [
  /* 00 */ 'trough',
  /* 01 */ 'base', 'base', // thin but repeated ~02:00 ET index refresh
  /* 03 */ 'trough', 'trough', 'trough', 'trough', 'trough',
  /* 08 */ 'base',
  /* 09 */ 'base', 'base', 'base',
  /* 12 */ 'high', 'high', 'high',
  /* 15 */ 'high',
  /* 16 */ 'surge', 'surge', // 6 of 15 day-hour events
  /* 18 */ 'surge', 'surge', // 3 of 15, incl. the 19:00 cluster
  /* 20 */ 'high',
  /* 21 */ 'trough', 'trough', 'trough',
];

/**
 * COMBINED — what provider probes (FMP / Unusual Whales / Quiver) should use,
 * because one probe call covers both chambers. Per hour this is the stronger of
 * the two chamber tiers, so neither peak is starved.
 */
const COMBINED_HOURS: ProbeTier[] = [
  /* 00 */ 'trough',
  /* 01 */ 'base', 'base',
  /* 03 */ 'trough', 'trough', 'trough', 'trough', 'trough',
  /* 08 */ 'base',
  /* 09 */ 'surge', 'surge',
  /* 11 */ 'base',
  /* 12 */ 'high', 'high', 'high',
  /* 15 */ 'high',
  /* 16 */ 'surge', 'surge',
  /* 18 */ 'surge', 'surge',
  /* 20 */ 'high',
  /* 21 */ 'trough', 'trough', 'trough',
];

const PROFILE_HOURS: Record<CadenceProfile, ProbeTier[]> = {
  house: HOUSE_HOURS,
  senate: SENATE_HOURS,
  combined: COMBINED_HOURS,
};

// ---------------------------------------------------------------------------
// ET resolution
// ---------------------------------------------------------------------------

/**
 * ET hour (0–23) + weekday (0=Sun..6=Sat) for an instant.
 *
 * Uses Intl with timeZone America/New_York so US DST is exact — the measured
 * windows are wall-clock ET (the House/Senate clerks' own timezone), so a fixed
 * UTC offset would drift the entire schedule by an hour twice a year. Falls
 * back to UTC only if Intl throws, which no supported runtime does.
 */
export function etHourAndDay(now: Date): { hourET: number; dayET: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(now);
    const rawHour = parts.find((p) => p.type === 'hour')?.value ?? '';
    let hourET = parseInt(rawHour, 10);
    if (!Number.isFinite(hourET) || hourET === 24) hourET = 0;
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayET = map[parts.find((p) => p.type === 'weekday')?.value ?? ''] ?? now.getUTCDay();
    return { hourET, dayET };
  } catch {
    return { hourET: now.getUTCHours(), dayET: now.getUTCDay() };
  }
}

/** The tier in force right now for a profile (weekend-downshifted). */
export function probeTier(now: Date = new Date(), profile: CadenceProfile = 'combined'): ProbeTier {
  const { hourET, dayET } = etHourAndDay(now);
  const table = PROFILE_HOURS[profile] ?? COMBINED_HOURS;
  const tier = table[hourET] ?? 'base';
  const isWeekend = dayET === 0 || dayET === 6;
  return isWeekend ? WEEKEND_DOWNSHIFT[tier] : tier;
}

/** Relative frequency weight in force right now. */
export function probeWeight(now: Date = new Date(), profile: CadenceProfile = 'combined'): number {
  return PROBE_TIER_WEIGHT[probeTier(now, profile)];
}

// ---------------------------------------------------------------------------
// Budget-exact allocation
// ---------------------------------------------------------------------------

export interface HourAllocation {
  hourET: number;
  tier: ProbeTier;
  /** Probe runs allotted to this ET hour. */
  runs: number;
  /** Seconds between probes inside this hour (3600 / runs), clamped. */
  intervalSec: number;
}

export interface CadencePlan {
  profile: CadenceProfile;
  /** True if this plan is for a Sat/Sun (weekend-downshifted). */
  weekend: boolean;
  hours: HourAllocation[];
  /** Sum of `runs`; guaranteed <= dailyRuns. */
  totalRuns: number;
  /** The cap this plan was built against. */
  dailyRuns: number;
}

export interface AllocateOptions {
  /** Total probe RUNS available for the day (calls / callsPerRun). */
  dailyRuns: number;
  profile?: CadenceProfile;
  weekend?: boolean;
  /** Floor on spacing inside an hour. Default 60s. */
  minIntervalSec?: number;
  /** Ceiling on spacing inside an hour. Default 45min. */
  maxIntervalSec?: number;
}

/**
 * Distribute a fixed daily run budget across the 24 ET hours by tier weight.
 *
 * Two-pass, so clamping cannot silently overspend or waste budget:
 *   pass 1 — proportional split; any hour whose implied interval would be
 *            FASTER than minIntervalSec is pinned at its max sustainable runs
 *            and removed from the pool.
 *   pass 2 — the freed remainder is re-split across the still-unpinned hours by
 *            weight; hours whose interval would exceed maxIntervalSec are
 *            floored to zero runs (we skip that hour entirely rather than probe
 *            on a uselessly long interval) and their share returns to the pool.
 *
 * The result always satisfies sum(runs) <= dailyRuns.
 */
export function allocateRunsByHour(opts: AllocateOptions): CadencePlan {
  const profile = opts.profile ?? 'combined';
  const weekend = opts.weekend ?? false;
  const minIntervalSec = Math.max(1, opts.minIntervalSec ?? 60);
  const maxIntervalSec = Math.max(minIntervalSec, opts.maxIntervalSec ?? 45 * 60);
  const dailyRuns = Math.max(0, Math.floor(opts.dailyRuns));

  const table = PROFILE_HOURS[profile] ?? COMBINED_HOURS;
  const tiers: ProbeTier[] = Array.from({ length: 24 }, (_, h) => {
    const t = table[h] ?? 'base';
    return weekend ? WEEKEND_DOWNSHIFT[t] : t;
  });

  const maxRunsPerHour = Math.floor(3600 / minIntervalSec);
  const minRunsPerHour = 3600 / maxIntervalSec;

  const runs = new Array<number>(24).fill(0);
  const pinned = new Array<boolean>(24).fill(false);
  let pool = dailyRuns;

  // Pass 1: pin hours that would exceed the per-hour ceiling.
  for (let guard = 0; guard < 24; guard += 1) {
    const openHours = tiers
      .map((t, h) => ({ h, w: PROBE_TIER_WEIGHT[t] }))
      .filter(({ h }) => !pinned[h]);
    const totalWeight = openHours.reduce((s, o) => s + o.w, 0);
    if (totalWeight <= 0 || pool <= 0) break;

    let changed = false;
    for (const { h, w } of openHours) {
      const share = (pool * w) / totalWeight;
      if (share > maxRunsPerHour) {
        runs[h] = maxRunsPerHour;
        pinned[h] = true;
        pool -= maxRunsPerHour;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Pass 2: split the remainder; drop hours that fall under the floor.
  for (let guard = 0; guard < 24; guard += 1) {
    const openHours = tiers
      .map((t, h) => ({ h, w: PROBE_TIER_WEIGHT[t] }))
      .filter(({ h }) => !pinned[h]);
    const totalWeight = openHours.reduce((s, o) => s + o.w, 0);
    if (totalWeight <= 0 || pool <= 0) break;

    let changed = false;
    for (const { h, w } of openHours) {
      const share = (pool * w) / totalWeight;
      if (share < minRunsPerHour) {
        runs[h] = 0;
        pinned[h] = true;
        changed = true;
      }
    }
    if (changed) continue;

    for (const { h, w } of openHours) {
      runs[h] = (pool * w) / totalWeight;
      pinned[h] = true;
    }
    break;
  }

  const hours: HourAllocation[] = runs.map((r, h) => ({
    hourET: h,
    tier: tiers[h],
    runs: r,
    intervalSec: r > 0 ? Math.min(maxIntervalSec, Math.max(minIntervalSec, Math.round(3600 / r))) : 0,
  }));

  return {
    profile,
    weekend,
    hours,
    totalRuns: hours.reduce((s, x) => s + x.runs, 0),
    dailyRuns,
  };
}

/**
 * Seconds until the next probe, for the CURRENT ET hour, under a fixed daily
 * budget.
 *
 * This is the drop-in the lease/tick code should call. Its option shape is
 * deliberately a superset of tradeLatency's existing `budgetedProbeIntervalSec`
 * ({ now, remainingRuns, minIntervalSec, maxIntervalSec }) so it can be
 * substituted without touching that function's other callers: pass the same
 * four fields plus `dailyRuns` and (optionally) `profile`.
 *
 * Difference in behaviour vs the existing helper: that one spreads *remaining*
 * runs over the *rest of the UTC day* and then divides by a yield weight, which
 * front-loads whichever tier happens to come first in the UTC day. This one
 * allocates against the whole ET day up front, so the interval for a given ET
 * hour is stable regardless of when in the day you ask, and the daily total is
 * exact rather than emergent.
 *
 * `remainingRuns` is still honoured as a hard brake: once the day's budget is
 * nearly spent we stretch to maxIntervalSec no matter what tier we are in.
 */
export function probeIntervalSec(opts: {
  now?: Date;
  /** Total runs the budget allows per day (calls / callsPerRun). */
  dailyRuns: number;
  /** Runs still unspent today. Optional; used only as a brake. */
  remainingRuns?: number;
  profile?: CadenceProfile;
  minIntervalSec?: number;
  maxIntervalSec?: number;
}): number {
  const now = opts.now ?? new Date();
  const minIntervalSec = Math.max(1, opts.minIntervalSec ?? 60);
  const maxIntervalSec = Math.max(minIntervalSec, opts.maxIntervalSec ?? 45 * 60);
  const { hourET, dayET } = etHourAndDay(now);
  const weekend = dayET === 0 || dayET === 6;

  if (opts.remainingRuns !== undefined && opts.remainingRuns < 1) return maxIntervalSec;

  const plan = allocateRunsByHour({
    dailyRuns: opts.dailyRuns,
    profile: opts.profile ?? 'combined',
    weekend,
    minIntervalSec,
    maxIntervalSec,
  });
  const slot = plan.hours[hourET];
  if (!slot || slot.runs <= 0) return maxIntervalSec;
  return slot.intervalSec;
}

/**
 * Human-readable plan, for the admin UI / a PR body / a sanity check.
 * Returns one line per ET hour plus a total, e.g.
 *   `09 ET  surge   37.5 runs  every 96s`
 */
export function describePlan(plan: CadencePlan): string[] {
  const lines = plan.hours.map((h) => {
    const label = String(h.hourET).padStart(2, '0');
    const runs = h.runs.toFixed(1).padStart(6);
    const iv = h.runs > 0 ? `every ${h.intervalSec}s` : 'skipped';
    return `${label} ET  ${h.tier.padEnd(6)} ${runs} runs  ${iv}`;
  });
  lines.push(
    `TOTAL ${plan.totalRuns.toFixed(1)} runs / cap ${plan.dailyRuns}` +
      (plan.weekend ? ' (weekend downshift)' : ''),
  );
  return lines;
}
