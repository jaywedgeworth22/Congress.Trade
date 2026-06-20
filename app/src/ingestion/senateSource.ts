/**
 * src/ingestion/senateSource.ts
 * OWNER: ingestion agent
 *
 * Senate eFD (efdsearch.senate.gov) source.
 *
 * The Senate has no bulk file; it exposes a CSRF-protected, agreement-gated
 * DataTables search. The flow we implement (all cookies carried in a small jar):
 *
 *   1. GET  https://efdsearch.senate.gov/search/
 *        -> sets a `csrftoken` cookie AND embeds a hidden
 *           <input name="csrfmiddlewaretoken" value="…"> in the landing page.
 *
 *   2. POST https://efdsearch.senate.gov/search/home/
 *        body: prohibition_agreement=1 & csrfmiddlewaretoken=<token>
 *        (accepts the "prohibition against private use" agreement; the server
 *         records acceptance against the session cookie). Cookies are preserved.
 *
 *   3. POST https://efdsearch.senate.gov/search/report/data/
 *        A DataTables server-side request. JSON-ish form body:
 *          draw, start, length, search[value],
 *          report_types=[11]            (11 == Periodic Transaction Report),
 *          filer_types=[],              (all filer types),
 *          submitted_start_date / submitted_end_date  (MM/DD/YYYY HH:MM:SS),
 *          first_name, last_name
 *        Headers: X-CSRFToken: <csrftoken cookie>, Referer: …/search/,
 *                 X-Requested-With: XMLHttpRequest.
 *        -> JSON { data: rows[] } where each row is:
 *             [ firstName, lastName, "<a href='/search/view/ptr/<id>/'>Name</a>",
 *               filingTypeLabel, "MM/DD/YYYY" ]
 *
 * We parse the anchor href in column index 2 to recover the report path and the
 * report id, build sourceUrl, and compute pipeline docId `S-{reportId}`.
 */

const SENATE_BASE = 'https://efdsearch.senate.gov';
const SENATE_SEARCH = `${SENATE_BASE}/search/`;
const SENATE_HOME = `${SENATE_BASE}/search/home/`;
const SENATE_DATA = `${SENATE_BASE}/search/report/data/`;

/** PTR report type code in the efdsearch DataTables API. */
export const SENATE_PTR_REPORT_TYPE = 11;

/** A single PTR row discovered via the Senate search. */
export interface SenateFiling {
  /** efd report id parsed from the anchor href. */
  reportId: string;
  first: string;
  last: string;
  fullName: string;
  filingTypeLabel: string;
  /** Filing date as displayed, "MM/DD/YYYY". */
  filedDate: string;
  /** Relative report path, e.g. "/search/view/ptr/abcdef.../". */
  reportPath: string;
  /** Absolute report url. */
  sourceUrl: string;
  /** Canonical pipeline doc id: `S-{reportId}`. */
  pipelineDocId: string;
}

// ---------------------------------------------------------------------------
// Cookie jar (minimal — name=value pairs from Set-Cookie, no attributes).
// ---------------------------------------------------------------------------

export class CookieJar {
  private jar = new Map<string, string>();

  /** Ingest one or more Set-Cookie header values from a response. */
  absorb(res: Response): void {
    // Workers exposes combined Set-Cookie via getSetCookie() when available.
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
    let cookies: string[] = [];
    if (typeof anyHeaders.getSetCookie === 'function') {
      cookies = anyHeaders.getSetCookie();
    } else {
      const raw = res.headers.get('set-cookie');
      if (raw) cookies = [raw];
    }
    for (const c of cookies) this.absorbString(c);
  }

