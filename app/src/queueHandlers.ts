import type { Env, QueueMessage } from './shared/types.ts';
import type { DurableQueueLeaseContext } from './deno/durableQueue.ts';
import { fetchFiling } from './ingestion/fetcher.ts';
import { classifyFiling } from './ingestion/classifier.ts';
import { extractAndNormalize } from './extraction/orchestrator.ts';
import { dispatchWebhook } from './delivery/webhook.ts';
import { recordDeadLetterDurable } from './delivery/deadLetter.ts';
import { handleAgreementCheck } from './extraction/agreement.ts';
import { handleAutopilotTick, markAutopilotRunHalted } from './extraction/autopilot.ts';
import {
  isUsageTelemetryCircuitOpen,
  deliverUsageTelemetryEvent,
} from './shared/thirdPartyTelemetry.ts';
import { persistUsageTelemetryFallback } from './shared/thirdPartyTelemetry.ts';
import { reconnectDeadLetteredOutbox } from './delivery/outbox.ts';
import { reconnectDeadLetteredIngestionOutbox } from './ingestion/outbox.ts';
import { executeQueuedCommand } from './client/commands.ts';
import { updateCommandStatus } from './client/state.ts';

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
      if (lease) await extractAndNormalize(env, msg.docId, lease);
      else await extractAndNormalize(env, msg.docId);
      return;
    case 'tx.persisted':
      await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId: msg.txId });
      return;
    case 'command.execute':
      await executeQueuedCommand(env, msg.commandId, msg.userId);
      return;
    case 'agreement.check':
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
      if (lease) {
        await handleAutopilotTick(env, msg.runId, { signal: lease.signal });
      } else {
        await handleAutopilotTick(env, msg.runId);
      }
      return;
    case 'usage.telemetry':
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

/** Authoritative terminal recovery path for queue dead letters (single source
 * of truth — index.ts re-exports this so the Workers and Deno paths cannot
 * diverge again). */
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
    // Re-open the outbox row with bounded backoff cycles instead of marking
    // it completed — completing here permanently abandons the webhook.
    const recovered = await reconnectDeadLetteredOutbox(env, msg.txId, recoveryError.message);
    if (recovered.status === 'missing') {
      console.warn(`delivery outbox missing for ${msg.txId}`);
    }
    return;
  }

  if (msg.type === 'command.execute') {
    // Retry budget exhausted: terminalize the command row so clients
    // polling GET /commands/:id see a failure instead of a stuck status.
    await updateCommandStatus(env, msg.userId, msg.commandId, 'failed', {
      error: recoveryError.message,
    });
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
  }
}

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
