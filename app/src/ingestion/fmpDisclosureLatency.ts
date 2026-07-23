/**
 * src/ingestion/fmpDisclosureLatency.ts
 * OWNER: ingestion
 *
 * Provider-latency monitor for congressional disclosures. Candidates are
 * created when Congress.Trade first sees a new filing; provider observations
 * are populated from third-party "latest" endpoints. The public comparison
 * is deliberately limited to the intersection of both feeds and publishes
 * the provider-observed denominator separately, so a Congress.Trade miss
 * cannot silently turn into a speed win.
 */

import type { Env } from '../shared/types.ts';
import { all, run, batch, get } from '../shared/db.ts';
import type { SqlParam } from '../shared/db.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { notifyAdmin } from '../alerts/notify.ts';
import { assertFmpTierOk } from '../shared/fmpStatus.ts';
import { getLastPollAt, setLastPollAt } from '../shared/config.ts';
import { getSharedFmpPacer } from '../shared/pace.ts';
import { getDailyUsed, addDailyUsed } from '../enrichment/service.ts';
import type { DiscoveredFiling } from './watcher.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

type Chamber = 'house' | 'senate' | 'executive';
type ProviderId = 'fmp' | 'unusual_whales' | 'quiver' | 'finnhub' | 'ainvest' | 'capitol_trades';

type EnvWithWatch = Env & {
  DISCLOSURE_LATENCY_WATCH_ENABLED?: string;
  DISCLOSURE_LATENCY_PROVIDERS?: string;
  DISCLOSURE_LATENCY_WATCH_LIMIT?: string;
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
};

interface CandidateRow {
  doc_id: string;
  provider: ProviderId;
  chamber: Chamber;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  congress_first_seen_at: string;
  attempts: number;
}

interface ProviderObservationRow {
  provider: ProviderId;
  chamber: Chamber;
  provider_key: string;
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
  candidates: number;
  matched: number;
  pending: number;
  errored: number;
  /** Rows observed by the provider during the active monitor window. */
  providerObserved: number;
  /** Provider rows old enough that a late Congress.Trade match is no longer pending. */
  maturedProviderObserved: number;
  /** Provider rows without a high-confidence Congress.Trade match after the grace period. */
  unmatchedProvider: number;
  /** Recent provider rows still inside the late-match grace period. */
  pendingProvider: number;
  /** Congress.Trade candidates old enough for a directional coverage estimate. */
  maturedCandidates: number;
  /** Jointly observed, high-confidence rows in the matured provider cohort. */
  maturedMatched: number;
  /** Congress.Trade coverage of the provider-observed matured cohort. */
  ctCoveragePct: number | null;
  /** Provider coverage of the Congress.Trade matured candidate cohort. */
  providerCoveragePct: number | null;
  /** Jaccard overlap of the two matured observed cohorts. */
  overlapPct: number | null;
  comparisonStatus: 'insufficient' | 'limited' | 'usable';
  comparisonBasis: 'matched-overlap-only';
  ctAheadMonitorCount: number;
  providerAheadMonitorCount: number;
  tieMonitorCount: number;
  avgMonitorDeltaSec: number | null;
  medianMonitorDeltaSec: number | null;
  p90MonitorDeltaSec: number | null;
  avgProviderPublishedDeltaSec: number | null;
  medianProviderPublishedDeltaSec: number | null;
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
  totals: DisclosureLatencyTotals;
  providers: DisclosureLatencyProviderMetrics[];
  providerStatuses: DisclosureLatencyProviderStatus[];
  publicSummary: {
    generatedAt: string;
    totals: DisclosureLatencyTotals;
    providers: DisclosureLatencyProviderMetrics[];
  };
}

interface ProviderDefinition {
  id: ProviderId;
  label: string;
  secretNames: string[];
  requiresMembership: boolean;
  supportsDirectLatest: boolean;
  timestampKind: 'provider' | 'monitor' | 'none';
  reason?: string;
  fetchRows?: (
    apiKey: string,
    max: number,
    fetchImpl: typeof fetch,
    pace?: () => Promise<void>,
  ) => Promise<DisclosureProviderRow[]>;
}

