/**
 * src/index.ts
 * OWNER: foundation (this scaffold)
 *
 * Worker entrypoint. Wires together:
 *   - fetch():      Hono app. Mounts health, REST/SSE, admin, analytics, auth,
 *                   billing, and UI routers.
 *   - scheduled():  cron handler -> runWatcher() + daily enrichment/price jobs.
 *   - queue():      consumer routing INGEST_QUEUE / DELIVERY_QUEUE messages to
 *                   the appropriate stage handlers by message type.
 *
 * Data flow:
 *   watcher --(filing.new)--> fetcher --(filing.fetched)--> classifier
 *      -> extractor (pipeline) -> normalizer --(tx.persisted)-->
 *      delivery dispatch (webhook/sse) --(delivery.dispatch)--> client.
 */

import { Hono } from 'hono';
import * as Sentry from '@sentry/cloudflare';
import type { Env, QueueMessage } from './shared/types';

// Stage handlers owned by their feature modules.
import { runWatcher } from './ingestion/watcher';
import { fetchFiling } from './ingestion/fetcher';
import { classifyFiling } from './ingestion/classifier';
import { extractAndNormalize } from './extraction/orchestrator';
import { dispatchWebhook } from './delivery/webhook';
import { recordDeadLetter } from './delivery/deadLetter';
import { buildRestRouter } from './delivery/rest';
import { buildAdminRouter } from './admin/routes';
import { buildAnalyticsRouter } from './analytics/routes';
import { buildAuthRouter } from './auth/routes';
import { buildBillingRouter } from './billing/routes';
import { buildClientRouter } from './client/routes';
import { buildExportRouter } from './export/routes';
import { buildUiRouter } from './ui/routes';
import { maybeRunDailyJobs } from './jobs';
import { maybeRunAgreementAutopublish, handleAgreementCheck } from './extraction/agreement';
import { refreshSecrets } from './secrets/infisical';
import { runDisclosureLatencyProbe } from './ingestion/fmpDisclosureLatency';

const app = new Hono<{ Bindings: Env }>();

// --- IMPLEMENTED health check -------------------------------------------------
app.get('/health', (c) => c.json({ ok: true }));

/**
 * Mount the app routers defensively: a build failure is logged and does not take
 * down the worker or the /health route.
 */
function mountApiRouters(root: Hono<{ Bindings: Env }>): void {
  try {
    root.route('/api', buildRestRouter());
  } catch (err) {
    console.warn('delivery/rest router not mounted:', (err as Error).message);
  }
  try {
    root.route('/api/admin', buildAdminRouter());
  } catch (err) {
    console.warn('admin/routes router not mounted:', (err as Error).message);
  }
  try {
    // Read-only trend analytics over the transaction corpus.
    root.route('/api/analytics', buildAnalyticsRouter());
  } catch (err) {
    console.warn('analytics/routes router not mounted:', (err as Error).message);
  }
  try {
    // Shared backend-owned contract for the phone-first PWA and SwiftUI app.
    root.route('/api/client/v1', buildClientRouter());
  } catch (err) {
    console.warn('client/routes router not mounted:', (err as Error).message);
  }
  try {
    // Bulk market-data snapshot export (NDJSON in R2) for App B bootstrapping.
    root.route('/api/export', buildExportRouter());
  } catch (err) {
    console.warn('export/routes router not mounted:', (err as Error).message);
  }
  // End-user auth (Google OAuth + magic-link) at /auth/*. Mounted before the UI
  // catch-all so its routes are not shadowed by the dashboard.
  try {
    root.route('/auth', buildAuthRouter());
  } catch (err) {
    console.warn('auth/routes router not mounted:', (err as Error).message);
  }
  // Stripe billing (checkout / portal / webhook) at /billing/*. Also before the
  // UI catch-all.
  try {
    root.route('/billing', buildBillingRouter());
  } catch (err) {
    console.warn('billing/routes router not mounted:', (err as Error).message);
  }
  // Dashboard SPA at `/` and `/admin`. Registered after /health and /api so the
  // exact UI paths never shadow the API routers.
  try {
    root.route('/', buildUiRouter());
  } catch (err) {
    console.warn('ui/routes router not mounted:', (err as Error).message);
  }
}

mountApiRouters(app);

// max_retries per queue from wrangler.toml — NOT total attempts. Cloudflare
// Queues counts the first delivery as attempts=1, then retries up to this many
// more times, so the final attempt is max_retries + 1; that's the one we
// record + alert on (see delivery/deadLetter.ts) instead of letting the
// message vanish silently once it's actually dead-lettered.
const MAX_QUEUE_ATTEMPTS = { ingest: 5, delivery: 8 } as const;

