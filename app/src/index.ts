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
import { flushD1Budget } from './shared/d1Budget';
import { maybeRunAgreementAutopublish, handleAgreementCheck } from './extraction/agreement';
import { refreshSecrets } from './secrets/infisical';
import { runDisclosureLatencyProbe } from './ingestion/fmpDisclosureLatency';
import { buildDetectionRouter } from './ingestion/detectionRoutes';
import { browserSecurityHeadersMiddleware } from './security/headers';
import { publicApiGuard } from './security/botDefense';
import {
  completeDeliveryOutbox,
  flushDeliveryOutbox,
  reconnectDeadLetteredOutbox,
} from './delivery/outbox';
import {
  completeIngestionOutbox,
  flushIngestionOutbox,
  reconnectDeadLetteredIngestionOutbox,
} from './ingestion/outbox';
import {
  deliverUsageTelemetryEvent,
  flushUsageTelemetryFallback,
  isUsageTelemetryCircuitOpen,
  persistUsageTelemetryFallback,
  trackedFetch,
  withThirdPartyTelemetry,
} from './shared/thirdPartyTelemetry';

const app = new Hono<{ Bindings: Env }>();

// Attach defense-in-depth browser headers to every Worker-generated response,
// including error and redirect responses. HSTS is added only for HTTPS.
app.use('*', browserSecurityHeadersMiddleware);

// Anti-scraping guard for the public data API (user-agent blocklist + per-IP
// request budget + X-Robots-Tag). Runs before the feature routers; token-gated
// surfaces (/api/admin, /api/ingest, /api/export) are exempt inside the guard.
app.use('/api/*', publicApiGuard);

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
      await handleAgreementCheck(env, msg.docId, msg.rawObjectKey, msg.escalationTier, msg.claimToken);
      return;
    case 'usage.telemetry':
      // While the circuit breaker is open (receiver known-down), skip the live
      // delivery attempt entirely and go straight to the R2 outbox. Acking
      // here (instead of throwing so the queue retries) is what stops a dead
      // receiver from being hammered by this message's own retry/backoff
      // cadence on top of every other in-flight event doing the same thing.
      if (await isUsageTelemetryCircuitOpen(env)) {
        await persistUsageTelemetryFallback(env, msg.event, { throwOnFailure: true });
        return;
      }
      await deliverUsageTelemetryEvent(env, msg.event);
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
  if (msg.type === 'usage.telemetry') {
    // The ingest DLQ has a much larger retry budget (up to 100 retries), which
    // is exactly the amplification surface a dead receiver hit during the
    // incident this circuit breaker guards against. Respect it here too:
    // while open, persist to the R2 outbox and stop, instead of continuing to
    // attempt the exact same idempotent event on every DLQ redelivery.
    if (await isUsageTelemetryCircuitOpen(env)) {
      await persistUsageTelemetryFallback(env, msg.event, { throwOnFailure: true });
      return;
    }
    await deliverUsageTelemetryEvent(env, msg.event);
    return;
  }
  await recordDeadLetterDurable(env, queue, msg, attempts, recoveryError);

  if (queue.includes('delivery')) {
    if (msg.type !== 'delivery.dispatch') throw new Error('delivery DLQ message has no transaction identity');
    const recovered = await reconnectDeadLetteredOutbox(env, msg.txId, recoveryError.message);
    if (recovered.status === 'missing') {
      console.warn(`delivery outbox missing for ${msg.txId}`);
      return;
    }
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
  if (recovered.status === 'missing') {
    console.warn(`ingestion outbox missing for ${msg.docId}`);
    return;
  }
}

const SENTRY_FILTERED_VALUE = '[Filtered]';
const SENTRY_CREDENTIAL_KEYS = new Set([
  'apikey',
  'xapikey',
  'key',
  'token',
  'accesstoken',
  'authtoken',
  'authorization',
  'proxyauthorization',
  'clientsecret',
  'secret',
  'signature',
  'sig',
  'code',
  'password',
  'passwd',
  'session',
  'sessionid',
  'cookie',
  'setcookie',
]);

function normalizedSentryField(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSentryCredentialField(value: string): boolean {
  return SENTRY_CREDENTIAL_KEYS.has(normalizedSentryField(value));
}

function redactSentryQuery(query: string): string {
  const prefix = query.startsWith('?') ? '?' : '';
  const raw = prefix ? query.slice(1) : query;
  if (!raw.includes('=')) return query;
  const params = new URLSearchParams(raw);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (!isSentryCredentialField(key)) continue;
    params.set(key, SENTRY_FILTERED_VALUE);
    changed = true;
  }
  return changed ? `${prefix}${params.toString()}` : query;
}

function redactSentryUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return urlString;
    let changed = false;
    if (url.username || url.password) {
      url.username = SENTRY_FILTERED_VALUE;
      url.password = SENTRY_FILTERED_VALUE;
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!isSentryCredentialField(key)) continue;
      url.searchParams.set(key, SENTRY_FILTERED_VALUE);
      changed = true;
    }
    return changed ? url.toString() : urlString;
  } catch {
    return urlString;
  }
}

