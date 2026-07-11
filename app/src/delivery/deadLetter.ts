/**
 * src/delivery/deadLetter.ts
 *
 * Operator visibility for queue messages that exhaust their retry budget.
 * wrangler.toml routes terminal failures to a dead-letter queue
 * (congress-feed-{ingest,delivery}-dlq). The Worker actively consumes both,
 * records each terminal receipt, reopens the owning durable outbox, and alerts
 * operators, so an isolate-level crash cannot strand an `enqueued` handoff.
 *
 * Main-queue logging remains best-effort. The dedicated DLQ consumer uses the
 * strict variant and does not ACK until both receipt and recovery are durable.
 */
import type { Env, QueueMessage } from '../shared/types';
import { run } from '../shared/db';
import { notifyAdmin } from '../alerts/notify';

async function insertDeadLetterReceipt(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  err: unknown,
): Promise<void> {
  const m = msg as { type?: string; docId?: string; txId?: string };
  const error = err instanceof Error ? err.message : String(err);

  await run(
    env.DB,
    `INSERT INTO dead_letter_events (queue, msg_type, doc_id, tx_id, attempts, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [queue, m.type ?? null, m.docId ?? null, m.txId ?? null, attempts, error.slice(0, 1000), new Date().toISOString()],
  );
}

async function alertDeadLetter(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  err: unknown,
): Promise<void> {
  const m = msg as { type?: string; docId?: string; txId?: string };
  const error = err instanceof Error ? err.message : String(err);

  try {
    await notifyAdmin(env, {
      subject: `Queue message dead-lettered: ${queue}`,
      text:
        `A ${m.type ?? 'message'} on ${queue} failed ${attempts} attempt(s) and is being dead-lettered.\n\n` +
        `doc_id: ${m.docId ?? '—'}\ntx_id: ${m.txId ?? '—'}\nerror: ${error}`,
      dedupeKey: `dlq:${queue}:${m.type ?? 'msg'}`,
      throttleSec: 3600,
    });
  } catch (e) {
    console.warn('recordDeadLetter: alert failed:', (e as Error).message);
  }
}

/** Best-effort legacy caller; does not change the queue's retry behavior. */
export async function recordDeadLetter(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  err: unknown,
): Promise<void> {
  try {
    await insertDeadLetterReceipt(env, queue, msg, attempts, err);
  } catch (e) {
    console.warn('recordDeadLetter: D1 insert failed:', (e as Error).message);
  }
  await alertDeadLetter(env, queue, msg, attempts, err);
}

/**
 * DLQ-consumer variant: the receipt insert is part of durable recovery and
 * therefore rejects on D1 failure. The caller must not ACK until this resolves.
 */
export async function recordDeadLetterDurable(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  err: unknown,
): Promise<void> {
  await insertDeadLetterReceipt(env, queue, msg, attempts, err);
  await alertDeadLetter(env, queue, msg, attempts, err);
}
