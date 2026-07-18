const WORKER_ORIGIN = 'https://congress.trade';
const COOKIE_DOMAIN_RE = /;\s*Domain=[^;]+/gi;

type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] };

function rewriteSetCookies(headers: Headers): Headers {
  const responseHeaders = new Headers(headers);
  responseHeaders.delete('set-cookie');

  const rawSetCookies = (headers as HeadersWithSetCookie).getSetCookie?.()
    ?? (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);

  for (const cookie of rawSetCookies) {
    responseHeaders.append('set-cookie', cookie.replace(COOKIE_DOMAIN_RE, ''));
  }

  return responseHeaders;
}

export async function proxyToWorker(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, WORKER_ORIGIN);
  const upstream = await fetch(new Request(target, request));
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: rewriteSetCookies(upstream.headers),
  });
}
