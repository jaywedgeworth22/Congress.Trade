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
import { completeDeliveryOutbox } from './delivery/outbox.ts';
import { completeIngestionOutbox } from './ingestion/outbox.ts';

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
    await markAutopilotRunHalted(env, msg.runId, 'tick_dead_lettered');
    return;
  }

  if (queue.includes('delivery')) {
    if (msg.type !== 'delivery.dispatch') throw new Error('delivery DLQ message has no transaction identity');
    await completeDeliveryOutbox(env, msg.txId);
  } else {
    if (msg.type !== 'filing.new') throw new Error('ingest DLQ message has no doc_id');
    await completeIngestionOutbox(env, msg.docId);
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
