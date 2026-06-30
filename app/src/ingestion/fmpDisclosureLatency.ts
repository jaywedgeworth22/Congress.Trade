/**
 * src/ingestion/fmpDisclosureLatency.ts
 * OWNER: ingestion
 *
 * Provider-latency monitor for congressional disclosures. Candidates are
 * created when Congress.Trade first sees a new filing; provider observations
 * are populated from third-party "latest" endpoints so admins can measure who
 * surfaced the disclosure first.
 */

import type { Env } from '../shared/types';
import { all, run } from '../shared/db';
import { resolveSecret } from '../secrets/infisical';
import { notifyAdmin } from '../alerts/notify';
import { assertFmpTierOk } from '../shared/fmpStatus';
import type { DiscoveredFiling } from './watcher';

type Chamber = 'house' | 'senate';
type ProviderId = 'fmp' | 'unusual_whales' | 'quiver' | 'finnhub' | 'ainvest' | 'capitol_trades';

type EnvWithWatch = Env & {
  DISCLOSURE_LATENCY_WATCH_ENABLED?: string;
  DISCLOSURE_LATENCY_PROVIDERS?: string;
  DISCLOSURE_LATENCY_WATCH_LIMIT?: string;
  FMP_API_KEY?: string;
  FMP_DISCLOSURE_WATCH_ENABLED?: string;
  FMP_DISCLOSURE_WATCH_LIMIT?: string;
  UNUSUAL_WHALES_API_KEY?: string;
  QUIVER_API_KEY?: string;
  QUIVER_API_TOKEN?: string;
  FINNHUB_API_KEY?: string;
  AINVEST_API_KEY?: string;
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
  coveragePct: number;
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
  fetchRows?: (apiKey: string, max: number, fetchImpl: typeof fetch) => Promise<DisclosureProviderRow[]>;
}

const DEFAULT_LIMIT = 100;
const RECENT_PROVIDER_HOURS = 72;
const PAYLOAD_LIMIT = 20_000;
const DIRECT_PROVIDER_IDS: ProviderId[] = ['fmp', 'unusual_whales', 'quiver'];

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
    secretNames: ['UNUSUAL_WHALES_API_KEY'],
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

function enabled(env: EnvWithWatch): boolean {
  return truthy(env.DISCLOSURE_LATENCY_WATCH_ENABLED) || truthy(env.FMP_DISCLOSURE_WATCH_ENABLED);
}

