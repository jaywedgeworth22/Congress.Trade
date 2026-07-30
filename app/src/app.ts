import { Hono } from 'hono';
import type { Env } from './shared/types.ts';
import { buildRestRouter } from './delivery/rest.ts';
import { buildAdminRouter } from './admin/routes.ts';
import { buildAnalyticsRouter } from './analytics/routes.ts';
import { buildAuthRouter } from './auth/routes.ts';
import { buildBillingRouter } from './billing/routes.ts';
import { buildClientRouter } from './client/routes.ts';
import { buildExportRouter } from './export/routes.ts';
import { buildUiRouter } from './ui/routes.ts';
import { buildDetectionRouter } from './ingestion/detectionRoutes.ts';
import { browserSecurityHeadersMiddleware } from './security/headers.ts';
import { publicApiGuard } from './security/botDefense.ts';

const app = new Hono<{ Bindings: Env }>();

app.use('*', browserSecurityHeadersMiddleware);
app.use('/api/*', publicApiGuard);
app.get('/health', (c) => c.json({ ok: true }));

try { app.route('/api', buildRestRouter()); } catch (err) { console.warn('app.ts: failed to mount /api routes:', err); }
try { app.route('/api/admin', buildAdminRouter()); } catch (err) { console.warn('app.ts: failed to mount /api/admin routes:', err); }
try { app.route('/api/analytics', buildAnalyticsRouter()); } catch (err) { console.warn('app.ts: failed to mount /api/analytics routes:', err); }
try { app.route('/api/client/v1', buildClientRouter()); } catch (err) { console.warn('app.ts: failed to mount /api/client/v1 routes:', err); }
try { app.route('/api/export', buildExportRouter()); } catch (err) { console.warn('app.ts: failed to mount /api/export routes:', err); }
try { app.route('/api/ingest', buildDetectionRouter()); } catch (err) { console.warn('app.ts: failed to mount /api/ingest routes:', err); }
try { app.route('/auth', buildAuthRouter()); } catch (err) { console.warn('app.ts: failed to mount /auth routes:', err); }
try { app.route('/billing', buildBillingRouter()); } catch (err) { console.warn('app.ts: failed to mount /billing routes:', err); }
try { app.route('/', buildUiRouter()); } catch (err) { console.warn('app.ts: failed to mount / routes:', err); }

app.onError((err, c) => {
  console.error('[Unhandled Error]:', err);
  const accept = c.req.header('Accept') || '';
  if (accept.includes('text/html')) {
    return c.html(
      `<!DOCTYPE html><html><head><title>Congress.Trade - Error</title><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f19;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}.card{background:#151c2c;padding:32px;border-radius:12px;border:1px solid #2d3748;max-width:480px;width:100%;text-align:center;box-shadow:0 10px 25px -5px rgba(0,0,0,0.5)}h2{margin-top:0;color:#ef4444;font-size:22px}p{color:#a0aec0;font-size:14px;line-height:1.5;margin:16px 0 24px}.btn{display:inline-block;background:#3182ce;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px}</style></head><body><div class="card"><h2>Server Error (500)</h2><p>${c.env?.SENTRY_ENVIRONMENT === 'production' ? 'An unexpected server error occurred. Please try refreshing or returning home.' : (err.message || 'An unexpected error occurred.')}</p><a href="/" class="btn">Return to Home</a></div></body></html>`,
      500,
    );
  }
  return c.json({ error: err.message || 'Internal Server Error' }, 500);
});

export default app;