  /** Parse a single Set-Cookie string ("name=value; Path=/; HttpOnly"). */
  absorbString(setCookie: string): void {
    const first = setCookie.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) this.jar.set(name, value);
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** Serialize as a Cookie request header. */
  header(): string {
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

/** Polite small delay between Senate requests. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pure parsers (unit-testable, no network).
// ---------------------------------------------------------------------------

/**
 * Extract the hidden csrfmiddlewaretoken from the landing page HTML.
 * Returns '' if not found.
 */
export function parseCsrfMiddlewareToken(html: string): string {
  const m =
    /name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/i.exec(html) ||
    /value=["']([^"']+)["']\s+name=["']csrfmiddlewaretoken["']/i.exec(html);
  return m ? m[1] : '';
}

/**
 * Parse the report path + id out of a DataTables anchor cell, e.g.
 *   "<a href='/search/view/ptr/0f8b.../' target='_blank'>Smith, Jane</a>"
 * Returns { reportPath, reportId } or null if no parseable href.
 */
export function parseReportLink(cellHtml: string): { reportPath: string; reportId: string } | null {
  const hrefMatch = /href=["']([^"']+)["']/i.exec(cellHtml);
  if (!hrefMatch) return null;
  const reportPath = hrefMatch[1];
  // id is the last non-empty path segment (handles trailing slash).
  const segments = reportPath.split('/').filter((s) => s.length > 0);
  const reportId = segments[segments.length - 1] ?? '';
  if (!reportId) return null;
  return { reportPath, reportId };
}

/** Strip HTML tags to recover the visible text of a cell. */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

/**
 * Map a DataTables `data` array (rows of string columns) into SenateFiling[].
 * Each row: [first, last, nameLinkHtml, filingTypeLabel, filedDate].
 * Rows whose link can't be parsed are skipped.
 */
export function parseSenateRows(rows: string[][]): SenateFiling[] {
  const out: SenateFiling[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [first, last, link, filingTypeLabel, filedDate] = row;
    const parsed = parseReportLink(link ?? '');
    if (!parsed) continue;
    const fullName = stripTags(link ?? '') || `${(first ?? '').trim()} ${(last ?? '').trim()}`.trim();
    out.push({
      reportId: parsed.reportId,
      first: (first ?? '').trim(),
      last: (last ?? '').trim(),
      fullName,
      filingTypeLabel: (filingTypeLabel ?? '').trim(),
      filedDate: (filedDate ?? '').trim(),
      reportPath: parsed.reportPath,
      sourceUrl: parsed.reportPath.startsWith('http')
        ? parsed.reportPath
        : `${SENATE_BASE}${parsed.reportPath}`,
      pipelineDocId: `S-${parsed.reportId}`,
    });
  }
  return out;
}

/** Format a Date as the "MM/DD/YYYY HH:MM:SS" string efdsearch expects. */
export function formatSenateDate(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()} ${p2(
    d.getUTCHours(),
  )}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// ---------------------------------------------------------------------------
// Network flow.
// ---------------------------------------------------------------------------

const UA = 'congress-feed/0.1 (+https://congress.trade)';
const POLITE_DELAY_MS = 750;

/**
 * Run the full efdsearch flow and return discovered PTR filings submitted within
 * the [since, now] window. `since` defaults to 7 days ago.
 *
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */
export async function fetchSenatePtrFilings(
  opts: { since?: Date; now?: Date } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SenateFiling[]> {
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const jar = new CookieJar();

  // 1) GET landing page -> csrftoken cookie + hidden middleware token.
  const landing = await fetchImpl(SENATE_SEARCH, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*' },
  });
  if (!landing.ok) throw new Error(`senate GET /search/ -> HTTP ${landing.status}`);
  jar.absorb(landing);
  const landingHtml = await landing.text();
  const middlewareToken = parseCsrfMiddlewareToken(landingHtml);
  if (!middlewareToken) throw new Error('senate: csrfmiddlewaretoken not found on landing page');

  await delay(POLITE_DELAY_MS);

  // 2) POST agreement acceptance (carry cookies).
  const agreeBody = new URLSearchParams({
    prohibition_agreement: '1',
    csrfmiddlewaretoken: middlewareToken,
  });
  const agree = await fetchImpl(SENATE_HOME, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: jar.header(),
      referer: SENATE_SEARCH,
      origin: SENATE_BASE,
    },
    body: agreeBody.toString(),
    redirect: 'manual',
  });
  // 200 or 302 are both fine; we only care that cookies are refreshed.
  jar.absorb(agree);

  await delay(POLITE_DELAY_MS);

  // 3) POST DataTables query for PTRs in the date window.
  const csrfCookie = jar.get('csrftoken') ?? middlewareToken;
  const dataBody = new URLSearchParams();
  dataBody.set('draw', '1');
  dataBody.set('start', '0');
  dataBody.set('length', '100');
  dataBody.set('search[value]', '');
  dataBody.set('search[regex]', 'false');
  // DataTables column ordering: sort by filing date (col 4) descending.
  dataBody.set('order[0][column]', '4');
  dataBody.set('order[0][dir]', 'desc');
  dataBody.set('report_types', '[11]'); // PTR
  dataBody.set('filer_types', '[]');
  dataBody.set('submitted_start_date', formatSenateDate(since));
  dataBody.set('submitted_end_date', formatSenateDate(now));
  dataBody.set('first_name', '');
  dataBody.set('last_name', '');

  const data = await fetchImpl(SENATE_DATA, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      cookie: jar.header(),
      referer: SENATE_SEARCH,
      origin: SENATE_BASE,
      'x-csrftoken': csrfCookie,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json,text/javascript,*/*',
    },
    body: dataBody.toString(),
  });
  if (!data.ok) throw new Error(`senate POST report/data/ -> HTTP ${data.status}`);
  const json = (await data.json()) as { data?: unknown };
  const rows = Array.isArray(json.data) ? (json.data as string[][]) : [];
  return parseSenateRows(rows);
}
