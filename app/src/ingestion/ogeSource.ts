/**
 * src/ingestion/ogeSource.ts
 * OWNER: ingestion
 *
 * Executive-branch disclosure source: polls the OGE "President and Vice
 * President Index" Domino view for new Periodic Transaction Reports (OGE Form
 * 278-T) and maps them onto the same DiscoveredFiling shape the House/Senate
 * watchers produce, so the existing fetch -> classify -> extract -> review
 * pipeline ingests them unchanged. The filings are scanned PDFs (poor embedded
 * OCR), so they classify as `scanned_pdf` and flow through the vision
 * extractor + review queue exactly like scanned House PTRs.
 *
 * Design notes:
 *  - The index view lists direct `$FILE/<name>.pdf` links; new filings are
 *    detected by diffing doc ids (INSERT OR IGNORE in the shared watcher path).
 *  - Only known executive filers are ingested (currently the President).
 *    Additional filers (VP, cabinet) are one FILERS entry away.
 *  - Filings land WEEKS after the trades (the STOCK Act 45-day clock, often
 *    exceeded with late fees), so this source polls on a slow cadence and is
 *    entirely fail-soft: an OGE outage must never affect House/Senate polling.
 *  - EIGA §105(c) restricts certain uses of these reports; Congress.Trade
 *    disseminates them to the general public in the site's existing
 *    educational framing, mirroring its House/Senate STOCK Act posture.
 */

import type { Env } from '../shared/types';
import { resolveSecret } from '../secrets/infisical';
import { getLastPollAt } from '../shared/config';
import type { DiscoveredFiling } from './watcher';
import { trackedFetch } from '../shared/thirdPartyTelemetry';

export const OGE_DEFAULT_INDEX_URL =
  'https://extapps2.oge.gov/201/Presiden.nsf/President%20and%20Vice%20President%20Index?OpenView&ExpandView&Count=500';

const OGE_ORIGIN = 'https://extapps2.oge.gov';
const DEFAULT_POLL_INTERVAL_SEC = 21_600; // 6h — filings land every few weeks
const POLL_SOURCE = 'oge';

/** Known executive filers we ingest. Matching is against the PDF filename. */
interface ExecutiveFiler {
  pattern: RegExp;
  filerId: string;
  fullName: string;
}
const EXECUTIVE_FILERS: ExecutiveFiler[] = [
  { pattern: /trump/i, filerId: 'EXEC-DJT', fullName: 'Donald J. Trump' },
  { pattern: /vance/i, filerId: 'EXEC-JDV', fullName: 'J.D. Vance' },
  { pattern: /biden/i, filerId: 'EXEC-JRB', fullName: 'Joseph R. Biden' },
  { pattern: /harris/i, filerId: 'EXEC-KDH', fullName: 'Kamala D. Harris' },
  { pattern: /pence/i, filerId: 'EXEC-MRP', fullName: 'Michael R. Pence' },
  { pattern: /obama/i, filerId: 'EXEC-BHO', fullName: 'Barack H. Obama' },
];

/** True for Periodic Transaction Reports; annual 278/278e forms are skipped
 *  for now (holdings snapshots, not transactions). */
function is278T(filename: string): boolean {
  return /278[\s-]?T/i.test(filename) && !/annual/i.test(filename);
}

/**
 * Best-effort filing date from the PDF filename (e.g. "10.17.2025",
 * "05.08.2026", "1.14.2026", "4-20-2026"). The per-transaction dates come from
 * extraction; this only seeds `filings.filed_date` for ordering.
 */
