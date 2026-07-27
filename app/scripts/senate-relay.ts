/**
 * app/scripts/senate-relay.ts
 *
 * Lightweight Senate eFD Relay Microservice.
 * Runs on the self-hosted Hetzner runner (coolify-hetzner-congress) or any
 * residential/VPS egress node. Proxying requests to efdsearch.senate.gov
 * bypasses cloud-provider IP blocks without incurring third-party costs ($0.00).
 *
 * Usage:
 *   deno run --allow-net --allow-env scripts/senate-relay.ts
 *   or
 *   npx tsx scripts/senate-relay.ts
 */

const PORT = Number(Deno.env.get('PORT') || Deno.env.get('RELAY_PORT') || '8788');
const RELAY_SECRET = Deno.env.get('SENATE_RELAY_SECRET') || '';

const SENATE_BASE = 'https://efdsearch.senate.gov';
const SENATE_SEARCH = `${SENATE_BASE}/search/`;
const SENATE_HOME = `${SENATE_BASE}/search/home/`;
const SENATE_DATA = `${SENATE_BASE}/search/report/data/`;

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="124", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

function parseCsrfMiddlewareToken(html: string): string | null {
  const match = /name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/i.exec(html);
  return match ? match[1] : null;
}

async function handleRelayRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    return Response.json({ ok: true, service: 'senate-efd-relay', time: new Date().toISOString() });
  }

  // Optional Secret Auth
  if (RELAY_SECRET) {
    const authHeader = req.headers.get('authorization') || '';
    if (authHeader !== `Bearer ${RELAY_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  if (req.method === 'POST' && url.pathname === '/fetch-ptr') {
    try {
      const body = (await req.json()) as {
        submitted_start_date?: string;
        submitted_end_date?: string;
        page?: number;
        pageSize?: number;
      };

      // 1. Establish session
      const landingRes = await fetch(SENATE_SEARCH, {
        headers: {
          ...BROWSER_HEADERS,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!landingRes.ok) {
        return Response.json({ error: `Senate GET search failed: ${landingRes.status}` }, { status: 502 });
      }

      const anyHeaders = landingRes.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies = typeof anyHeaders.getSetCookie === 'function'
        ? anyHeaders.getSetCookie()
        : [landingRes.headers.get('set-cookie') || ''];
      let cookieHeader = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
      const landingHtml = await landingRes.text();
      const csrfToken = parseCsrfMiddlewareToken(landingHtml);

      if (!csrfToken) {
        return Response.json({ error: 'CSRF token missing from Senate landing page' }, { status: 502 });
      }

      // 2. Accept agreement
      const agreeBody = new URLSearchParams({
        prohibition_agreement: '1',
        csrfmiddlewaretoken: csrfToken,
      });

      const agreeRes = await fetch(SENATE_HOME, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'content-type': 'application/x-www-form-urlencoded',
          cookie: cookieHeader,
          referer: SENATE_SEARCH,
          origin: SENATE_BASE,
        },
        body: agreeBody.toString(),
        redirect: 'manual',
      });

      const agreeHeaders = agreeRes.headers as Headers & { getSetCookie?: () => string[] };
      const agreeCookies = typeof agreeHeaders.getSetCookie === 'function'
        ? agreeHeaders.getSetCookie()
        : [agreeRes.headers.get('set-cookie') || ''];
      const updatedCookies = agreeCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
      if (updatedCookies) {
        cookieHeader = `${cookieHeader}; ${updatedCookies}`;
      }

      // 3. DataTables search
      const page = body.page ?? 0;
      const pageSize = body.pageSize ?? 100;
      const dataBody = new URLSearchParams();
      dataBody.set('draw', String(page + 1));
      dataBody.set('start', String(page * pageSize));
      dataBody.set('length', String(pageSize));
      dataBody.set('search[value]', '');
      dataBody.set('search[regex]', 'false');
      dataBody.set('order[0][column]', '4');
      dataBody.set('order[0][dir]', 'desc');
      dataBody.set('report_types', '[11]');
      dataBody.set('filer_types', '[]');
      if (body.submitted_start_date) dataBody.set('submitted_start_date', body.submitted_start_date);
      if (body.submitted_end_date) dataBody.set('submitted_end_date', body.submitted_end_date);
      dataBody.set('first_name', '');
      dataBody.set('last_name', '');

      const dataRes = await fetch(SENATE_DATA, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          cookie: cookieHeader,
          referer: SENATE_SEARCH,
          origin: SENATE_BASE,
          'x-csrftoken': csrfToken,
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json,text/javascript,*/*; q=0.01',
        },
        body: dataBody.toString(),
      });

      if (!dataRes.ok) {
        return Response.json({ error: `Senate POST report/data failed: ${dataRes.status}` }, { status: dataRes.status });
      }

      const json = await dataRes.json();
      return Response.json(json);
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

console.log(`Senate eFD Relay Microservice listening on port ${PORT}`);
// @ts-ignore - Deno global
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  // @ts-ignore
  Deno.serve({ port: PORT }, handleRelayRequest);
}
