import type { Env, QueueMessage } from "../shared/types.ts";

export const DURABLE_QUEUE_MAX_BATCH_SIZE = 100;
export const DURABLE_QUEUE_DEFAULT_LIMIT = 25;
export const DURABLE_QUEUE_DEFAULT_CLAIM_SIZE = 10;
export const DURABLE_QUEUE_DEFAULT_LEASE_MS = 10 * 60_000;
export const DURABLE_QUEUE_DEFAULT_MAX_ATTEMPTS = 8;
export const DURABLE_QUEUE_RETRY_BASE_MS = 30_000;
export const DURABLE_QUEUE_RETRY_MAX_MS = 30 * 60_000;

export type DurableQueueName = "ingest" | "delivery";

export interface DurableQueueSendOptions {
  delaySeconds?: number;
}

export interface DurableQueueBatchMessage<Message>
  extends DurableQueueSendOptions {
  body: Message;
}

export interface DurableQueueHandlers {
  handleIngestMessage(
    env: Env,
    message: QueueMessage,
    attempts: number,
  ): Promise<void>;
  handleDeliveryMessage(env: Env, message: QueueMessage): Promise<boolean>;
  handleDeadLetterMessage(
    env: Env,
    queueName: string,
    message: QueueMessage,
    attempts: number,
  ): Promise<void>;
  completeIngestionOutbox(env: Env, docId: string): Promise<unknown>;
  completeDeliveryOutbox(env: Env, txId: string): Promise<unknown>;
}

