/**
 * Senate-relay liveness probes.
 *
 * mac.jays.services answers GET / with health JSON.  scout.jays.services used
 * to 404 on GET / and HEAD /health (Deno.serve does not map HEAD onto GET),
 * so a browser or UptimeRobot HEAD looked dead while GET /health was 200.
 * GET and HEAD on / and /health are the same dependency-free process probe.
 */

export const LIVENESS_PATHS = new Set(['/', '/health']);
export const LIVENESS_METHODS = new Set(['GET', 'HEAD']);

export function isLivenessProbe(method: string, pathname: string): boolean {
  return LIVENESS_METHODS.has(method) && LIVENESS_PATHS.has(pathname);
}

export function livenessPayload(uptimeSeconds: number): {
  ok: true;
  service: 'senate-relay';
  uptimeSeconds: number;
} {
  return { ok: true, service: 'senate-relay', uptimeSeconds };
}

export function livenessResponse(method: string, uptimeSeconds: number): Response {
  const headers = { 'content-type': 'application/json' };
  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(JSON.stringify(livenessPayload(uptimeSeconds)), {
    status: 200,
    headers,
  });
}
