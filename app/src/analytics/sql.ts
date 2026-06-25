/**
 * src/analytics/sql.ts
 * OWNER: analytics
 *
 * Shared, dependency-free SQL fragments + filter builders for the analytics
 * layer (the `/api/analytics/*` endpoints). Every aggregation query is built
 * from these pieces so the bracket-midpoint convention, the party/chamber
 * resolution, and the common window/source/confidence filters are applied
 * IDENTICALLY everywhere — and so each builder stays a pure function that can be
 * unit-tested without a database (mirrors src/delivery/rows.ts).
 *
 * Conventions baked into the fragments below:
 *   - transactions are aliased `t`, filers `fl`, filings `f`, securities `sm`.
 *   - Disclosed amounts are STOCK Act *brackets*, never exact: every dollar
 *     metric uses the bracket MIDPOINT ({@link BRACKET_MIDPOINT_SQL}). The
 *     open-ended top tier ($50,000,001+) has amount_max IS NULL and falls back
 *     to the bracket floor (amount_min). All $ figures are therefore ESTIMATES.
 *   - party is frequently empty in the data (seed filers store party=''), so it
 *     is bucketed into D / R / O(ther) by first letter only when known. Unknown
 *     party stays NULL rather than being treated as Independent.
 */

import type { Chamber, TxType } from '../shared/types';
import type { SqlParam } from '../shared/db';

// ---------------------------------------------------------------------------
// Enumerations + validators (closed sets → safe to interpolate as literals)
// ---------------------------------------------------------------------------

/**
 * A window is either 'all' or `<N>d` (N whole days, e.g. '90d'). The UI surfaces
 * the presets below, but any positive `<N>d` is valid — so callers can request a
 * custom age (e.g. ?window=45d) without enumerating it here.
 */
export const WINDOW_PRESETS = ['1d', '7d', '30d', '90d', '180d', '365d', '1825d', 'all'] as const;
export type Window = string; // always produced via asWindow(): 'all' | `${number}d`
const WINDOW_RE = /^(\d{1,5})d$/;
const MAX_WINDOW_DAYS = 36500; // ~100y guardrail against absurd inputs

export function isWindow(v: unknown): v is Window {
  if (v === 'all') return true;
  if (typeof v !== 'string') return false;
  const m = WINDOW_RE.exec(v);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_WINDOW_DAYS;
}
/** Coerce arbitrary input to a valid Window, falling back to `fallback`. */
export function asWindow(v: unknown, fallback: Window = '90d'): Window {
  return isWindow(v) ? (v as Window) : fallback;
}
/** Number of days a window spans, or null for 'all'. Defaults to 30 on garbage. */
export function windowDays(w: Window): number | null {
  if (w === 'all') return null;
  const m = WINDOW_RE.exec(w);
  return m ? Number(m[1]) : 30;
}

export const SOURCE_FILTERS = ['primary', 'seed_dataset', 'manual', 'all'] as const;
export type SourceFilter = (typeof SOURCE_FILTERS)[number];
export function asSourceFilter(v: unknown, fallback: SourceFilter = 'all'): SourceFilter {
  return typeof v === 'string' && (SOURCE_FILTERS as readonly string[]).includes(v)
    ? (v as SourceFilter)
    : fallback;
}

export type PartyBucket = 'D' | 'R' | 'O';
export function asPartyBucket(v: unknown): PartyBucket | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const c = v[0].toUpperCase();
  return c === 'D' ? 'D' : c === 'R' ? 'R' : c === 'O' || c === 'I' ? 'O' : undefined;
}

export function asChamber(v: unknown): Chamber | undefined {
  return v === 'house' || v === 'senate' ? v : undefined;
}

/**
 * Map a window to the SQLite date modifier used in `date('now', ?)`. `all`
 * returns null (no date clause — the whole corpus). The returned strings are a
 * closed set, never user input.
 */
export function windowToOffset(w: Window): string | null {
  const d = windowDays(w);
  return d == null ? null : `-${d} days`;
}

// ---------------------------------------------------------------------------
// Time bucketing (for the time-series endpoints)
// ---------------------------------------------------------------------------

export type Granularity = 'day' | 'week' | 'month';
export function isGranularity(v: unknown): v is Granularity {
  return v === 'day' || v === 'week' || v === 'month';
}
/** Sensible default bucket size for a window when the caller doesn't override. */
export function autoGranularity(w: Window): Granularity {
  const d = windowDays(w);
  if (d == null) return 'month'; // all
  if (d <= 31) return 'day';
  if (d <= 120) return 'week';
  return 'month';
}
/** strftime() format string for a granularity. */
export function granularityFormat(g: Granularity): string {
  return g === 'day' ? '%Y-%m-%d' : g === 'week' ? '%Y-%W' : '%Y-%m';
}

// ---------------------------------------------------------------------------
// Reusable SQL expression fragments
// ---------------------------------------------------------------------------

/**
 * Estimated dollar value of one transaction from its STOCK Act bracket. Uses
 * the bracket midpoint; the open top tier (amount_max IS NULL) falls back to the
 * floor (amount_min); a fully-missing amount contributes 0. THE single source
 * of truth for "$" — every dollar metric interpolates this exact expression.
 */
export const BRACKET_MIDPOINT_SQL =
  '(CASE WHEN t.amount_max IS NOT NULL THEN (t.amount_min + t.amount_max) / 2.0 ' +
  'WHEN t.amount_min IS NOT NULL THEN t.amount_min ELSE 0 END)';