const DEFAULT_LIMIT = 100;
const RECENT_PROVIDER_HOURS = 72;
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
/** Mirrors DEFAULT_DAILY_CAP in enrichment/service.ts (free-tier fallback). */
const FMP_DEFAULT_DAILY_CAP = 230;
/**
 * FMP HTTP requests one probe run fires (house-latest + senate-latest, in
 * parallel via fetchFmpRows). The daily-cap guard reserves room for the WHOLE
 * batch before firing, so the pair can't push the shared counter past the cap.
 * A single coarse `used >= cap` check runs once before both concurrent calls, so
 * at used = cap-1 it would otherwise pass and leave the counter at cap+1;
 * reserving the batch matches enrichment's per-call hard non-overshoot guarantee.
 */
const FMP_LATEST_CALLS_PER_RUN = 2;

/** The shared FMP daily call cap (same env var enrichment/prices read).
 *  Resolved through the secret resolver so operators can tune
 *  `FMP_DAILY_CALL_CAP` in Infisical without redeploying the Worker. */
async function fmpDailyCap(env: Env): Promise<number> {
  const live = (await resolveSecret(env, 'FMP_DAILY_CALL_CAP')).value ?? env.FMP_DAILY_CALL_CAP;
  return parseInt(live || '', 10) || FMP_DEFAULT_DAILY_CAP;
}
const DIRECT_PROVIDER_IDS: ProviderId[] = ['fmp', 'unusual_whales', 'quiver'];

// The latest endpoints are finite windows, not authoritative historical
// indexes. Keep the scoreboard scoped to observations active in this window,
// then allow a full day for our watcher to catch up before calling a row
// unmatched. These are intentionally conservative public-comparison gates.
export const LATENCY_SCORE_WINDOW_HOURS = 72;
export const LATENCY_MATURITY_GRACE_HOURS = 24;
export const LATENCY_MIN_MATURED_ROWS = 20;
export const LATENCY_MIN_COVERAGE_PCT = 80;

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'fmp',
    label: 'Financial Modeling Prep',
    secretNames: ['FMP_API_KEY'],
    requiresMembership: true,
    supportsDirectLatest: true,
    timestampKind: 'monitor',
    reason: 'FMP exposes disclosure/transaction dates, but not a provider first-seen timestamp.',
    fetchRows: fetchFmpRows,
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

async function enabled(env: EnvWithWatch): Promise<boolean> {
  // wrangler.toml carries the literal fallback (DISCLOSURE_LATENCY_WATCH_ENABLED
  // = "true" in production); resolveSecret already falls back to env[key] when
  // Infisical has nothing configured for this name, so passing that same value
  // via `?? env.DISCLOSURE_LATENCY_WATCH_ENABLED` keeps zero-Infisical-configured
  // behavior identical while letting Infisical override it when set.
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

export function parseFmpDisclosureRows(chamber: Chamber, json: unknown): FmpDisclosureRow[] {
  return extractRows(json)
    .filter((payload) => {
      const type = (fieldString(payload, ['assetType', 'type', 'asset_type']) || '').toLowerCase();
      if (type.includes('etf') || type.includes('bond') || type.includes('fund') || type.includes('note') || type.includes('bill')) return false;
      return true;
    })
    .map((payload) => {
    const sourceUrl = firstUrl(payload);
    const text = rowText(payload);
    const docToken = providerKeyFromUrl(sourceUrl) ?? fieldString(payload, ['docId', 'documentId', 'reportId', 'disclosureId', 'disclosure_id']);
    const providerKey = docToken ? String(docToken).toLowerCase() : simpleHash(text);
    return {
      provider: 'fmp',
      chamber,
      providerKey,
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
    const filedDate = normalizeDate(fieldString(payload, ['filed_at_date', 'filingDate', 'filedDate']));
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
      payload,
      sourceUrl: firstUrl(payload),
      filedDate,
      filerName,
      providerPublishedAt: null,
    };
  });
}

export function parseQuiverDisclosureRows(chamber: Chamber, json: unknown): DisclosureProviderRow[] {
  return extractRows(json).map((payload) => {
    const filedDate = normalizeDate(fieldString(payload, ['Filed', 'ReportDate', 'report_date', 'filed_date']));
    const filerName = fieldString(payload, ['Representative', 'Senator', 'Name', 'representative', 'senator', 'name']);
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
      payload,
      sourceUrl: firstUrl(payload),
      filedDate,
      filerName,
      providerPublishedAt: normalizeTimestamp(fieldString(payload, ['Quiver_Upload_Time'])),
    };
  });
}

