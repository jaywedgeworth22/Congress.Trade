import { proxyToWorker } from '../_proxy';

export function onRequest({ request }: { request: Request }): Promise<Response> {
  return proxyToWorker(request);
}
