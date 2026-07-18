const WORKER_ORIGIN = 'https://congress.trade';

export function onRequest({ request }: { request: Request }): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, WORKER_ORIGIN);
  return fetch(new Request(target, request));
}