// --- INGEST queue routing -----------------------------------------------------
async function handleIngestMessage(env: Env, msg: QueueMessage): Promise<void> {
  switch (msg.type) {
    case 'filing.new':
      await fetchFiling(env, msg.docId);
      return;
    case 'filing.fetched':
      await classifyFiling(env, msg.docId);
      return;
    case 'filing.extracted':
      // Run the extractor pipeline + normalizer for this classified filing.
      // normalize() persists transactions (or routes to review) and enqueues
      // delivery.dispatch for each published row.
      await extractAndNormalize(env, msg.docId);
      return;
    case 'tx.persisted':
      // Enqueue delivery fan-out for the newly persisted transaction.
      await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId: msg.txId });
      return;
    case 'agreement.check':
      // Slow cross-vendor agreement read + auto-publish for one review doc. Runs
      // here (generous per-message duration) rather than in the cron, whose
      // scheduled-handler waitUntil cancels long model work.
      await handleAgreementCheck(env, msg.docId, msg.rawObjectKey);
      return;
    default:
      console.warn('INGEST_QUEUE: unexpected message type', (msg as { type?: string }).type);
  }
}

// --- DELIVERY queue routing ---------------------------------------------------
async function handleDeliveryMessage(env: Env, msg: QueueMessage): Promise<void> {
  switch (msg.type) {
    case 'delivery.dispatch':
      await dispatchWebhook(env, msg);
      return;
    default:
      console.warn('DELIVERY_QUEUE: unexpected message type', (msg as { type?: string }).type);
  }
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    // Send traces for a sample of requests (0 = off, 1.0 = all). Override via
    // the SENTRY_TRACES_SAMPLE_RATE var without a redeploy; defaults to a cheap
    // 10% so HTTP/D1/outbound-fetch spans show up without full tracing cost.
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ? Number(env.SENTRY_TRACES_SAMPLE_RATE) : 0.1,
    // Structured logs (Sentry Logs product), plus forward console.warn/error as
    // logs too — the many existing console.error(...) call sites across the
    // codebase become searchable in Sentry for free, without touching each one.
    enableLogs: true,
    integrations: [Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] })],
    // Outbound fetch also hits third-party providers (FMP, Stripe, Resend,
    // Infisical) and arbitrary subscriber webhook URLs (delivery/webhook.ts).
    // Only attach Sentry trace headers to our own domain.
    tracePropagationTargets: [/^https:\/\/([\w-]+\.)?congress\.trade/],
  }),
  {
    /** HTTP entrypoint. */
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
      return app.fetch(request, env, ctx);
    },

    /** Cron entrypoint — runs every minute; watcher self-gates via shouldPollNow.
     *  Daily enrichment + price refresh self-gate via a KV date stamp. */
    async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      // Sentry Crons: alerts if the per-minute watcher tick stops checking in or
      // starts overrunning, independent of whether shouldPollNow decides to poll.
      await Sentry.withMonitor(
        'watcher-cron',
        () => runWatcher(env, new Date()),
        {
          schedule: { type: 'crontab', value: '* * * * *' },
          checkinMargin: 2,
          maxRuntime: 5,
          timezone: 'UTC',
        },
      );
      ctx.waitUntil(refreshSecrets(env).catch((err) => console.warn('infisical secret refresh failed:', (err as Error).message)));
      ctx.waitUntil(
        runDisclosureLatencyProbe(env).catch((err) =>
          console.warn('disclosure latency probe failed:', (err as Error).message),
        ),
      );
      ctx.waitUntil(maybeRunDailyJobs(env));
      // Autonomous cross-vendor agreement → auto-publish for a few newly-reviewed
      // docs each minute (self-gates on AGREEMENT_AUTOPUBLISH_ENABLED; cron-safe).
      ctx.waitUntil(
        maybeRunAgreementAutopublish(env).catch((err) =>
          console.warn('agreement autopublish failed:', (err as Error).message),
        ),
      );
    },

    /**
     * Queue consumer. Routes by the bound queue name to the ingest/delivery
     * handlers. Messages are ack'd individually; failures retry per wrangler.toml.
     */
    async queue(batch, env: Env, _ctx: ExecutionContext): Promise<void> {
      const isDelivery = batch.queue.includes('delivery');
      for (const message of batch.messages) {
        try {
          const msg = message.body as QueueMessage;
          if (isDelivery) {
            await handleDeliveryMessage(env, msg);
          } else {
            await handleIngestMessage(env, msg);
          }
          message.ack();
        } catch (err) {
          console.error(`queue ${batch.queue} message failed:`, (err as Error).message);
          // console.error above is only a breadcrumb/log; the retry swallows the
          // throw, so without this the failure would never create a Sentry Issue.
          Sentry.captureException(err, { tags: { queue: batch.queue } });
          // On the final attempt (about to be dead-lettered), record + alert so a
          // terminally-failed filing/webhook is never silent. Best-effort.
          // Cloudflare Queues counts the first delivery as attempts=1 and
          // dead-letters after max_retries RETRIES beyond that — i.e. the last
          // attempt is max_retries + 1, not max_retries itself.
          const maxAttempts = isDelivery ? MAX_QUEUE_ATTEMPTS.delivery : MAX_QUEUE_ATTEMPTS.ingest;
          if (message.attempts > maxAttempts) {
            await recordDeadLetter(
              env,
              batch.queue,
              message.body as QueueMessage,
              message.attempts,
              err,
            ).catch(() => {});
          }
          message.retry();
        }
      }
    },
  },
);