export function matchDisclosureCandidate(
  candidate: Pick<CandidateRow, 'doc_id' | 'source_url' | 'filed_date' | 'filer_name'>,
  row: DisclosureProviderRow,
): CandidateMatch | null {
  const text = rowText(row.payload);
  for (const token of tokensFromDoc(candidate.doc_id, candidate.source_url)) {
    if (text.includes(token)) return { providerKey: row.providerKey, matchMethod: 'doc-token' };
  }
  const filed = normalizeDate(candidate.filed_date);
  const candidateLast = lastName(candidate.filer_name);
  const rowLast = lastName(row.filerName);
  if (filed && candidateLast && rowLast === candidateLast && row.filedDate === filed) {
    return { providerKey: row.providerKey, matchMethod: 'filer-date' };
  }
  if (filed && candidateLast && text.includes(candidateLast) && dateVariants(filed).some((d) => text.includes(d))) {
    return { providerKey: row.providerKey, matchMethod: 'probable-filer-date' };
  }
  return null;
}

export function matchFmpDisclosureCandidate(
  candidate: Pick<CandidateRow, 'doc_id' | 'source_url' | 'filed_date' | 'filer_name'>,
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

async function fetchFmpRows(
  apiKey: string,
  max: number,
  fetchImpl: typeof fetch,
  pace: () => Promise<void> = async () => {},
): Promise<DisclosureProviderRow[]> {
  const fetchOne = async (chamber: Chamber) => {
    const url =
      `https://financialmodelingprep.com/stable/${chamber}-latest?page=0&limit=${max}` +
      '&apikey=' +
      encodeURIComponent(apiKey);
    try {
      // Await the shared FMP pacer before each HTTP request (house-latest,
      // senate-latest), exactly like enrichment/prices, so this probe's calls
      // count toward the same per-minute gate. Concurrent house+senate requests
      // are serialized by the pacer's shared last-call timestamp.
      await pace();
      return parseFmpDisclosureRows(chamber, await fetchJson(url, {}, fetchImpl));
    } catch (err) {
      const status = /HTTP_(\d+)/.exec((err as Error).message)?.[1];
      if (status) assertFmpTierOk(Number(status));
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
  const [house, senate] = await Promise.all([
    fetchJson('https://api.quiverquant.com/beta/live/housetrading?options=true', headers, fetchImpl),
    fetchJson('https://api.quiverquant.com/beta/live/senatetrading?options=true', headers, fetchImpl),
  ]);
  const houseSliced = Array.isArray(house) ? house.slice(0, max) : house;
  const senateSliced = Array.isArray(senate) ? senate.slice(0, max) : senate;
  return [...parseQuiverDisclosureRows('house', houseSliced), ...parseQuiverDisclosureRows('senate', senateSliced)];
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
    const exists = await get<{ doc_id: string }>(
      env.DB,
      `SELECT doc_id FROM filings
        WHERE doc_id = ?
           OR (? IS NOT NULL AND source_url = ?)
           OR EXISTS (
                SELECT 1 FROM disclosure_latency_candidates c
                 WHERE c.provider = ? AND c.provider_key = ? AND c.status = 'matched'
                   AND c.doc_id = filings.doc_id
              )
        LIMIT 1`,
      [docId, row.sourceUrl, row.sourceUrl, provider, row.providerKey],
    );
    if (exists) continue;

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
  return {
    id: provider.id,
    label: provider.label,
    configured,
    requiresMembership: provider.requiresMembership,
    supportsDirectLatest: provider.supportsDirectLatest,
    timestampKind: provider.timestampKind,
    reason: provider.reason,
  };
}

export async function getDisclosureLatencyProviderStatuses(env: Env): Promise<DisclosureLatencyProviderStatus[]> {
  const statuses: DisclosureLatencyProviderStatus[] = [];
  for (const provider of PROVIDERS) statuses.push(await providerStatus(env, provider));
  return statuses;
}

export async function recordDisclosureLatencyCandidate(
  env: Env,
  filing: DiscoveredFiling,
  nowIso: string,
): Promise<void> {
  // Latency providers only publish house/senate rows; executive (OGE)
  // filings would sit permanently pending and skew coverage metrics.
  if (filing.chamber !== 'house' && filing.chamber !== 'senate') return;
  for (const provider of DIRECT_PROVIDER_IDS) {
    try {
      await run(
        env.DB,
        `INSERT INTO disclosure_latency_candidates
           (doc_id, provider, chamber, source_url, filed_date, filer_name,
            congress_first_seen_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(doc_id, provider) DO UPDATE SET
           congress_first_seen_at = MIN(congress_first_seen_at, excluded.congress_first_seen_at),
           updated_at = excluded.updated_at`,
        [
          filing.docId,
          provider,
          filing.chamber,
          filing.sourceUrl,
          normalizeDate(filing.filedDate),
          filing.filerName ?? null,
          nowIso,
          nowIso,
          nowIso,
        ],
      );
    } catch (err) {
      if (!storageMissing(err)) console.warn('disclosure latency candidate write failed:', (err as Error).message);
    }
  }
}

async function upsertProviderRows(env: Env, provider: ProviderId, rows: DisclosureProviderRow[], nowIso: string): Promise<void> {
  for (const row of rows) {
    await run(
      env.DB,
      `INSERT INTO disclosure_provider_observations
         (provider, chamber, provider_key, first_observed_at, last_observed_at,
          provider_published_at, source_url, filed_date, filer_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, chamber, provider_key) DO UPDATE SET
         last_observed_at=excluded.last_observed_at,
         provider_published_at=COALESCE(disclosure_provider_observations.provider_published_at, excluded.provider_published_at),
         source_url=COALESCE(disclosure_provider_observations.source_url, excluded.source_url),
         filed_date=COALESCE(disclosure_provider_observations.filed_date, excluded.filed_date),
         filer_name=COALESCE(disclosure_provider_observations.filer_name, excluded.filer_name),
         payload=COALESCE(disclosure_provider_observations.payload, excluded.payload)`,
      [
        provider,
        row.chamber,
        row.providerKey,
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
        ? `Congress.Trade observed it ${deltaSec}s before ${provider.label} was first observed by this monitor.`
        : deltaSec < 0
          ? `${provider.label} was already observed ${Math.abs(deltaSec)}s before Congress.Trade first saw it.`
          : `Congress.Trade and ${provider.label} were observed in the same second.`;
  const published =
    match.provider_published_at && deltaSeconds(match.provider_published_at, candidate.congress_first_seen_at) != null
      ? `\n${provider.label} provider timestamp: ${match.provider_published_at}`
      : '';
  await notifyAdmin(env, {
    dedupeKey: `disclosure-latency:${provider.id}:${candidate.doc_id}`,
    throttleSec: 30 * 24 * 60 * 60,
    subject: `Congress.Trade vs ${provider.label} disclosure latency`,
    text:
      `${direction}\n\n` +
      `Doc: ${candidate.doc_id}\n` +
      `Chamber: ${candidate.chamber}\n` +
      `Congress.Trade first_seen_at: ${candidate.congress_first_seen_at}\n` +
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
            source_url, filed_date, filer_name, payload
       FROM disclosure_provider_observations
      WHERE provider = ? AND first_observed_at >= ?
      ORDER BY first_observed_at DESC
      LIMIT 1000`,
    [provider, cutoff],
  );
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
): Promise<{ pending: number; matched: number; matchedDocIds: string[] }> {
  let matched = 0;
  const matchedDocIds: string[] = [];
  const updates: Array<[string, SqlParam[]]> = [];
  const alerts: Array<() => Promise<void>> = [];

  for (const candidate of candidates) {
    let match: ProviderObservationRow | null = null;
    let method: string | null = null;
    for (const providerRow of providerRows) {
      if (providerRow.chamber !== candidate.chamber || !providerRow.payload) continue;
      const payload = JSON.parse(providerRow.payload) as Record<string, unknown>;
      const parsed: DisclosureProviderRow = {
        provider: providerRow.provider,
        chamber: providerRow.chamber,
        providerKey: providerRow.provider_key,
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

    if (match) {
      updates.push([
        `UPDATE disclosure_latency_candidates
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
          WHERE doc_id = ? AND provider = ?`,
        [
          match.provider_key,
          match.first_observed_at,
          match.provider_published_at,
          method,
          match.payload,
          nowIso,
          nowIso,
          candidate.doc_id,
          provider.id,
        ],
      ]);
      matched++;
      matchedDocIds.push(candidate.doc_id);
      const m = match;
      alerts.push(() => alertMatch(env, provider, candidate, m));
    } else {
      updates.push([
        `UPDATE disclosure_latency_candidates
            SET attempts = attempts + 1, last_checked_at = ?, updated_at = ?, error = ?
          WHERE doc_id = ? AND provider = ?`,
        [nowIso, nowIso, errors[0] ?? null, candidate.doc_id, provider.id],
      ]);
    }
  }

  if (updates.length > 0) {
    await batch(env.DB, updates);
  }
  for (const alertFn of alerts) {
    await alertFn();
  }

  return { pending: candidates.length, matched, matchedDocIds };
}

async function matchPendingCandidates(
  env: Env,
  provider: ProviderDefinition,
  now: Date,
  nowIso: string,
  errors: string[],
): Promise<{ pending: number; matched: number; examinedDocIds: string[]; matchedDocIds: string[] }> {
  const candidates = await all<CandidateRow>(
    env.DB,
    `SELECT doc_id, provider, chamber, source_url, filed_date, filer_name,
            congress_first_seen_at, attempts
       FROM disclosure_latency_candidates
      WHERE provider = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 100`,
    [provider.id],
  );
  const providerRows = await loadProviderRows(env, provider.id, now);
  const result = await matchAndUpdateCandidates(env, provider, candidates, providerRows, nowIso, errors);
  return { ...result, examinedDocIds: candidates.map((c) => c.doc_id) };
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
        `SELECT provider, chamber, provider_key, first_observed_at, last_observed_at, provider_published_at,
                source_url, filed_date, filer_name, payload
           FROM disclosure_provider_observations
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
  examinedDocIds: string[];
  matchedDocIds: string[];
}> {
  const empty = {
    pending: 0,
    matched: 0,
    fetchedRows: 0,
    errors: [] as string[],
    examinedDocIds: [] as string[],
    matchedDocIds: [] as string[],
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
    `SELECT doc_id, provider, chamber, source_url, filed_date, filer_name,
            congress_first_seen_at, attempts
       FROM disclosure_latency_candidates c
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
    const txDates = txDatesByDoc.get(candidate.doc_id) ?? [];
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
      payload: providerRow.payload ? (JSON.parse(providerRow.payload) as Record<string, unknown>) : {},
      sourceUrl: providerRow.source_url,
      filedDate: providerRow.filed_date,
      filerName: providerRow.filer_name,
      providerPublishedAt: providerRow.provider_published_at,
    })),
    nowIso,
  );
  return { ...result, fetchedRows, errors, examinedDocIds: targetCandidates.map((c) => c.doc_id) };
}

async function runProviderProbe(
  env: Env,
  provider: ProviderDefinition,
  now: Date,
  fetchImpl: typeof fetch,
  max: number,
): Promise<DisclosureLatencyProviderRun> {
  const base = await providerStatus(env, provider);
  const errors: string[] = [];
  if (!provider.supportsDirectLatest || !provider.fetchRows) {
    return { ...base, enabled: false, fetchedRows: 0, pending: 0, matched: 0, errors };
  }
  const apiKey = await resolveProviderSecret(env, provider);
  if (!apiKey) {
    return { ...base, configured: false, enabled: false, fetchedRows: 0, pending: 0, matched: 0, errors, reason: `${provider.secretNames[0]} missing` };
  }

  const nowIso = now.toISOString();
  const isFmp = provider.id === 'fmp';
  const isUnusualWhales = provider.id === 'unusual_whales';
  const envx = env as EnvWithWatch;
  let fetchedRows = 0;
  let freshRows: DisclosureProviderRow[] = [];

  // FMP is the only provider here metered against the shared FMP budget: its
  // calls draw on the same 'fmp:calls:<date>' daily counter and the same
  // per-minute pacer as enrichment + price refresh. Guard the daily cap before
  // spending calls, reserving room for the full house+senate batch so the pair
  // never overshoots the cap; the free DB re-match below still runs so
  // already-observed rows keep resolving.
  //
  // To prevent overlapping probe invocations (e.g., a cron run plus an admin-
  // forced probe) from both reading the same stale used-counter and jointly
  // overshooting the cap, the budget is RESERVED upfront: we increment the
  // counter before fetching and reconcile the difference in the finally block.
  // This shrinks the race window from the duration of the full fetch (seconds)
  // to the KV get+put pair (milliseconds).
  let capSkipped = false;
  if (isFmp) {
    const cap = await fmpDailyCap(env);
    const used = await getDailyUsed(env);
    if (used + FMP_LATEST_CALLS_PER_RUN > cap) {
      capSkipped = true;
      errors.push(`FMP_DAILY_CALL_CAP reached (${used}/${cap}, need ${FMP_LATEST_CALLS_PER_RUN}); skipped latest fetch`);
    } else {
      // Reserve the budget for this run upfront.
      await addDailyUsed(env, FMP_LATEST_CALLS_PER_RUN);
    }
  }

  if (!capSkipped) {
    let fmpCallsMade = 0;
    const fmpMaxPerMinute = isFmp
      ? (await resolveSecret(env, 'FMP_MAX_PER_MINUTE')).value ?? envx.FMP_MAX_PER_MINUTE
      : undefined;
    const shared = isFmp
      ? getSharedFmpPacer(parseInt(fmpMaxPerMinute || '', 10) || undefined)
      : null;
    // Count every FMP HTTP request actually fired (one pace() call precedes each
    // request in fetchFmpRows), so failed 4xx/5xx calls still consume quota just
    // as enrichment counts them.
    const pace = shared
      ? async () => {
          fmpCallsMade++;
          await shared();
        }
      : undefined;
    try {
      const rows = await provider.fetchRows(apiKey, max, fetchImpl, pace);
      fetchedRows = rows.length;
      freshRows = rows;
      await upsertProviderRows(env, provider.id, rows, nowIso);
    } catch (err) {
      errors.push((err as Error).message);
    } finally {
      // Return any budget that was reserved but not actually spent. Since calls
      // are counted in the pacer wrapper above, fmpCallsMade is always ≤
      // FMP_LATEST_CALLS_PER_RUN even on early-exit or partial-failure paths.
      const overReserved = FMP_LATEST_CALLS_PER_RUN - fmpCallsMade;
      if (overReserved > 0) await addDailyUsed(env, -overReserved);
    }
  }

  try {
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
      const examined = new Set([...matched.examinedDocIds, ...deep.examinedDocIds]);
      const matchedIds = new Set([...matched.matchedDocIds, ...deep.matchedDocIds]);
      totalPending = examined.size - matchedIds.size;
    }

    if (freshRows.length) {
      await routeProviderOnlyObservationsToReview(env, provider.id, freshRows, nowIso);
    }

    return { ...base, configured: true, enabled: true, fetchedRows: totalFetchedRows, pending: totalPending, matched: totalMatched, errors };
  } catch (err) {
    if (storageMissing(err)) {
      return { ...base, configured: true, enabled: true, fetchedRows, pending: 0, matched: 0, errors, reason: 'latency tables missing; run /api/admin/migrate' };
    }
    throw err;
  }
}

/** KV key (via getLastPollAt/setLastPollAt) tracking this probe's own cadence. */
const PROBE_POLL_SOURCE = 'fmp-disclosure-latency';
/**
 * Cron calls this every minute with no cap of its own; each run fetches
 * house-latest + senate-latest from every configured provider. Unthrottled,
 * that's ~2,880 FMP requests/day against FMP_DAILY_CALL_CAP (1000 in
 * production, shared with enrichment/price refresh). Throttling to once per
 * MIN_PROBE_INTERVAL_SEC bounds this probe to ~576 calls/day, leaving budget
 * for the other FMP consumers, while still resolving "who was first" to
 * within a few minutes.
 */
const MIN_PROBE_INTERVAL_SEC = 300;

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
        reason: `throttled: runs at most every ${MIN_PROBE_INTERVAL_SEC}s to stay within FMP_DAILY_CALL_CAP`,
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
    runs.push(await runProviderProbe(env, definition(providerId), now, fetchImpl, max));
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
  return runDisclosureLatencyProbe(env, now, fetchImpl, { ...opts, providers: ['fmp'] });
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

export async function getDisclosureLatencySummary(env: Env, now: Date = new Date()): Promise<DisclosureLatencySummary> {
  const scoreCutoff = new Date(now.getTime() - LATENCY_SCORE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const maturityCutoff = new Date(now.getTime() - LATENCY_MATURITY_GRACE_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await all<{
    provider: ProviderId;
    status: string;
    chamber: Chamber;
    provider_key: string | null;
    match_method: string | null;
    congress_first_seen_at: string;
    provider_first_seen_at: string | null;
    provider_published_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    env.DB,
    `SELECT provider, status, chamber, provider_key, match_method, congress_first_seen_at,
            provider_first_seen_at, provider_published_at, created_at, updated_at
       FROM disclosure_latency_candidates
      WHERE updated_at >= ? OR congress_first_seen_at >= ?
      ORDER BY created_at DESC
      LIMIT 5000`,
    [scoreCutoff, scoreCutoff],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  // Provider rows are an independent denominator. A latest endpoint can only
  // prove that it showed us a row; it cannot prove that a missing row was
  // absent. Rows are therefore called "unmatched" only after the grace period
  // and are never folded into a Congress.Trade win/loss count.
  const providerRows = await all<ProviderObservationRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, first_observed_at, last_observed_at,
            provider_published_at, source_url, filed_date, filer_name, payload
       FROM disclosure_provider_observations
      WHERE last_observed_at >= ?
      ORDER BY last_observed_at DESC
      LIMIT 10000`,
    [scoreCutoff],
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  const statuses = await getDisclosureLatencyProviderStatuses(env);
  const providers = PROVIDERS.filter((p) => p.supportsDirectLatest).map((provider) => {
    const mine = rows.filter((row) => row.provider === provider.id);
    const observations = providerRows.filter((row) => row.provider === provider.id);
    // Date/name fallback matches can be ambiguous when a member has multiple
    // filings on the same day. Only exact document-token or exact filer/date
    // matches are eligible for a public timing comparison.
    const strongMatches = mine.filter(
      (row) => row.status === 'matched' && (row.match_method === 'doc-token' || row.match_method === 'filer-date'),
    );
    const monitorDeltas = strongMatches
      .map((row) => deltaSeconds(row.provider_first_seen_at, row.congress_first_seen_at))
      .filter((v): v is number => v != null);
    const publishedDeltas = strongMatches
      .map((row) => deltaSeconds(row.provider_published_at, row.congress_first_seen_at))
      .filter((v): v is number => v != null);
    const matched = strongMatches.length;
    const matchedKeys = new Set(
      strongMatches
        .filter((row) => row.provider_key)
        .map((row) => `${row.chamber}:${row.provider_key}`),
    );
    const maturedObservations = observations.filter((row) => row.first_observed_at <= maturityCutoff);
    const maturedCandidates = mine.filter((row) => row.congress_first_seen_at <= maturityCutoff);

    // Group observations into documents by chamber + filerName + filedDate
    const totalProviderDocs = new Set(
      observations.map((row) => `${row.chamber}:${lastName(row.filer_name)}:${row.filed_date}`)
    ).size;
    const uniqueProviderDocs = new Set(
      maturedObservations.map((row) => `${row.chamber}:${lastName(row.filer_name)}:${row.filed_date}`)
    );
    const matchedProviderDocs = new Set(
      maturedObservations
        .filter((row) => matchedKeys.has(`${row.chamber}:${row.provider_key}`))
        .map((row) => `${row.chamber}:${lastName(row.filer_name)}:${row.filed_date}`)
    );

    const maturedMatched = matchedProviderDocs.size;
    const maturedProviderObserved = uniqueProviderDocs.size;
    const unmatchedProvider = maturedProviderObserved - maturedMatched;

    const pendingProvider = new Set(
      observations
        .filter((row) => row.first_observed_at > maturityCutoff && !matchedKeys.has(`${row.chamber}:${row.provider_key}`))
        .map((row) => `${row.chamber}:${lastName(row.filer_name)}:${row.filed_date}`)
    ).size;

    const matchedMaturedCandidates = maturedCandidates.filter(
      (row) => row.status === 'matched' && (row.match_method === 'doc-token' || row.match_method === 'filer-date'),
    ).length;
    const ctCoveragePct = maturedProviderObserved
      ? Math.round((maturedMatched / maturedProviderObserved) * 1000) / 10
      : null;
    const providerCoveragePct = maturedCandidates.length
      ? Math.round((matchedMaturedCandidates / maturedCandidates.length) * 1000) / 10
      : null;
    const union = maturedProviderObserved + maturedCandidates.length - maturedMatched;
    const overlapPct = union > 0 ? Math.round((maturedMatched / union) * 1000) / 10 : null;
    const comparisonStatus: DisclosureLatencyProviderMetrics['comparisonStatus'] =
      maturedProviderObserved < LATENCY_MIN_MATURED_ROWS || maturedCandidates.length < LATENCY_MIN_MATURED_ROWS
        ? 'insufficient'
        : (ctCoveragePct ?? 0) < LATENCY_MIN_COVERAGE_PCT || (providerCoveragePct ?? 0) < LATENCY_MIN_COVERAGE_PCT
          ? 'limited'
          : 'usable';
    return {
      provider: provider.id,
      label: provider.label,
      candidates: mine.length,
      matched,
      pending: mine.filter((row) => row.status === 'pending').length,
      errored: mine.filter((row) => row.status === 'error').length,
      providerObserved: totalProviderDocs,
      maturedProviderObserved,
      unmatchedProvider,
      pendingProvider,
      maturedCandidates: maturedCandidates.length,
      maturedMatched,
      ctCoveragePct,
      providerCoveragePct,
      overlapPct,
      comparisonStatus,
      comparisonBasis: 'matched-overlap-only' as const,
      ctAheadMonitorCount: monitorDeltas.filter((d) => d > 0).length,
      providerAheadMonitorCount: monitorDeltas.filter((d) => d < 0).length,
      tieMonitorCount: monitorDeltas.filter((d) => d === 0).length,
      avgMonitorDeltaSec: average(monitorDeltas),
      medianMonitorDeltaSec: median(monitorDeltas),
      p90MonitorDeltaSec: p90(monitorDeltas),
      avgProviderPublishedDeltaSec: average(publishedDeltas),
      medianProviderPublishedDeltaSec: median(publishedDeltas),
    };
  });
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
  const generatedAt = now.toISOString();
  return {
    generatedAt,
    totals,
    providers,
    providerStatuses: statuses,
    publicSummary: { generatedAt, totals, providers },
  };
}