export interface DurableQueueDrainOptions {
  limit?: number;
  claimSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export interface DurableQueueDrainResult {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

interface DurableQueueRow {
  id: number | string;
  queue_name: string;
  payload: string;
  status: string;
  attempts: number | string;
  dead_letter_pending: number | string;
  available_at: string;
  lease_until: string | null;
  lease_token: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface D1ResultLike<T = unknown> {
  success?: boolean;
  results?: T[];
  error?: string;
  meta?: unknown;
}

function resultOrThrow<T>(
  result: D1ResultLike<T>,
  operation: string,
): D1ResultLike<T> {
  if (result.success === false) {
    throw new Error(
      `${operation}: ${result.error || "database operation failed"}`,
    );
  }
  return result;
}

async function allOrThrow<T>(
  statement: D1PreparedStatement,
  operation: string,
): Promise<T[]> {
  const result = resultOrThrow(
    await statement.all<T>() as unknown as D1ResultLike<T>,
    operation,
  );
  return result.results ?? [];
}

async function runOrThrow(
  statement: D1PreparedStatement,
  operation: string,
): Promise<D1ResultLike> {
  return resultOrThrow(
    await statement.run() as unknown as D1ResultLike,
    operation,
  );
}

function normalizedDelaySeconds(delaySeconds: number | undefined): number {
  if (delaySeconds === undefined) return 0;
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
    throw new Error("queue delaySeconds must be a finite non-negative number");
  }
  return Math.floor(delaySeconds);
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    DURABLE_QUEUE_RETRY_MAX_MS,
    DURABLE_QUEUE_RETRY_BASE_MS * (2 ** exponent),
  );
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function queueDedupeKey(
  queueName: DurableQueueName,
  value: unknown,
): string | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  const type = typeof message.type === "string" ? message.type : "";
  const key = (...parts: unknown[]) =>
    `${queueName}:${type}:${parts.map((part) => String(part ?? "")).join(":")}`;
  switch (type) {
    case "filing.new":
    case "filing.fetched":
    case "filing.extracted":
      return typeof message.docId === "string" ? key(message.docId) : null;
    case "tx.persisted":
      return typeof message.txId === "string" ? key(message.txId) : null;
    case "agreement.check":
      return typeof message.docId === "string"
        ? key(message.docId, message.claimToken, message.escalationTier)
        : null;
    case "delivery.dispatch":
      return typeof message.txId === "string"
        ? key(message.txId, message.subscriptionId, message.afterSubscriptionId)
        : null;
    case "usage.telemetry": {
      const event = message.event as Record<string, unknown> | undefined;
      return typeof event?.idempotencyKey === "string"
        ? key(event.idempotencyKey)
        : null;
    }
    case "autopilot.tick":
      return typeof message.runId === "string" ? key(message.runId) : null;
    default:
      return null;
  }
}

function requireString(
  value: unknown,
  field: string,
  type: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid ${type} queue message: ${field} is required`);
  }
}

/** Reject malformed or cross-queue payloads instead of silently acknowledging them. */
export function assertCanonicalQueueMessage(
  queueName: DurableQueueName,
  value: unknown,
): asserts value is QueueMessage {
  if (!value || typeof value !== "object") {
    throw new Error(`invalid ${queueName} queue message: expected an object`);
  }
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (typeof type !== "string") {
    throw new Error(`invalid ${queueName} queue message: type is required`);
  }

  if (queueName === "delivery") {
    if (type !== "delivery.dispatch") {
      throw new Error(`invalid delivery queue message type: ${type}`);
    }
    requireString(message.txId, "txId", type);
    return;
  }

  switch (type) {
    case "filing.new":
      requireString(message.docId, "docId", type);
      requireString(message.sourceUrl, "sourceUrl", type);
      if (!["house", "senate", "executive"].includes(String(message.chamber))) {
        throw new Error(`invalid ${type} queue message: chamber is required`);
      }
      return;
    case "filing.fetched":
    case "filing.extracted":
      requireString(message.docId, "docId", type);
      return;
    case "tx.persisted":
      requireString(message.txId, "txId", type);
      requireString(message.docId, "docId", type);
      return;
    case "agreement.check":
      requireString(message.docId, "docId", type);
      if (
        message.rawObjectKey !== null &&
        typeof message.rawObjectKey !== "string"
      ) {
        throw new Error(
          `invalid ${type} queue message: rawObjectKey must be a string or null`,
        );
      }
      return;
    case "autopilot.tick":
      requireString(message.runId, "runId", type);
      return;
    case "usage.telemetry":
      if (!message.event || typeof message.event !== "object") {
        throw new Error(
          "invalid usage.telemetry queue message: event is required",
        );
      }
      return;
    default:
      throw new Error(`invalid ingest queue message type: ${type}`);
  }
}

/** Cloudflare Queue-compatible producer backed by the shared Turso database. */
export class DurableQueueAdapter<Message> {
  constructor(
    private readonly db: D1Database,
    private readonly queueName: DurableQueueName,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(
    message: Message,
    options?: DurableQueueSendOptions,
  ): Promise<void> {
    await this.sendBatch([{
      body: message,
      delaySeconds: options?.delaySeconds,
    }]);
  }

  async sendBatch(
    messages: DurableQueueBatchMessage<Message>[],
  ): Promise<void> {
    if (messages.length === 0) return;
    if (messages.length > DURABLE_QUEUE_MAX_BATCH_SIZE) {
      throw new Error(
        `queue batch exceeds ${DURABLE_QUEUE_MAX_BATCH_SIZE} messages`,
      );
    }

    const createdAt = this.now();
    const valuesSql: string[] = [];
    const bindings: unknown[] = [];
    for (const message of messages) {
      const delaySeconds = normalizedDelaySeconds(message.delaySeconds);
      const availableAt = new Date(createdAt.getTime() + delaySeconds * 1_000)
        .toISOString();
      const payload = JSON.stringify(message.body);
      if (payload === undefined) {
        throw new Error("queue message is not JSON serializable");
      }
      valuesSql.push("(?, ?, ?, 'pending', 0, 0, ?, NULL, NULL, NULL, ?, ?)");
      bindings.push(
        this.queueName,
        queueDedupeKey(this.queueName, message.body),
        payload,
        availableAt,
        createdAt.toISOString(),
        createdAt.toISOString(),
      );
    }

    await runOrThrow(
      this.db.prepare(`
        INSERT OR IGNORE INTO deno_runtime_queue
          (queue_name, dedupe_key, payload, status, attempts, dead_letter_pending,
           available_at, lease_until,
           lease_token, last_error, created_at, updated_at)
        VALUES ${valuesSql.join(", ")}
      `).bind(...bindings),
      `persist ${this.queueName} queue batch`,
    );
  }
}

async function claimMessages(
  db: D1Database,
  queueName: DurableQueueName,
  limit: number,
  now: Date,
  leaseMs: number,
): Promise<DurableQueueRow[]> {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const leaseToken = crypto.randomUUID();
  return await allOrThrow<DurableQueueRow>(
    db.prepare(`
      UPDATE deno_runtime_queue
      SET status = 'processing',
          attempts = attempts + 1,
          lease_until = ?,
          lease_token = ?,
          updated_at = ?
      WHERE id IN (
        SELECT id
        FROM deno_runtime_queue
        WHERE queue_name = ?
          AND (
            (status = 'pending' AND available_at <= ?)
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
          )
        ORDER BY available_at ASC, id ASC
        LIMIT ?
      )
      RETURNING id, queue_name, payload, status, attempts, available_at,
                dead_letter_pending, lease_until, lease_token, last_error,
                created_at, updated_at
    `).bind(leaseUntil, leaseToken, nowIso, queueName, nowIso, nowIso, limit),
    `claim ${queueName} queue messages`,
  );
}

async function transitionClaim(
  db: D1Database,
  row: DurableQueueRow,
  sql: string,
  bindings: unknown[],
  operation: string,
): Promise<boolean> {
  const rows = await allOrThrow<{ id: number | string }>(
    db.prepare(`${sql} RETURNING id`).bind(
      ...bindings,
      row.id,
      row.lease_token,
    ),
    operation,
  );
  return rows.length === 1;
}

async function completeClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
): Promise<boolean> {
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'completed', lease_until = NULL, lease_token = NULL,
         last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    [now.toISOString()],
    `complete durable queue message ${row.id}`,
  );
}

async function retryClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
  error: unknown,
): Promise<boolean> {
  const attempts = Number(row.attempts);
  const availableAt = new Date(now.getTime() + retryDelayMs(attempts))
    .toISOString();
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'pending', available_at = ?, lease_until = NULL, lease_token = NULL,
         last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    [availableAt, errorText(error), now.toISOString()],
    `retry durable queue message ${row.id}`,
  );
}

async function retryDeadLetterClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
  error: unknown,
): Promise<boolean> {
  const availableAt = new Date(
    now.getTime() + retryDelayMs(Number(row.attempts)),
  ).toISOString();
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'pending', dead_letter_pending = 1, available_at = ?,
         lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    [availableAt, errorText(error), now.toISOString()],
    `retry durable dead-letter receipt ${row.id}`,
  );
}

async function failClaim(
  db: D1Database,
  row: DurableQueueRow,
  now: Date,
  error: unknown,
): Promise<boolean> {
  return await transitionClaim(
    db,
    row,
    `UPDATE deno_runtime_queue
     SET status = 'failed', dead_letter_pending = 0,
         lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'processing' AND lease_token = ?`,
    [errorText(error), now.toISOString()],
    `fail durable queue message ${row.id}`,
  );
}

async function dispatchMessage(
  env: Env,
  queueName: DurableQueueName,
  message: QueueMessage,
  attempts: number,
  handlers: DurableQueueHandlers,
): Promise<void> {
  if (queueName === "delivery") {
    const shouldComplete = await handlers.handleDeliveryMessage(env, message);
    if (shouldComplete && message.type === "delivery.dispatch") {
      await handlers.completeDeliveryOutbox(env, message.txId);
    }
    return;
  }

  await handlers.handleIngestMessage(env, message, attempts);
  if (message.type === "filing.new") {
    await handlers.completeIngestionOutbox(env, message.docId);
  }
}

export async function drainDurableQueue(
  env: Env,
  queueName: DurableQueueName,
  handlers: DurableQueueHandlers,
  options: DurableQueueDrainOptions = {},
): Promise<DurableQueueDrainResult> {
  const limit = Math.max(
    0,
    Math.floor(options.limit ?? DURABLE_QUEUE_DEFAULT_LIMIT),
  );
  const claimSize = Math.max(
    1,
    Math.floor(options.claimSize ?? DURABLE_QUEUE_DEFAULT_CLAIM_SIZE),
  );
  const leaseMs = Math.max(
    1_000,
    Math.floor(options.leaseMs ?? DURABLE_QUEUE_DEFAULT_LEASE_MS),
  );
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? DURABLE_QUEUE_DEFAULT_MAX_ATTEMPTS),
  );
  const now = options.now ?? (() => new Date());
  const result: DurableQueueDrainResult = {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
  };

  while (result.claimed < limit) {
    const remaining = limit - result.claimed;
    const rows = await claimMessages(
      env.DB,
      queueName,
      Math.min(claimSize, remaining),
      now(),
      leaseMs,
    );
    if (rows.length === 0) break;
    result.claimed += rows.length;

    for (const row of rows) {
      const attempts = Number(row.attempts);
      let parsed: unknown;
      if (Number(row.dead_letter_pending) === 1) {
        try {
          parsed = JSON.parse(row.payload);
          assertCanonicalQueueMessage(queueName, parsed);
          await handlers.handleDeadLetterMessage(
            env,
            `${queueName}-dlq`,
            parsed,
            attempts,
          );
          if (
            await failClaim(
              env.DB,
              row,
              now(),
              row.last_error || "message exhausted retries",
            )
          ) {
            result.failed += 1;
          }
        } catch (deadLetterError) {
          if (
            await retryDeadLetterClaim(
              env.DB,
              row,
              now(),
              deadLetterError,
            )
          ) {
            result.retried += 1;
          }
        }
        continue;
      }
      try {
        parsed = JSON.parse(row.payload);
        assertCanonicalQueueMessage(queueName, parsed);
        await dispatchMessage(env, queueName, parsed, attempts, handlers);
        if (await completeClaim(env.DB, row, now())) result.completed += 1;
      } catch (error) {
        if (attempts < maxAttempts) {
          if (await retryClaim(env.DB, row, now(), error)) result.retried += 1;
          continue;
        }

        if (parsed && typeof parsed === "object") {
          try {
            assertCanonicalQueueMessage(queueName, parsed);
            await handlers.handleDeadLetterMessage(
              env,
              `${queueName}-dlq`,
              parsed,
              attempts,
            );
          } catch (deadLetterError) {
            const terminalError = new Error(
              `${errorText(error)}; dead-letter recovery failed: ${
                errorText(deadLetterError)
              }`,
            );
            if (
              await retryDeadLetterClaim(
                env.DB,
                row,
                now(),
                terminalError,
              )
            ) {
              result.retried += 1;
            }
            continue;
          }
        }
        if (await failClaim(env.DB, row, now(), error)) {
          result.failed += 1;
        }
      }
    }
  }

  return result;
}

export async function drainDurableQueues(
  env: Env,
  handlers: DurableQueueHandlers,
  options: DurableQueueDrainOptions = {},
): Promise<
  { ingest: DurableQueueDrainResult; delivery: DurableQueueDrainResult }
> {
  const ingest = await drainDurableQueue(env, "ingest", handlers, options);
  const delivery = await drainDurableQueue(env, "delivery", handlers, options);
  return { ingest, delivery };
}