function isSentryKeyValueCollection(field: string): boolean {
  const normalized = normalizedSentryField(field);
  return normalized.includes('query') || normalized.includes('header');
}

function scrubSentryKeyValueTuple(tuple: unknown[], field: string): unknown[] {
  if (tuple.length < 2 || typeof tuple[0] !== 'string') {
    return tuple.map((item) => scrubSentryValue(item, field));
  }
  const [key, child, ...rest] = tuple;
  return [
    key,
    isSentryCredentialField(key)
      ? SENTRY_FILTERED_VALUE
      : scrubSentryValue(child, key),
    ...rest.map((item) => scrubSentryValue(item, field)),
  ];
}

function scrubSentryValue(value: unknown, field = ''): unknown {
  if (typeof value === 'string') {
    if (isSentryCredentialField(field)) return SENTRY_FILTERED_VALUE;
    if (normalizedSentryField(field).includes('query')) return redactSentryQuery(value);
    return value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactSentryUrl(url));
  }
  if (Array.isArray(value)) {
    if (!isSentryKeyValueCollection(field)) {
      return value.map((item) => scrubSentryValue(item, field));
    }
    if (value.length >= 2 && typeof value[0] === 'string') {
      return scrubSentryKeyValueTuple(value, field);
    }
    return value.map((item) => (
      Array.isArray(item)
        ? scrubSentryKeyValueTuple(item, field)
        : scrubSentryValue(item, field)
    ));
  }
  if (value && typeof value === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      scrubbed[key] = isSentryCredentialField(key)
        ? SENTRY_FILTERED_VALUE
        : scrubSentryValue(child, key);
    }
    return scrubbed;
  }
  return value;
}

function scrubSentryEvent<T>(event: T): T {
  return scrubSentryValue(event) as T;
}

function sentryOptions(env: Env, tracesSampleRate: number) {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    tracesSampleRate,
    // Fetch instrumentation records complete provider URLs (including query
    // credentials). Scrub at the final event hooks so errors, breadcrumbs, and
    // transaction span attributes are clean before envelope serialization.
    beforeSend: <T>(event: T) => scrubSentryEvent(event),
    beforeSendTransaction: <T>(event: T) => scrubSentryEvent(event),
    beforeSendLog: <T>(log: T) => scrubSentryEvent(log),
    // Structured logs (Sentry Logs product), plus forward console.warn/error as
    // logs too — the many existing console.error(...) call sites across the
    // codebase become searchable in Sentry for free, without touching each one.
    enableLogs: true,
    integrations: [Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] })],
    // Meter the SDK-owned Sentry envelope transport too. The explicit Env is
    // required because the SDK can flush after the request callback unwinds.
    transportOptions: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        trackedFetch(
          input,
          init,
          { service: 'observability', operation: 'send-envelope' },
          fetch,
          { envOverride: env, silentQueueFailure: true },
        ),
    },
    // Outbound fetch also hits third-party providers (FMP, Stripe, Resend,
    // Infisical) and arbitrary subscriber webhook URLs (delivery/webhook.ts).
    // Only attach Sentry trace headers to our own domain.
    tracePropagationTargets: [/^https:\/\/([\w-]+\.)?congress\.trade/],
  };
}