export function ogeFiledDateFromName(filename: string): string | null {
  // Both 4-digit ("10.17.2025") and 2-digit ("9.3.25") years appear in real
  // OGE filenames; 2-digit years are 20xx (the corpus starts in 2017).
  const m = /(\d{1,2})[.\-](\d{1,2})[.\-](\d{4}|\d{2})(?!\d)/.exec(filename);
  if (!m) return null;
  const [, mo, d, y] = m;
  const year = y.length === 4 ? y : `20${y}`;
  return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Stable, URL-safe doc id: E-<year>-<filename-slug>. */
export function ogeDocId(filename: string): string {
  const filed = ogeFiledDateFromName(filename);
  const year = filed ? filed.slice(0, 4) : 'undated';
  const slug = filename
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `E-${year}-${slug}`;
}

/**
 * Parse the OGE index view HTML into DiscoveredFilings for known executive
 * filers' 278-T reports. Pure so it can be unit-tested against a fixture.
 */
export function parseOgeIndex(html: string): DiscoveredFiling[] {
  const out: DiscoveredFiling[] = [];
  const seen = new Set<string>();
  // Domino renders hrefs (SINGLE-quoted in the live view, so accept either
  // quote) like: /201/Presiden.nsf/<view>/<UNID>/$FILE/<name>.pdf — with raw
  // spaces in the filename. Amended reports appear as distinct files and are
  // ingested as distinct filings (review resolves any duplication).
  const re = /href=["'](\/201\/[^"']*\$FILE\/([^"']+?\.pdf))["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1];
    let filename = m[2];
    try {
      if (filename.includes('%')) filename = decodeURIComponent(filename);
    } catch {
      /* keep the raw name — a stray % must not kill the whole poll */
    }
    filename = filename.trim();
    if (!is278T(filename)) continue;
    const filer = EXECUTIVE_FILERS.find((f) => f.pattern.test(filename));
    if (!filer) continue;
    const docId = ogeDocId(filename);
    if (seen.has(docId)) continue;
    seen.add(docId);
    out.push({
      docId,
      chamber: 'executive',
      // Encode ONLY the spaces: the path from Domino is otherwise URL-ready,
      // and double-encoding %28/%29 etc. breaks the download.
      sourceUrl: OGE_ORIGIN + path.replace(/ /g, '%20'),
      filedDate: ogeFiledDateFromName(filename),
      filerId: filer.filerId,
      filerName: filer.fullName,
    });
  }
  return out;
}

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

export async function ogeWatchEnabled(env: Env): Promise<boolean> {
  try {
    const live = (await resolveSecret(env, 'OGE_WATCH_ENABLED')).value;
    return truthy(live ?? env.OGE_WATCH_ENABLED);
  } catch {
    return truthy(env.OGE_WATCH_ENABLED);
  }
}

async function indexUrl(env: Env): Promise<string> {
  try {
    return (await resolveSecret(env, 'OGE_INDEX_URL')).value || env.OGE_INDEX_URL || OGE_DEFAULT_INDEX_URL;
  } catch {
    return env.OGE_INDEX_URL || OGE_DEFAULT_INDEX_URL;
  }
}

async function pollIntervalSec(env: Env): Promise<number> {
  try {
    const raw = (await resolveSecret(env, 'OGE_POLL_INTERVAL_SEC')).value ?? env.OGE_POLL_INTERVAL_SEC;
    const n = parseInt(raw || '', 10);
    return Number.isFinite(n) && n >= 60 ? n : DEFAULT_POLL_INTERVAL_SEC;
  } catch {
    return DEFAULT_POLL_INTERVAL_SEC;
  }
}

/** Fetch + parse the OGE index. Throws on HTTP failure (caller guards). */
export async function fetchOgeExecutiveFilings(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFiling[]> {
  const res = await trackedFetch(await indexUrl(env), {
    headers: {
      'user-agent': 'congress.trade/0.1 (+https://congress.trade)',
      accept: 'text/html',
    },
  }, { service: 'filing-discovery', operation: 'fetch-executive-index', dynamicTarget: 'filing-source' }, fetchImpl);
  if (!res.ok) throw new Error(`OGE index HTTP ${res.status}`);
  return parseOgeIndex(await res.text());
}

/**
 * Cadence-gated poll for the cron watcher. Returns the discovered filings, or
 * null when disabled / not yet due — the caller only persists on non-null.
 */
export async function pollOgeExecutive(
  env: Env,
  now: Date,
  fetchImpl: typeof fetch = fetch,
  opts: { force?: boolean } = {},
): Promise<DiscoveredFiling[] | null> {
  if (!(await ogeWatchEnabled(env)) && !opts.force) return null;
  if (!opts.force) {
    const last = await getLastPollAt(env, POLL_SOURCE);
    if (last && now.getTime() - last.getTime() < (await pollIntervalSec(env)) * 1000) return null;
  }
  // Checkpoint is written by the caller (pollExecutive) only after
  // persistence succeeds, matching the House/Senate ordering — a failed
  // persist must not advance last_poll:oge and skip the next cycles.
  return fetchOgeExecutiveFilings(env, fetchImpl);
}