/** Signed midpoint: +mid for purchases, -mid for sales, 0 otherwise (net flow). */
export const SIGNED_MIDPOINT_SQL =
  "(CASE WHEN t.tx_type = 'P' THEN " +
  BRACKET_MIDPOINT_SQL +
  " WHEN t.tx_type = 'S' THEN -" +
  BRACKET_MIDPOINT_SQL +
  ' ELSE 0 END)';

/** Chamber resolved from the filers table, falling back to the owning filing. */
export const CHAMBER_EXPR = 'COALESCE(fl.chamber, f.chamber)';

/** Party bucketed to 'D' | 'R' | 'O' by first letter; unknown stays NULL. */
export const PARTY_BUCKET_SQL =
  "(CASE WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'D' THEN 'D' " +
  "WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) = 'R' THEN 'R' " +
  "WHEN UPPER(SUBSTR(TRIM(COALESCE(fl.party, '')), 1, 1)) IN ('I', 'O') THEN 'O' " +
  'ELSE NULL END)';

/** A non-null, non-empty ticker (the analytics definition of "a resolved asset"). */
export const TICKER_RESOLVED_SQL = "(t.ticker IS NOT NULL AND t.ticker <> '')";

/**
 * Standard FROM/JOIN for analytics queries. Always LEFT JOINs filers (party,
 * chamber, name, photo) and filings (chamber fallback, filed_date for lag), so
 * the common filters below can reference `fl` / `f` in any query. Seed rows
 * whose filer/ filing meta is missing are preserved (LEFT, not INNER).
 */
export const ANALYTICS_FROM_JOINS =
  'FROM transactions t ' +
  'LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id ' +
  'LEFT JOIN filings f ON f.doc_id = t.doc_id ';

/** As {@link ANALYTICS_FROM_JOINS} but also joins the securities master (name). */
export const ANALYTICS_FROM_JOINS_SECURITIES =
  ANALYTICS_FROM_JOINS + 'LEFT JOIN securities_master sm ON sm.ticker = t.ticker ';

/**
 * As {@link ANALYTICS_FROM_JOINS} but also joins the enrichment reference
 * (securities_ref `sr`) so a query can group/filter by real GICS sector and
 * market-cap bucket. LEFT, so un-enriched tickers are preserved (sr.* NULL).
 */
export const ANALYTICS_FROM_JOINS_REF =
  ANALYTICS_FROM_JOINS + 'LEFT JOIN securities_ref sr ON sr.ticker = t.ticker ';

// ---------------------------------------------------------------------------
// Common filter builder
// ---------------------------------------------------------------------------

export interface CommonFilters {
  /** Time window applied to t.tx_date. 'all' drops the date clause. */
  window?: Window;
  chamber?: Chamber;
  /** Party bucket (D/R/O); matched against {@link PARTY_BUCKET_SQL}. */
  party?: PartyBucket;
  /** 'all' (default) applies no source filter; else t.source = source. */
  source?: SourceFilter;
  /** Minimum per-row confidence (omit for no filter). */
  minConf?: number;
  /** Require a resolved (non-null, non-empty) ticker. */
  tickerNotNull?: boolean;
  /** Restrict to these transaction types (e.g. ['P','S']). */
  txTypes?: TxType[];
  /** Restrict to this explicit set of tickers (e.g. a precomputed candidate set). */
  tickers?: string[];
}

/**
 * Build the shared WHERE fragments + ordered bind params for an analytics query.
 * Params are emitted in WHERE-clause order; callers that also bind SELECT-side
 * params (e.g. a strftime() format) must prepend those before these.
 */
export function buildCommonFilters(p: CommonFilters): { where: string[]; params: SqlParam[] } {
  const where: string[] = [];
  const params: SqlParam[] = [];

  // Retracted (un-published) rows never appear in any analytics aggregate.
  where.push('t.deprecated_at IS NULL');

  const offset = windowToOffset(p.window ?? '30d');
  if (offset) {
    where.push("t.tx_date >= date('now', ?)");
    params.push(offset);
  }
  if (p.chamber) {
    where.push(`${CHAMBER_EXPR} = ?`);
    params.push(p.chamber);
  }
  if (p.party) {
    where.push(`${PARTY_BUCKET_SQL} = ?`);
    params.push(p.party);
  }
  if (p.source && p.source !== 'all') {
    where.push('t.source = ?');
    params.push(p.source);
  }
  if (typeof p.minConf === 'number' && Number.isFinite(p.minConf)) {
    where.push('t.confidence >= ?');
    params.push(p.minConf);
  }
  if (p.tickerNotNull) {
    where.push(TICKER_RESOLVED_SQL);
  }
  if (p.txTypes && p.txTypes.length) {
    where.push(`t.tx_type IN (${p.txTypes.map(() => '?').join(', ')})`);
    for (const ty of p.txTypes) params.push(ty);
  }
  if (p.tickers && p.tickers.length) {
    where.push(`t.ticker IN (${p.tickers.map(() => '?').join(', ')})`);
    for (const tk of p.tickers) params.push(tk);
  }

  return { where, params };
}

/** Render a WHERE clause (with trailing space) from fragments, or '' if none. */
export function whereSql(where: string[]): string {
  return where.length ? `WHERE ${where.join(' AND ')} ` : '';
}

/** Clamp an arbitrary limit to a sane integer in [1, max]. */
export function clampLimit(v: unknown, fallback: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
