/**
 * src/index.ts
 * OWNER: foundation (this scaffold)
 *
 * Worker entrypoint. Wires together:
 *   - fetch():      Hono app. IMPLEMENTED GET /health. Mounts /api delivery +
 *                   /api/admin routers (built by other agents; mounted lazily so
 *                   a not-yet-implemented router doesn't break /health).
 *   - scheduled():  cron handler -> runWatcher() (ingestion stub).
 *   - queue():      consumer routing INGEST_QUEUE / DELIVERY_QUEUE messages to
 *                   the appropriate stub handlers by message type.
 *
 * Data flow:
 *   watcher --(filing.new)--> fetcher --(filing.fetched)--> classifier
 *      -> extractor (pipeline) -> normalizer --(tx.persisted)-->
 *      delivery dispatch (webhook/sse) --(delivery.dispatch)--> client.
 */

import { Hono } from 'hono';
import type { Env, QueueMessage } from './shared/types';

// Stage handlers (stubs owned by other agents).
import { runWatcher } from './ingestion/watcher';
import { fetchFiling } from './ingestion/fetcher';
import { classifyFiling } from './ingestion/classifier';
import { extractAndNormalize } from './extraction/orchestrator';
import { dispatchWebhook } from './delivery/webhook';
import { buildRestRouter } from './delivery/rest';
import { buildAdminRouter } from './admin/routes';
import { buildUiRouter } from './ui/routes';

const app = new Hono<{ Bindings: Env }>();

// --- IMPLEMENTED health check -------------------------------------------------
app.get('/health', (c) => c.json({ ok: true }));

/**
 * Mount the /api routers (delivery REST + admin). These are built by other
 * agents and currently throw NOT_IMPLEMENTED from their builder functions, so we
 * mount them defensively: a build failure is logged and does NOT take down the
 * worker or the /health route.
 */
function mountApiRouters(root: Hono<{ Bindings: Env }>): void {
  try {
    // Builders currently throw NOT_IMPLEMENTED; mount defensively so a stub
    // does not take down the worker or the implemented /health route.
    root.route('/api', buildRestRouter());
  } catch (err) {
    console.warn('delivery/rest router not mounted (stub):', (err as Error).message);
  }
  try {
    root.route('/api/admin', buildAdminRouter());
  } catch (err) {
    console.warn('admin/routes router not mounted (stub):', (err as Error).message);
  }
  // Dashboard SPA at `/` and `/admin`. Registered after /health and /api so the
  // exact UI paths never shadow the API routers.
  try {
    root.route('/', buildUiRouter());
  } catch (err) {
    console.warn('ui/routes router not mounted (stub):', (err as Error).message);
  }
}

mountApiRouters(app);

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
    default:
      console.warn('INGEST_QUEUE: unexpected message type', (msg as { type?: string }).type);
  }
}

// --- DELIVERY queue routing ---------------------------------------------------
async function handleDeliveryMessage(env: Env, msg: QueueMessage): Promise<void> {
  switch (msg.type) {
    case 'delivery.dispatch':
      await dispatchWebhook(env, msg.txId);
      return;
    default:
      console.warn('DELIVERY_QUEUE: unexpected message type', (msg as { type?: string }).type);
  }
}

export default {
  /** HTTP entrypoint. */
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    return app.fetch(request, env, ctx);
  },

  /** Cron entrypoint — runs every minute; watcher self-gates via shouldPollNow. */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runWatcher(env, new Date());
  },

  /**
   * Queue consumer. Routes by the bound queue name to the ingest/delivery
   * handlers. Messages are ack'd individually; failures retry per wrangler.toml.
   */
  async queue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const isDelivery = batch.queue.includes('delivery');
    for (const message of batch.messages) {
      try {
        if (isDelivery) {
          await handleDeliveryMessage(env, message.body);
        } else {
          await handleIngestMessage(env, message.body);
        }
        message.ack();
      } catch (err) {
        console.error(`queue ${batch.queue} message failed:`, (err as Error).message);
        message.retry();
      }
    }
  },
};