const requestAndScheduledWorker = Sentry.withSentry(
  (env: Env) => sentryOptions(
    env,
    // Send traces for a sample of requests (0 = off, 1.0 = all). Override via
    // the SENTRY_TRACES_SAMPLE_RATE var without a redeploy; defaults to a cheap
    // 10% so HTTP/D1/outbound-fetch spans show up without full tracing cost.
    env.SENTRY_TRACES_SAMPLE_RATE ? Number(env.SENTRY_TRACES_SAMPLE_RATE) : 0.1,
  ),
  {
    /** HTTP entrypoint. */
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
      const response = withThirdPartyTelemetry(env, () => app.fetch(request, env, ctx));
      // Flush this request's metered D1 rows after the response settles — the
      // read path is where analytics/scraper scans accrue. Best-effort, never blocks.
      ctx.waitUntil(Promise.resolve(response).catch(() => undefined).then(() => flushD1Budget(env)));
      return response;
    },

    /** Cron entrypoint — runs every minute; watcher self-gates via shouldPollNow.
     *  Daily enrichment + price refresh self-gate via a KV date stamp. */
    async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      return withThirdPartyTelemetry(env, async () => {
      // Register independent maintenance first. A watcher/config failure must
      // never prevent durable outboxes, secrets, or daily jobs from running.
      // `track` also collects each task so the D1 row meter flushes once, after
      // all of them settle (the heavy D1 work runs inside these tasks).
      const tasks: Promise<unknown>[] = [];
      const track = (p: Promise<unknown>): void => {
        tasks.push(p);
        ctx.waitUntil(p);
      };
      track(
        Sentry.withMonitor('delivery-outbox-cron', () =>
          flushDeliveryOutbox(env, { limit: 100 }),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'delivery-outbox' } }),
        ),
      );
      track(
        Sentry.withMonitor('ingestion-outbox-cron', () =>
          flushIngestionOutbox(env, { limit: 100 }),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'ingestion-outbox' } }),
        ),
      );
      track(
        flushUsageTelemetryFallback(env, { limit: 25 })
          .then((result) => {
            if (result.failed > 0) {
              // console.log is intentionally outside the Sentry warn/error log
              // integration: receiver outages must not create new envelopes.
              console.log('usage telemetry fallback remains pending', result);
            }
          })
          .catch((err) => {
            console.log('usage telemetry fallback drain unavailable', {
              errorType: err instanceof Error ? err.name : 'unknown',
            });
          }),
      );
      track(
        Sentry.withMonitor('secrets-refresh-cron', () =>
          refreshSecrets(env),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'secrets-refresh' } }),
        ),
      );
      track(
        Sentry.withMonitor('disclosure-latency-cron', () =>
          runDisclosureLatencyProbe(env),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'disclosure-latency' } }),
        ),
      );
      track(
        Sentry.withMonitor('daily-jobs-cron', () =>
          maybeRunDailyJobs(env),
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'daily-jobs' } }),
        ),
      );
      track(
        Sentry.withMonitor(
          'agreement-autopublish-cron',
          () => maybeRunAgreementAutopublish(env),
          {
            schedule: { type: 'crontab', value: '* * * * *' },
            checkinMargin: 2,
            maxRuntime: 2,
            timezone: 'UTC',
          },
        ).catch((err) =>
          Sentry.captureException(err, { tags: { cron: 'agreement-autopublish' } }),
        ),
      );
      // Sentry Crons: alerts if the per-minute watcher tick stops checking in or
      // starts overrunning, independent of whether shouldPollNow decides to poll.
      track(
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
      // Flush the isolate's metered D1 rows once all cron work settles.
      ctx.waitUntil(Promise.allSettled(tasks).then(() => flushD1Budget(env)));
      });
    },
  },
);

const queueWorker = Sentry.withSentry(
  // Queue transaction envelopes are themselves metered through INGEST_QUEUE.
  // Never sample queue traces, or each envelope would enqueue another traced
  // queue invocation. Explicit captureException events remain enabled.
  (env: Env) => sentryOptions(env, 0),
  {
    /**
     * Queue consumer. Routes by the bound queue name to the ingest/delivery
     * handlers. Messages are ack'd individually; failures retry per wrangler.toml.
     */
    async queue(batch, env: Env, _ctx: ExecutionContext): Promise<void> {
      return withThirdPartyTelemetry(env, async () => {
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
            const messageType = (message.body as QueueMessage).type;
            // Usage Monitor outage retries must not create a Sentry envelope,
            // which would create another Usage Monitor event and amplify.
            if (messageType === 'usage.telemetry') {
              const retained = await persistUsageTelemetryFallback(
                env,
                (message.body as QueueMessage & { type: 'usage.telemetry' }).event,
              );
              if (retained) {
                message.ack();
                continue;
              }
            } else {
              Sentry.captureException(err as Error, {
                tags: { queue: batch.queue, recovery: 'dead-letter' },
              });
            }
            message.retry({ delaySeconds: 60 });
          }
        }
        // Flush this DLQ batch's metered D1 rows (outbox-reopen writes). The
        // queue handler awaits all its work inline, so we await the flush too
        // (messages are already ack'd; a quick KV write does not delay them).
        await flushD1Budget(env);
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
          const messageType = (message.body as QueueMessage).type;
          const ingestRetry = isDelivery
            ? null
            : classifyTransientIngestError(err, message.attempts);
          if (messageType === 'usage.telemetry') {
            const retained = await persistUsageTelemetryFallback(
              env,
              (message.body as QueueMessage & { type: 'usage.telemetry' }).event,
            );
            if (retained) {
              message.ack();
              continue;
            }
          } else {
            console.error(`queue ${batch.queue} message failed:`, (err as Error).message);
            // console.error above is only a breadcrumb/log; the retry swallows the
            // throw, so without this the failure would never create a Sentry Issue.
            Sentry.captureException(err as Error, { tags: { queue: batch.queue, messageType } });
          }
          if (err instanceof DeliveryRetryError || err instanceof IngestRetryError) {
            message.retry({ delaySeconds: err.delaySeconds });
          } else if (ingestRetry) {
            message.retry({ delaySeconds: ingestRetry.delaySeconds });
          } else {
            message.retry();
          }
        }
      }
      // Flush this batch's metered D1 rows (ingest/delivery writes).
      await flushD1Budget(env);
      });
    },
  },
);

export default {
  fetch: requestAndScheduledWorker.fetch,
  scheduled: requestAndScheduledWorker.scheduled,
  queue: queueWorker.queue,
};
