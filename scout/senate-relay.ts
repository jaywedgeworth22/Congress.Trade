// Local Senate eFD relay — runs on the owner's residential Mac, where
// efdsearch.senate.gov is reachable (Imperva blocks the production box's
// datacenter IP with a bare 403 on GET /search/, verified 2026-08-09).
//
// Implements the exact 3-step flow documented in
// app/src/ingestion/senateSource.ts's header comment, faithfully mirrored
// (headers, body shape, cookie handling) so the production app's existing
// SENATE_RELAY_URL contract (POST {url}/fetch-ptr -> {data: string[][]})
// is satisfied without any app code change. Read-only: GET the landing page,
// POST the prohibition-agreement acceptance, POST the DataTables search,
// paginate until exhausted, return the combined raw rows.
//
// Run: deno run --allow-net senate-relay.ts [port]

const SENATE_BASE = 'https://efdsearch.senate.gov';
const SENATE_SEARCH = `${SENATE_BASE}/search/`;
const SENATE_HOME = `${SENATE_BASE}/search/home/`;
const SENATE_DATA = `${SENATE_BASE}/search/report/data/`;
const PAGE_SIZE = 100;
const MAX_PAGES = 25; // mirrors SENATE_MAX_PAGES — a month-window query stays well under this
const POLITE_DELAY_MS = 400;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': UA,
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="124", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

class CookieJar {
  private jar = new Map<string, string>();
  absorb(res: Response) {
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
    const cookies =
      typeof anyHeaders.getSetCookie === 'function'
        ? anyHeaders.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie') as string]
          : [];
    for (const c of cookies) {
      const first = c.split(';', 1)[0];
      const eq = first.indexOf('=');
      if (eq > 0) this.jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  get(name: string) {
    return this.jar.get(name);
  }
  header() {
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCsrfMiddlewareToken(html: string): string {
  const m = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

async function establishSession() {
  const jar = new CookieJar();
  const landing = await fetch(SENATE_SEARCH, {
    headers: {
      ...BROWSER_HEADERS,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
  });
  if (!landing.ok) throw new Error(`senate GET /search/ -> HTTP ${landing.status}`);
  jar.absorb(landing);
  const html = await landing.text();
  const token = parseCsrfMiddlewareToken(html);
  if (!token) throw new Error('senate: csrfmiddlewaretoken not found on landing page');

  await delay(POLITE_DELAY_MS);

  const agreeBody = new URLSearchParams({ prohibition_agreement: '1', csrfmiddlewaretoken: token });
  const agree = await fetch(SENATE_HOME, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: jar.header(),
      referer: SENATE_SEARCH,
      origin: SENATE_BASE,
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
    },
    body: agreeBody.toString(),
    redirect: 'manual',
  });
  jar.absorb(agree);
  await delay(POLITE_DELAY_MS);

  const csrfCookie = jar.get('csrftoken') ?? token;
  return { csrfCookie, cookieHeader: jar.header() };
}

function fmtSenateDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} 00:00:00`;
}

async function fetchAllRows(sinceIso: string, nowIso: string, pageSize: number): Promise<string[][]> {
  const since = new Date(sinceIso);
  const now = new Date(nowIso);
  const session = await establishSession();
  const rows: string[][] = [];
  let expectedTotal: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = new URLSearchParams();
    body.set('draw', String(page + 1));
    body.set('start', String(page * pageSize));
    body.set('length', String(pageSize));
    body.set('search[value]', '');
    body.set('search[regex]', 'false');
    body.set('order[0][column]', '4');
    body.set('order[0][dir]', 'desc');
    body.set('report_types', '[11]');
    body.set('filer_types', '[]');
    body.set('submitted_start_date', fmtSenateDate(since));
    body.set('submitted_end_date', fmtSenateDate(now));
    body.set('first_name', '');
    body.set('last_name', '');

    const res = await fetch(SENATE_DATA, {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        cookie: session.cookieHeader,
        referer: SENATE_SEARCH,
        origin: SENATE_BASE,
        'x-csrftoken': session.csrfCookie,
        'x-requested-with': 'XMLHttpRequest',
        accept: 'application/json,text/javascript,*/*; q=0.01',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
      body: body.toString(),
    });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('application/json')) {
      throw new Error(`senate POST report/data/ -> HTTP ${res.status} ${ct}`);
    }
    const json = (await res.json()) as { data?: unknown; recordsFiltered?: unknown };
    const pageRows = Array.isArray(json.data) ? (json.data as string[][]) : [];
    rows.push(...pageRows);
    const filtered = Number(json.recordsFiltered);
    if (Number.isFinite(filtered)) expectedTotal = filtered;
    if (pageRows.length < pageSize) break;
    if (expectedTotal !== null && rows.length >= expectedTotal) break;
    await delay(POLITE_DELAY_MS);
  }
  return rows;
}

const port = Number(Deno.args[0]) || 8899;
console.log(`senate-relay listening on 127.0.0.1:${port}`);

Deno.serve({ port, hostname: '127.0.0.1' }, async (req) => {
  const url = new URL(req.url);
  if (req.method !== 'POST' || url.pathname !== '/fetch-ptr') {
    return new Response('not found', { status: 404 });
  }
  try {
    const body = (await req.json()) as {
      submitted_start_date?: string;
      submitted_end_date?: string;
      pageSize?: number;
    };
    // Contract sends MM/DD/YYYY HH:MM:SS (formatSenateDate's output on the app
    // side); re-parse leniently into Date since we reformat ourselves anyway.
    const parse = (s?: string) => {
      if (!s) return new Date();
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : new Date(s);
    };
    const since = parse(body.submitted_start_date).toISOString();
    const now = parse(body.submitted_end_date).toISOString();
    const pageSize = Math.min(Math.max(body.pageSize || PAGE_SIZE, 1), PAGE_SIZE);
    const t0 = Date.now();
    const data = await fetchAllRows(since, now, pageSize);
    console.log(`fetch-ptr ${body.submitted_start_date}..${body.submitted_end_date} -> ${data.length} rows in ${Date.now() - t0}ms`);
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  } catch (err) {
    console.error('fetch-ptr error:', (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
});
