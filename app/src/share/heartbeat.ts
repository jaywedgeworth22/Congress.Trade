/**
 * src/share/heartbeat.ts
 * OWNER: share
 *
 * Public heart-beat endpoint for the sibling trading app to verify connectivity
 * and discover active API surfaces. No auth required — safe to call from any
 * client.
 */

import { Hono } from 'hono';
import type { Env } from '../shared/types';

export function buildHeartbeatRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // GET /api/share/heartbeat — public, no auth, returns version + status
  r.get('/heartbeat', (c) =>
    c.json({
      ok: true,
      service: 'congress.trade',
      version: '0.1.0',
      time: new Date().toISOString(),
      endpoints: {
        feed: '/api/client/v1/feed',
        analytics: '/api/analytics',
        market: '/api/market',
        export: '/api/export',
      },
    }),
  );

  return r;
}
