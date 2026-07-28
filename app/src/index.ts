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
import * as Sentry from '#sentry';
import type { Env, QueueMessage } from './shared/types.ts';
import type { DurableQueueLeaseContext } from './deno/durableQueue.ts';

// Stage handlers owned by their feature modules.
import { classifyTransientIngestError, fetchFiling, IngestRetryError } from './ingestion/fetcher.ts';
import { classifyFiling } from './ingestion/classifier.ts';
import { extractAndNormalize } from './extraction/orchestrator.ts';
import { DeliveryRetryError, dispatchWebhook } from './delivery/webhook.ts';
import { recordDeadLetterDurable } from './delivery/deadLetter.ts';
import { buildRestRouter } from './delivery/rest.ts';
import { buildAdminRouter } from './admin/routes.ts';
import { buildAnalyticsRouter } from './analytics/routes.ts';
import { buildAuthRouter } from './auth/routes.ts';
import { buildBillingRouter } from './billing/routes.ts';
import { buildClientRouter } from './client/routes.ts';
import { buildExportRouter } from './export/routes.ts';
import { buildUiRouter } from './ui/routes.ts';
import { flushD1Budget } from './shared/d1Budget.ts';
import { runMaintenancePipeline } from './deno/scheduledTick.ts';
import { handleAgreementCheck } from './extraction/agreement.ts';
import {
  handleAutopilotTick,
  markAutopilotRunHalted,
} from './extraction/autopilot.ts';
import { buildDetectionRouter } from './ingestion/detectionRoutes.ts';
import { browserSecurityHeadersMiddleware } from './security/headers.ts';
import { publicApiGuard } from './security/botDefense.ts';
import {
  completeDeliveryOutbox,
  reconnectDeadLetteredOutbox,
} from './delivery/outbox.ts';
import {
  completeIngestionOutbox,
  reconnectDeadLetteredIngestionOutbox,
} from './ingestion/outbox.ts';
import {
  deliverUsageTelemetryEvent,
  isUsageTelemetryCircuitOpen,
  isTerminalUsageTelemetryDeliveryError,
  persistUsageTelemetryFallback,
  trackedFetch,
  withThirdPartyTelemetry,
} from './shared/thirdPartyTelemetry.ts';

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
export async function handleIngestMessage(
  env: Env,
  msg: QueueMessage,
  queueAttempt = 1,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  switch (msg.type) {
    case 'filing.new':
      if (lease) await fetchFiling(env, msg.docId, queueAttempt, lease);
      else await fetchFiling(env, msg.docId, queueAttempt);
      return;
    case 'filing.fetched':
      if (lease) await classifyFiling(env, msg.docId, lease);
      else await classifyFiling(env, msg.docId);
      return;
    case 'filing.extracted':
      // Run the extractor pipeline + normalizer for this classified filing.
      // normalize() persists transactions (or routes to review) and enqueues
      // delivery.dispatch for each published row.
      if (lease) await extractAndNormalize(env, msg.docId, lease);
      else await extractAndNormalize(env, msg.docId);
      return;
    case 'tx.persisted':
      // Enqueue delivery fan-out for the newly persisted transaction.
      await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId: msg.txId });
      return;
    case 'agreement.check':
      // Slow cross-vendor agreement read + auto-publish for one review doc. Runs
      // here (generous per-message duration) rather than in the cron, whose
      // scheduled-handler waitUntil cancels long model work.
      if (lease) {
        await handleAgreementCheck(
          env,
          msg.docId,
          msg.rawObjectKey,
          msg.escalationTier,
          msg.claimToken,
          lease.signal,
        );
      } else {
        await handleAgreementCheck(
          env,
          msg.docId,
          msg.rawObjectKey,
          msg.escalationTier,
          msg.claimToken,
        );
      }
      return;
    case 'autopilot.tick':
      // One backlog-autopilot slice (a few docs through the same cascade
      // machinery); the handler re-enqueues itself until the run finishes.
      if (lease) {
        await handleAutopilotTick(env, msg.runId, { signal: lease.signal });
      } else {
        await handleAutopilotTick(env, msg.runId);
      }
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
      if (lease) await deliverUsageTelemetryEvent(env, msg.event, lease.signal);
      else await deliverUsageTelemetryEvent(env, msg.event);
      return;
    default:
      console.warn('INGEST_QUEUE: unexpected message type', (msg as { type?: string }).type);
  }
}

// --- DELIVERY queue routing ---------------------------------------------------
export async function handleDeliveryMessage(
  env: Env,
  msg: QueueMessage,
  lease?: DurableQueueLeaseContext,
): Promise<boolean> {
  await lease?.assertOwned();
  switch (msg.type) {
    case 'delivery.dispatch': {
      const result = lease
        ? await dispatchWebhook(env, msg, lease)
        : await dispatchWebhook(env, msg);
      return result.outboxComplete;
    }
    default:
      console.warn('DELIVERY_QUEUE: unexpected message type', (msg as { type?: string }).type);
      return false;
  }
}

/** Authoritative terminal recovery path for the configured Queue DLQs. */
export async function handleDeadLetterMessage(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
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
    if (lease) await deliverUsageTelemetryEvent(env, msg.event, lease.signal);
    else await deliverUsageTelemetryEvent(env, msg.event);
    return;
  }
  await recordDeadLetterDurable(env, queue, msg, attempts, recoveryError);

  if (msg.type === 'autopilot.tick') {
    // A dead-lettered autopilot slice means the run's consumer kept failing:
    // surface it as a halt requiring acknowledgment, never silently drop it.
    await markAutopilotRunHalted(env, msg.runId, 'tick_dead_lettered');
    return;
  }

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