function limit(env: EnvWithWatch): number {
  const n = parseInt(env.DISCLOSURE_LATENCY_WATCH_LIMIT || env.FMP_DISCLOSURE_WATCH_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : DEFAULT_LIMIT;
}

function storageMissing(err: unknown): boolean {
  return /no such table|no column named|no such column/i.test(err instanceof Error ? err.message : String(err));
}

function definition(id: ProviderId): ProviderDefinition {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

function requestedProviderIds(env: EnvWithWatch, opts: { providers?: string[] } = {}): ProviderId[] {
  const raw = opts.providers?.length ? opts.providers.join(',') : env.DISCLOSURE_LATENCY_PROVIDERS || '';
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
  return extractRows(json).map((payload) => {
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
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}:${url.replace(/[?&](apikey|token)=[^&]+/gi, '$1=[redacted]')}`);
  return res.json();
}

async function fetchFmpRows(apiKey: string, max: number, fetchImpl: typeof fetch): Promise<DisclosureProviderRow[]> {
  const fetchOne = async (chamber: Chamber) => {
    const url =
      `https://financialmodelingprep.com/stable/${chamber}-latest?page=0&limit=${max}` +
      '&apikey=' +
      encodeURIComponent(apiKey);
    try {
      return parseFmpDisclosureRows(chamber, await fetchJson(url, {}, fetchImpl));
    } catch (err) {
      const status = /HTTP_(\d+)/.exec((err as Error).message)?.[1];
      if (status) assertFmpTierOk(Number(status));
      throw err;
    }
  };
  return (await Promise.all([fetchOne('house'), fetchOne('senate')])).flat();
}

async function fetchUnusualWhalesRows(apiKey: string, max: number, fetchImpl: typeof fetch): Promise<DisclosureProviderRow[]> {
  const url = `https://api.unusualwhales.com/api/congress/recent-trades?limit=${Math.min(max, 200)}`;
  return parseUnusualWhalesDisclosureRows(await fetchJson(url, { authorization: `Bearer ${apiKey}` }, fetchImpl));
}

async function fetchQuiverRows(apiKey: string, _max: number, fetchImpl: typeof fetch): Promise<DisclosureProviderRow[]> {
  const headers = { authorization: `Bearer ${apiKey}` };
  const [house, senate] = await Promise.all([
    fetchJson('https://api.quiverquant.com/beta/live/housetrading?options=true', headers, fetchImpl),
    fetchJson('https://api.quiverquant.com/beta/live/senatetrading?options=true', headers, fetchImpl),
  ]);
  return [...parseQuiverDisclosureRows('house', house), ...parseQuiverDisclosureRows('senate', senate)];
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
  for (const provider of DIRECT_PROVIDER_IDS) {
    try {
      await run(
        env.DB,
        `INSERT INTO disclosure_latency_candidates
           (doc_id, provider, chamber, source_url, filed_date, filer_name,
            congress_first_seen_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(doc_id, provider) DO NOTHING`,
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
    `SELECT provider, chamber, provider_key, first_observed_at, provider_published_at,
            source_url, filed_date, filer_name, payload
       FROM disclosure_provider_observations
      WHERE provider = ? AND first_observed_at >= ?
      ORDER BY first_observed_at DESC
      LIMIT 1000`,
    [provider, cutoff],
  );
}

async function matchPendingCandidates(
  env: Env,
  provider: ProviderDefinition,
  now: Date,
  nowIso: string,
  errors: string[],
): Promise<{ pending: number; matched: number }> {
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

  let matched = 0;
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
      await run(
        env.DB,
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
      );
      matched++;
      await alertMatch(env, provider, candidate, match);
    } else {
      await run(
        env.DB,
        `UPDATE disclosure_latency_candidates
            SET attempts = attempts + 1, last_checked_at = ?, updated_at = ?, error = ?
          WHERE doc_id = ? AND provider = ?`,
        [nowIso, nowIso, errors[0] ?? null, candidate.doc_id, provider.id],
      );
    }
  }
  return { pending: candidates.length, matched };
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
  let fetchedRows = 0;
  try {
    const rows = await provider.fetchRows(apiKey, max, fetchImpl);
    fetchedRows = rows.length;
    await upsertProviderRows(env, provider.id, rows, nowIso);
  } catch (err) {
    errors.push((err as Error).message);
  }

  try {
    const matched = await matchPendingCandidates(env, provider, now, nowIso, errors);
    return { ...base, configured: true, enabled: true, fetchedRows, pending: matched.pending, matched: matched.matched, errors };
  } catch (err) {
    if (storageMissing(err)) {
      return { ...base, configured: true, enabled: true, fetchedRows, pending: 0, matched: 0, errors, reason: 'latency tables missing; run /api/admin/migrate' };
    }
    throw err;
  }
}

export async function runDisclosureLatencyProbe(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean; providers?: string[] } = {},
): Promise<DisclosureLatencyProbeResult> {
  const envx = env as EnvWithWatch;
  if (!opts.force && !enabled(envx)) {
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

  const runs: DisclosureLatencyProviderRun[] = [];
  for (const providerId of requestedProviderIds(envx, opts)) {
    runs.push(await runProviderProbe(env, definition(providerId), now, fetchImpl, limit(envx)));
  }
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
  const rows = await all<{
    provider: ProviderId;
    status: string;
    congress_first_seen_at: string;
    provider_first_seen_at: string | null;
    provider_published_at: string | null;
  }>(
    env.DB,
    `SELECT provider, status, congress_first_seen_at, provider_first_seen_at, provider_published_at
       FROM disclosure_latency_candidates
      ORDER BY created_at DESC
      LIMIT 5000`,
  ).catch((err) => {
    if (storageMissing(err)) return [];
    throw err;
  });

  const statuses = await getDisclosureLatencyProviderStatuses(env);
  const providers = PROVIDERS.filter((p) => p.supportsDirectLatest).map((provider) => {
    const mine = rows.filter((row) => row.provider === provider.id);
    const monitorDeltas = mine
      .map((row) => deltaSeconds(row.provider_first_seen_at, row.congress_first_seen_at))
      .filter((v): v is number => v != null);
    const publishedDeltas = mine
      .map((row) => deltaSeconds(row.provider_published_at, row.congress_first_seen_at))
      .filter((v): v is number => v != null);
    const matched = mine.filter((row) => row.status === 'matched').length;
    return {
      provider: provider.id,
      label: provider.label,
      candidates: mine.length,
      matched,
      pending: mine.filter((row) => row.status === 'pending').length,
      errored: mine.filter((row) => row.status === 'error').length,
      coveragePct: mine.length ? Math.round((matched / mine.length) * 1000) / 10 : 0,
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
    matched: rows.filter((row) => row.status === 'matched').length,
    pending: rows.filter((row) => row.status === 'pending').length,
    errored: rows.filter((row) => row.status === 'error').length,
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
