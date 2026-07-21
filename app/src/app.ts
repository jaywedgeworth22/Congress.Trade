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

try { app.route('/api', buildRestRouter()); } catch (err) {}
try { app.route('/api/admin', buildAdminRouter()); } catch (err) {}
try { app.route('/api/analytics', buildAnalyticsRouter()); } catch (err) {}
try { app.route('/api/client/v1', buildClientRouter()); } catch (err) {}
try { app.route('/api/export', buildExportRouter()); } catch (err) {}
try { app.route('/api/ingest', buildDetectionRouter()); } catch (err) {}
try { app.route('/auth', buildAuthRouter()); } catch (err) {}
try { app.route('/billing', buildBillingRouter()); } catch (err) {}
try { app.route('/', buildUiRouter()); } catch (err) {}

export default app;