/** Durable receipt for legacy/corrupt payloads that cannot drive outbox recovery. */
export async function handleCorruptDeadLetterMessage(
  env: Env,
  queue: string,
  msg: unknown,
  attempts: number,
  error: string,
  lease?: DurableQueueLeaseContext,
): Promise<void> {
  await lease?.assertOwned();
  await recordDeadLetterDurable(
    env,
    queue,
    msg,
    attempts,
    new Error(`invalid durable queue payload: ${error}`),
  );
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
     *  Daily enrichment + price refresh self-gate via a KV date stamp.
     *  Lane orchestration is shared with the Deno tick (runMaintenancePipeline)
     *  so the two cron paths cannot drift; this wrapper only adds Sentry
     *  monitors/capture per lane and registers the pipeline with waitUntil. */
    async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      return withThirdPartyTelemetry(env, async () => {
      const cronMonitor: Record<string, { monitor: string; tag: string; options?: Record<string, unknown> }> = {
        secrets_refresh: { monitor: 'secrets-refresh-cron', tag: 'secrets-refresh' },
        watcher: {
          monitor: 'watcher-cron',
          tag: 'watcher',
          options: {
            schedule: { type: 'crontab', value: '* * * * *' },
            checkinMargin: 2,
            maxRuntime: 5,
            timezone: 'UTC',
          },
        },
        agreement_autopublish: {
          monitor: 'agreement-autopublish-cron',
          tag: 'agreement-autopublish',
          options: {
            schedule: { type: 'crontab', value: '* * * * *' },
            checkinMargin: 2,
            maxRuntime: 2,
            timezone: 'UTC',
          },
        },
        backlog_autopilot: { monitor: 'backlog-autopilot-cron', tag: 'backlog-autopilot' },
        ingestion_outbox: { monitor: 'ingestion-outbox-cron', tag: 'ingestion-outbox' },
        delivery_outbox: { monitor: 'delivery-outbox-cron', tag: 'delivery-outbox' },
        parked_deliveries: { monitor: 'parked-deliveries-cron', tag: 'parked-deliveries' },
        disclosure_latency: { monitor: 'disclosure-latency-cron', tag: 'disclosure-latency' },
        daily_jobs: { monitor: 'daily-jobs-cron', tag: 'daily-jobs' },
      };
      const pipelinePromise = runMaintenancePipeline(env, {
        outboxLimit: 100,
        // GOVERNOR 3: re-dispatch deliveries parked behind per-target circuit
        // breakers — full release when the target's circuit closed, one hourly
        // probe candidate while it is recovering.
        parkedDeliveryLimit: 50,
        usageTelemetryLimit: 25,
        disclosureLatency: true,
        observeLane: (lane, run) => {
          // Receiver outages must not create Sentry envelopes, which would
          // create another Usage Monitor event and amplify; keep this lane
          // monitor-free and log-only.
          if (lane === 'usage_telemetry') {
            return run()
              .then((result: any) => {
                if (result?.failed > 0) {
                  // console.log is intentionally outside the Sentry warn/error
                  // log integration for the same amplification reason.
                  console.log('usage telemetry fallback remains pending', result);
                }
              })
              .catch((err: unknown) => {
                console.log('usage telemetry fallback drain unavailable', {
                  errorType: err instanceof Error ? err.name : 'unknown',
                });
              });
          }
          const meta = cronMonitor[lane] ?? { monitor: `${lane}-cron`, tag: lane };
          return Sentry.withMonitor(meta.monitor, run, meta.options as never)
            .catch((err: unknown) =>
              Sentry.captureException(err, { tags: { cron: meta.tag } }),
            );
        },
      });
      // Register with waitUntil so the isolate stays alive until every lane
      // settles; the pipeline isolates per-lane failures internally.
      ctx.waitUntil(pipelinePromise.then(() => undefined));
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
    async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
      const typedBatch = batch as unknown as MessageBatch<QueueMessage>;
      return withThirdPartyTelemetry(env, async () => {
      const isDeadLetterQueue = typedBatch.queue.endsWith('-dlq');
      if (isDeadLetterQueue) {
        for (const message of typedBatch.messages) {
          try {
            await handleDeadLetterMessage(
              env,
              typedBatch.queue,
              message.body as QueueMessage,
              message.attempts,
            );
            message.ack();
          } catch (err) {
            const messageType = (message.body as QueueMessage).type;
            if (messageType === 'usage.telemetry' && isTerminalUsageTelemetryDeliveryError(err)) {
              // Deterministic payload/idempotency rejects cannot be recovered
              // by replaying the same DLQ message.
              message.ack();
              continue;
            }
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
                tags: { queue: typedBatch.queue, recovery: 'dead-letter' },
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

      const isDelivery = typedBatch.queue.includes('delivery');
      for (const message of typedBatch.messages) {
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
          if (messageType === 'usage.telemetry' && isTerminalUsageTelemetryDeliveryError(err)) {
            // Ack deterministic payload/idempotency rejects instead of writing
            // the same poison event back to R2 and retrying it forever.
            message.ack();
            continue;
          }
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
            console.error(`queue ${typedBatch.queue} message failed:`, (err as Error).message);
            // Expected queue retries are control flow (at-least-once delivery /
            // transient ingest). Capturing them creates Sentry storms such as
            // CONGRESS-TRADE-J ("webhook delivery target(s) require retry").
            // Reserve Issues for unexpected failures only.
            if (!(err instanceof DeliveryRetryError) && !(err instanceof IngestRetryError)) {
              Sentry.captureException(err as Error, {
                tags: { queue: typedBatch.queue, messageType },
              });
            }
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
