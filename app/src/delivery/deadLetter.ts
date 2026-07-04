/**
 * src/delivery/deadLetter.ts
 *
 * Operator visibility for queue messages that exhaust their retry budget.
 * wrangler.toml routes terminal failures to a dead-letter queue
 * (congress-feed-{ingest,delivery}-dlq), but nothing consumed, counted, or
 * alerted on them — so a filing that hard-failed extraction or a webhook that
 * failed permanently vanished with zero operator signal, contradicting the
 * product's records-trustworthiness premise. This records each terminal failure
 * to D1 and fires a throttled admin alert on the final attempt, before the
 * message is dead-lettered, so the failure is never silent.
 *
 * Best-effort by contract: a logging failure here must never mask the original
 * error or change the caller's retry/ack behavior.
 */
import type { Env, QueueMessage } from '../shared/types';
import { run } from '../shared/db';
import { notifyAdmin } from '../alerts/notify';

export async function recordDeadLetter(
  env: Env,
  queue: string,
  msg: QueueMessage,
  attempts: number,
  err: unknown,
): Promise<void> {
  const m = msg as { type?: string; docId?: string; txId?: string };
  const error = err instanceof Error ? err.message : String(err);

  try {
    await run(
      env.DB,
      `INSERT INTO dead_letter_events (queue, msg_type, doc_id, tx_id, attempts, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [queue, m.type ?? null, m.docId ?? null, m.txId ?? null, attempts, error.slice(0, 1000), new Date().toISOString()],
    );
  } catch (e) {
    console.warn('recordDeadLetter: D1 insert failed:', (e as Error).message);
  }

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
