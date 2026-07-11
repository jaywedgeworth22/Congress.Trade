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
import { classifyTransientIngestError, fetchFiling, IngestRetryError } from './ingestion/fetcher';
import { classifyFiling } from './ingestion/classifier';
import { extractAndNormalize } from './extraction/orchestrator';
import { DeliveryRetryError, dispatchWebhook } from './delivery/webhook';
import { recordDeadLetterDurable } from './delivery/deadLetter';
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
import { buildDetectionRouter } from './ingestion/detectionRoutes';
import { browserSecurityHeadersMiddleware } from './security/headers';

const app = new Hono<{ Bindings: Env }>();

// Attach defense-in-depth browser headers to every Worker-generated response,
// including error and redirect responses. HSTS is added only for HTTPS.
app.use('*', browserSecurityHeadersMiddleware);

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
  try {
    // Residential detection scout push (INGEST_TOKEN) -> disclosure-latency race.
    root.route('/api/ingest', buildDetectionRouter());
  } catch (err) {
    console.warn('ingestion/detectionRoutes router not mounted:', (err as Error).message);
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

// --- INGEST queue routing -----------------------------------------------------
async function handleIngestMessage(env: Env, msg: QueueMessage, queueAttempt = 1): Promise<void> {
  switch (msg.type) {
    case 'filing.new':
      await fetchFiling(env, msg.docId, queueAttempt);
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
async function handleDeliveryMessage(env: Env, msg: QueueMessage): Promise<boolean> {
  switch (msg.type) {
    case 'delivery.dispatch': {
      const result = await dispatchWebhook(env, msg);
      return result.outboxComplete;
    }
    default:
      console.warn('DELIVERY_QUEUE: unexpected message type', (msg as { type?: string }).type);
      return false;
  }
}

/** Authoritative terminal recovery path for the configured Queue DLQs. */
async function handleDeadLetterMessage(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
): Promise<void> {
  const recoveryError = new Error(`consumer retry budget exhausted; received by ${queue}`);
  await recordDeadLetterDurable(env, queue, msg, attempts, recoveryError);

  if (queue.includes('delivery')) {
    if (msg.type !== 'delivery.dispatch') throw new Error('delivery DLQ message has no transaction identity');
    const recovered = await reconnectDeadLetteredOutbox(env, msg.txId, recoveryError.message);
    if (recovered.status === 'missing') throw new Error(`delivery outbox missing for ${msg.txId}`);
    return;
  }

  if (!('docId' in msg) || !msg.docId) throw new Error('ingest DLQ message has no filing identity');
  const recovered = await reconnectDeadLetteredIngestionOutbox(
    env,
    msg.docId,
    recoveryError.message,
    new Date(),
    { reopenCompleted: msg.type !== 'filing.new' },
  );
  if (recovered.status === 'missing') throw new Error(`ingestion outbox missing for ${msg.docId}`);
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
      // Register independent maintenance first. A watcher/config failure must
      // never prevent durable outboxes, secrets, or daily jobs from running.
      ctx.waitUntil(
        Sentry.withMonitor('delivery-outbox-cron', () =>
          flushDeliveryOutbox(env, { limit: 100 }),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'delivery-outbox' } }),
        ),
      );
      ctx.waitUntil(
        Sentry.withMonitor('ingestion-outbox-cron', () =>
          flushIngestionOutbox(env, { limit: 100 }),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'ingestion-outbox' } }),
        ),
      );
      ctx.waitUntil(
        Sentry.withMonitor('secrets-refresh-cron', () =>
          refreshSecrets(env),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'secrets-refresh' } }),
        ),
      );
      ctx.waitUntil(
        Sentry.withMonitor('disclosure-latency-cron', () =>
          runDisclosureLatencyProbe(env),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'disclosure-latency' } }),
        ),
      );
      ctx.waitUntil(
        Sentry.withMonitor('daily-jobs-cron', () =>
          maybeRunDailyJobs(env),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'daily-jobs' } }),
        ),
      );
      ctx.waitUntil(
        Sentry.withMonitor('agreement-autopublish-cron', () =>
          maybeRunAgreementAutopublish(env),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'agreement-autopublish' } }),
        ),
      );
      // Sentry Crons: alerts if the per-minute watcher tick stops checking in or
      // starts overrunning, independent of whether shouldPollNow decides to poll.
      ctx.waitUntil(
        Sentry.withMonitor(
          'watcher-cron',
          () => runWatcher(env, new Date()),
          {
            schedule: { type: 'crontab', value: '* * * * *' },
            checkinMargin: 2,
            maxRuntime: 5,
            timezone: 'UTC',
          },
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'watcher' } }),
        ),
      );
    },

    /**
     * Queue consumer. Routes by the bound queue name to the ingest/delivery
     * handlers. Messages are ack'd individually; failures retry per wrangler.toml.
     */
    async queue(batch, env: Env, _ctx: ExecutionContext): Promise<void> {
      const isDeadLetterQueue = batch.queue.endsWith('-dlq');
      if (isDeadLetterQueue) {
        for (const message of batch.messages) {
          try {
            await handleDeadLetterMessage(
              env,
              batch.queue,
              message.body as QueueMessage,
              message.attempts,
            );
            message.ack();
          } catch (err) {
            Sentry.captureException(err as Error, {
              tags: { queue: batch.queue, recovery: 'dead-letter' },
            });
            message.retry({ delaySeconds: 60 });
          }
        }
        return;
      }

      const isDelivery = batch.queue.includes('delivery');
      for (const message of batch.messages) {
        try {
          const msg = message.body as QueueMessage;
          Sentry.setTags({
            queue: isDelivery ? 'delivery' : 'ingest',
            messageType: msg.type ?? 'unknown',
          });
          if (isDelivery) {
            const shouldComplete = await handleDeliveryMessage(env, msg);
            if (shouldComplete && msg.type === 'delivery.dispatch') {
              const completion = await completeDeliveryOutbox(env, msg.txId);
              if (completion === 'missing') {
                // Legacy/direct queue messages predate the outbox. Their work
                // is complete, and retrying cannot manufacture an origin row.
                console.warn('delivery outbox completion skipped: missing', msg.txId);
              }
            }
          } else {
            await handleIngestMessage(env, msg, message.attempts);
            if (msg.type === 'filing.new') {
              const completion = await completeIngestionOutbox(env, msg.docId);
              if (completion === 'missing') {
                console.warn('ingestion outbox completion skipped: missing', msg.docId);
              }
            }
          }
          message.ack();
        } catch (err) {
          const ingestRetry = isDelivery
            ? null
            : classifyTransientIngestError(err, message.attempts);
          console.error(`queue ${batch.queue} message failed:`, (err as Error).message);
          // console.error above is only a breadcrumb/log; the retry swallows the
          // throw, so without this the failure would never create a Sentry Issue.
          Sentry.captureException(err as Error, { tags: { queue: batch.queue, messageType: (message.body as QueueMessage).type ?? 'unknown' } });
          if (err instanceof DeliveryRetryError || err instanceof IngestRetryError) {
            message.retry({ delaySeconds: err.delaySeconds });
          } else if (ingestRetry) {
            message.retry({ delaySeconds: ingestRetry.delaySeconds });
          } else {
            message.retry();
          }
        }
      }
    },
  },
);
