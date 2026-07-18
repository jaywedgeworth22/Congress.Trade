const WORKER_ORIGIN = 'https://congress.trade';

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, WORKER_ORIGIN);

  const response = await fetch(new Request(target, request));

  const newResponse = new Response(response.body, response);
  const setCookies = newResponse.headers.getSetCookie();

  newResponse.headers.delete('Set-Cookie');
  for (const cookie of setCookies) {
    // Strip Domain=... so cookies apply to the Pages domain
    const newCookie = cookie.replace(/Domain=[^;]+;?/i, '');
    newResponse.headers.append('Set-Cookie', newCookie);
  }

  return newResponse;
}