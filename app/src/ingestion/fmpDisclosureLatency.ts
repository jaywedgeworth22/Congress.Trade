/**
 * src/ingestion/fmpDisclosureLatency.ts
 * OWNER: ingestion
 *
 * Measures whether Congress.Trade sees new congressional disclosures before
 * FMP's congressional "latest" endpoints. It deliberately records observations
 * rather than making the comparison by hand, because FMP may already have a row
 * by the time we start looking unless we poll both sides on the same cadence.
 */

import type { Env } from '../shared/types';
import { all, run } from '../shared/db';
import { resolveSecret } from '../secrets/infisical';
import { notifyAdmin } from '../alerts/notify';
import { assertFmpTierOk } from '../shared/fmpStatus';
import type { DiscoveredFiling } from './watcher';

type Chamber = 'house' | 'senate';

type EnvWithWatch = Env & {
  FMP_API_KEY?: string;
  FMP_DISCLOSURE_WATCH_ENABLED?: string;
  FMP_DISCLOSURE_WATCH_LIMIT?: string;
};

interface CandidateRow {
  doc_id: string;
  provider: string;
  chamber: Chamber;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  congress_first_seen_at: string;
  attempts: number;
}

interface ProviderObservationRow {
  provider: string;
  chamber: Chamber;
  provider_key: string;
  first_observed_at: string;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
}

export interface FmpDisclosureRow {
  chamber: Chamber;
  providerKey: string;
  payload: Record<string, unknown>;
  sourceUrl: string | null;
  filedDate: string | null;
  filerName: string | null;
}

export interface CandidateMatch {
  providerKey: string;
  matchMethod: string;
}

export interface DisclosureLatencyProbeResult {
  enabled: boolean;
  reason?: string;
  fetchedRows: number;
  pending: number;
  matched: number;
  errors: string[];
}

const PROVIDER = 'fmp';
const DEFAULT_LIMIT = 100;
const RECENT_PROVIDER_HOURS = 72;
const PAYLOAD_LIMIT = 20_000;

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

function enabled(env: EnvWithWatch): boolean {
  return truthy(env.FMP_DISCLOSURE_WATCH_ENABLED);
}

function limit(env: EnvWithWatch): number {
  const n = parseInt(env.FMP_DISCLOSURE_WATCH_LIMIT || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : DEFAULT_LIMIT;
}

function storageMissing(err: unknown): boolean {
  return /no such table|no column named/i.test(err instanceof Error ? err.message : String(err));
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
  // House ids are H-YYYY-DOCID; the trailing doc id is what FMP usually exposes.
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

export function matchFmpDisclosureCandidate(
  candidate: Pick<CandidateRow, 'doc_id' | 'source_url' | 'filed_date' | 'filer_name'>,
  row: FmpDisclosureRow,
): CandidateMatch | null {
  const text = rowText(row.payload);
  for (const token of tokensFromDoc(candidate.doc_id, candidate.source_url)) {
    if (text.includes(token)) return { providerKey: row.providerKey, matchMethod: 'doc-token' };
  }
  const filed = normalizeDate(candidate.filed_date);
  const last = lastName(candidate.filer_name);
  if (filed && last && text.includes(last) && dateVariants(filed).some((d) => text.includes(d))) {
    return { providerKey: row.providerKey, matchMethod: 'probable-filer-date' };
  }
  return null;
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
    }
  }
  return [];
}

export function parseFmpDisclosureRows(chamber: Chamber, json: unknown): FmpDisclosureRow[] {
  return extractRows(json).map((payload) => {
    const sourceUrl = firstUrl(payload);
    const text = rowText(payload);
    const docToken = providerKeyFromUrl(sourceUrl) ?? fieldString(payload, ['docId', 'documentId', 'reportId', 'disclosureId', 'disclosure_id']);
    const providerKey = docToken ? String(docToken).toLowerCase() : simpleHash(text);
    return {
      chamber,
      providerKey,
      payload,
      sourceUrl,
      filedDate: normalizeDate(fieldString(payload, ['filedDate', 'filingDate', 'disclosureDate', 'reportedDate'])),
      filerName: fieldString(payload, ['representative', 'senator', 'filerName', 'name']),
    };
  });
}

async function fetchFmpLatest(
  apiKey: string,
  chamber: Chamber,
  max: number,
  fetchImpl: typeof fetch,
): Promise<FmpDisclosureRow[]> {
  const url =
    `https://financialmodelingprep.com/stable/${chamber}-latest?page=0&limit=${max}` +
    '&apikey=' +
    encodeURIComponent(apiKey);
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' },
  });
  if (!res.ok) {
    assertFmpTierOk(res.status);
    throw new Error(`FMP_${chamber}_LATEST_HTTP_${res.status}`);
  }
  return parseFmpDisclosureRows(chamber, await res.json());
}

export async function recordDisclosureLatencyCandidate(
  env: Env,
  filing: DiscoveredFiling,
  nowIso: string,
): Promise<void> {
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
        PROVIDER,
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

async function upsertProviderRows(env: Env, rows: FmpDisclosureRow[], nowIso: string): Promise<void> {
  for (const row of rows) {
    await run(
      env.DB,
      `INSERT INTO disclosure_provider_observations
         (provider, chamber, provider_key, first_observed_at, last_observed_at,
          source_url, filed_date, filer_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, chamber, provider_key) DO UPDATE SET
         last_observed_at=excluded.last_observed_at,
         source_url=COALESCE(disclosure_provider_observations.source_url, excluded.source_url),
         filed_date=COALESCE(disclosure_provider_observations.filed_date, excluded.filed_date),
         filer_name=COALESCE(disclosure_provider_observations.filer_name, excluded.filer_name),
         payload=COALESCE(disclosure_provider_observations.payload, excluded.payload)`,
      [
        PROVIDER,
        row.chamber,
        row.providerKey,
        nowIso,
        nowIso,
        row.sourceUrl,
        row.filedDate,
        row.filerName,
        JSON.stringify(row.payload).slice(0, PAYLOAD_LIMIT),
      ],
    );
  }
}

async function alertMatch(env: Env, candidate: CandidateRow, match: ProviderObservationRow): Promise<void> {
  const congress = Date.parse(candidate.congress_first_seen_at);
  const provider = Date.parse(match.first_observed_at);
  const deltaSec = Number.isFinite(congress) && Number.isFinite(provider) ? Math.round((provider - congress) / 1000) : null;
  const direction =
    deltaSec == null
      ? 'Delta unavailable'
      : deltaSec > 0
        ? `Congress.Trade observed it ${deltaSec}s before FMP was first observed by this monitor.`
        : deltaSec < 0
          ? `FMP was already observed ${Math.abs(deltaSec)}s before Congress.Trade first saw it.`
          : 'Congress.Trade and FMP were observed in the same second.';
  await notifyAdmin(env, {
    dedupeKey: `disclosure-latency:${PROVIDER}:${candidate.doc_id}`,
    throttleSec: 30 * 24 * 60 * 60,
    subject: 'Congress.Trade vs FMP disclosure latency',
    text:
      `${direction}\n\n` +
      `Doc: ${candidate.doc_id}\n` +
      `Chamber: ${candidate.chamber}\n` +
      `Congress.Trade first_seen_at: ${candidate.congress_first_seen_at}\n` +
      `FMP monitor first_observed_at: ${match.first_observed_at}\n` +
      `FMP key: ${match.provider_key}\n` +
      `Source URL: ${candidate.source_url ?? 'n/a'}\n`,
  });
}

export async function runFmpDisclosureLatencyProbe(
  env: Env,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean } = {},
): Promise<DisclosureLatencyProbeResult> {
  const envx = env as EnvWithWatch;
  if (!opts.force && !enabled(envx)) {
    return { enabled: false, reason: 'FMP_DISCLOSURE_WATCH_ENABLED is not true', fetchedRows: 0, pending: 0, matched: 0, errors: [] };
  }
  const apiKey = (await resolveSecret(env, 'FMP_API_KEY')).value ?? envx.FMP_API_KEY;
  if (!apiKey) return { enabled: false, reason: 'FMP_API_KEY missing', fetchedRows: 0, pending: 0, matched: 0, errors: [] };

  const nowIso = now.toISOString();
  const max = limit(envx);
  const errors: string[] = [];
  let fetchedRows = 0;
  try {
    const rows = (
      await Promise.all([
        fetchFmpLatest(apiKey, 'house', max, fetchImpl),
        fetchFmpLatest(apiKey, 'senate', max, fetchImpl),
      ])
    ).flat();
    fetchedRows = rows.length;
    await upsertProviderRows(env, rows, nowIso);
  } catch (err) {
    errors.push((err as Error).message);
  }

  let candidates: CandidateRow[] = [];
  try {
    candidates = await all<CandidateRow>(
      env.DB,
      `SELECT doc_id, provider, chamber, source_url, filed_date, filer_name,
              congress_first_seen_at, attempts
         FROM disclosure_latency_candidates
        WHERE provider = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 100`,
      [PROVIDER],
    );
  } catch (err) {
    if (storageMissing(err)) return { enabled: true, reason: 'latency tables missing; run /api/admin/migrate', fetchedRows, pending: 0, matched: 0, errors };
    throw err;
  }

  const cutoff = new Date(now.getTime() - RECENT_PROVIDER_HOURS * 60 * 60 * 1000).toISOString();
  const providerRows = await all<ProviderObservationRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, first_observed_at, source_url, filed_date, filer_name, payload
       FROM disclosure_provider_observations
      WHERE provider = ? AND first_observed_at >= ?
      ORDER BY first_observed_at DESC
      LIMIT 1000`,
    [PROVIDER, cutoff],
  );

  let matched = 0;
  for (const candidate of candidates) {
    let match: ProviderObservationRow | null = null;
    let method: string | null = null;
    for (const providerRow of providerRows) {
      if (providerRow.chamber !== candidate.chamber || !providerRow.payload) continue;
      const payload = JSON.parse(providerRow.payload) as Record<string, unknown>;
      const parsed: FmpDisclosureRow = {
        chamber: providerRow.chamber,
        providerKey: providerRow.provider_key,
        payload,
        sourceUrl: providerRow.source_url,
        filedDate: providerRow.filed_date,
        filerName: providerRow.filer_name,
      };
      const m = matchFmpDisclosureCandidate(candidate, parsed);
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
          method,
          match.payload,
          nowIso,
          nowIso,
          candidate.doc_id,
          PROVIDER,
        ],
      );
      matched++;
      await alertMatch(env, candidate, match);
    } else {
      await run(
        env.DB,
        `UPDATE disclosure_latency_candidates
            SET attempts = attempts + 1, last_checked_at = ?, updated_at = ?, error = ?
          WHERE doc_id = ? AND provider = ?`,
        [nowIso, nowIso, errors[0] ?? null, candidate.doc_id, PROVIDER],
      );
    }
  }

  return { enabled: true, fetchedRows, pending: candidates.length, matched, errors };
}
