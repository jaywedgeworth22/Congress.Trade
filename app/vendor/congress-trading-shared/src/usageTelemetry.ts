import { z } from "zod";

export const UsageTelemetryMetricTypeSchema = z.enum([
  "usage",
  "cost",
  "quota",
  "tier",
  "health",
  "balance",
  "limit",
  "quota_sync",
  "credit_balance",
  // Recurring fixed-cost events materialized by the API Usage Monitor
  // (subscription-materializer). Kept in the shared enum so producers can
  // validate before send; monitor already accepts this value.
  "subscription",
]);

export const UsageTelemetryUnitSchema = z.enum([
  "request",
  "call",
  "token",
  "credit",
  "usd",
  "page",
  "job",
  "document",
  "row",
  "byte",
]);

export const UsageTelemetryBillingModeSchema = z.enum([
  "actual",
  "estimated",
  "manual",
]);

export const UsageTelemetryConfidenceSchema = z.enum([
  "actual",
  "estimated",
  "manual",
]);

export const UsageTelemetryLimitWindowSchema = z.enum([
  "minute",
  "day",
  "month",
  "run",
]);

export const UsageTelemetryMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
).transform((metadata) => {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, 50)) {
    const key = rawKey.trim().slice(0, 80);
    if (!key) continue;
    clean[key] = typeof rawValue === "string" ? rawValue.slice(0, 500) : rawValue;
  }
  return clean;
});

export const UsageTelemetryEventSchema = z.object({
  sourceApp: z.string().trim().min(1).max(80),
  environment: z.string().trim().min(1).max(80).optional(),
  provider: z.string().trim().min(1).max(80),
  service: z.string().trim().min(1).max(120).optional(),
  // Per-project attribution name. Resolved to Project.id on the monitor at
  // ingest. Deliberately NOT part of the idempotency basis — adding it there
  // would rekey existing events.
  project: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(160).optional(),
  keyRef: z.string().trim().min(1).max(160).optional(),
  billingMode: UsageTelemetryBillingModeSchema.default("estimated"),
  metricType: UsageTelemetryMetricTypeSchema.default("usage"),
  quantity: z.number().finite().nonnegative().optional(),
  unit: UsageTelemetryUnitSchema.optional(),
  costUsd: z.number().finite().nonnegative().optional(),
  requests: z.number().int().nonnegative().optional(),
  credits: z.number().finite().nonnegative().optional(),
  limit: z.number().finite().nonnegative().optional(),
  limitWindow: UsageTelemetryLimitWindowSchema.optional(),
  tier: z.string().trim().min(1).max(80).optional(),
  confidence: UsageTelemetryConfidenceSchema.default("estimated"),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  occurredAt: z.string().datetime().optional(),
  // The provider-side call/generation id (e.g. OpenRouter's `id` on a
  // completions response), pushed so the monitor can verify reported cost
  // against the provider's own record (e.g. `GET /api/v1/generation?id=...`).
  // CONTRACT: deliberately NOT part of `deriveUsageTelemetryIdempotencyKey`'s
  // basis — adding it there would change the key for existing/replayed
  // events. Keep the idempotency key derivation limited to sourceApp,
  // provider, metricType, keyRef, and occurredAt.
  providerRequestId: z.string().trim().min(1).max(200).optional(),
  metadata: UsageTelemetryMetadataSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const UsageTelemetryBatchSchema = z.object({
  events: z.array(UsageTelemetryEventSchema).min(1).max(100),
});

export const UsageTelemetryIngestResponseSchema = z.object({
  ok: z.boolean(),
  accepted: z.number().int().nonnegative(),
  ignoredPruned: z.number().int().nonnegative().optional(),
});

export type UsageTelemetryMetricType = z.infer<typeof UsageTelemetryMetricTypeSchema>;
export type UsageTelemetryUnit = z.infer<typeof UsageTelemetryUnitSchema>;
export type UsageTelemetryBillingMode = z.infer<typeof UsageTelemetryBillingModeSchema>;
export type UsageTelemetryConfidence = z.infer<typeof UsageTelemetryConfidenceSchema>;
export type UsageTelemetryLimitWindow = z.infer<typeof UsageTelemetryLimitWindowSchema>;
export type UsageTelemetryEventInput = z.input<typeof UsageTelemetryEventSchema>;
export type UsageTelemetryEvent = z.infer<typeof UsageTelemetryEventSchema>;
export type UsageTelemetryBatchInput = z.input<typeof UsageTelemetryBatchSchema>;
export type UsageTelemetryBatch = z.infer<typeof UsageTelemetryBatchSchema>;
export type UsageTelemetryIngestResponse = z.infer<typeof UsageTelemetryIngestResponseSchema>;

export const API_USAGE_MONITOR_INGEST_PATH = "/api/ingest/usage";

export function usageMonitorIngestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${API_USAGE_MONITOR_INGEST_PATH}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Length-prefixes each field before joining, so two fields that straddle a
// delimiter character (e.g. provider="b|c" + keyRef="" vs provider="b" +
// keyRef="c") can never hash to the same basis string. Each field is encoded
// as `<utf8-byte-length>:<value>` (a la netstrings), which is unambiguous
// because the length prefix tells the reader exactly where the value ends -
// no value can contain a byte sequence that gets misread as a boundary.
// CONTRACT: this MUST stay byte-for-byte identical to the server-side
// algorithm in the API Usage Monitor repo's `src/lib/usage-telemetry.ts`.
function encodeIdempotencyField(value: string): string {
  return `${new TextEncoder().encode(value).length}:${value}`;
}

/**
 * Computes the same deterministic idempotency key the API Usage Monitor server
 * derives server-side as a fallback (see `deriveIdempotencyKey` in that repo's
 * `src/lib/usage-telemetry.ts`). Computing and attaching it here ensures
 * retries of the same event collapse to the same key instead of each retry
 * getting its own random fallback key on the server.
 *
 * CONTRACT — this MUST stay byte-for-byte identical to the server algorithm:
 *   basis = encodeField(sourceApp) + encodeField(provider) + encodeField(metricType)
 *         + encodeField(keyRef ?? "") + encodeField(occurredAt)
 *   key   = sha256Hex(basis)
 * where encodeField(v) = `${utf8ByteLength(v)}:${v}` (see encodeIdempotencyField).
 *
 * Both sides apply their own defaulting (e.g. metricType -> "usage") BEFORE
 * computing the basis string, so `event` here is expected to already be the
 * fully-defaulted event (see `send()` below, which derives the key from
 * `UsageTelemetryBatchSchema.parse(...)` output, after Zod's `.default()`
 * values have been applied). If either side ever changes the field order,
 * the encoding scheme, the hash algorithm, or *when* defaults are applied
 * relative to hashing, idempotency will silently break — update both repos
 * together and bump a version marker if the format ever changes.
 */
export async function deriveUsageTelemetryIdempotencyKey(event: {
  sourceApp: string;
  provider: string;
  metricType: string;
  keyRef?: string;
  occurredAt?: string;
}): Promise<string | undefined> {
  if (!event.occurredAt) return undefined;
  const basis = [event.sourceApp, event.provider, event.metricType, event.keyRef ?? "", event.occurredAt]
    .map(encodeIdempotencyField)
    .join("");
  return sha256Hex(basis);
}

export interface UsageTelemetryClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Reject events without a caller-supplied identity instead of relying on the five-field fallback. */
  requireExplicitIdempotencyKey?: boolean;
}

export function createUsageTelemetryClient(options: UsageTelemetryClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = usageMonitorIngestUrl(options.baseUrl);

  return {
    async send(events: UsageTelemetryEventInput[]): Promise<UsageTelemetryIngestResponse> {
      const parsed = UsageTelemetryBatchSchema.parse({ events });
      if (options.requireExplicitIdempotencyKey) {
        const missingIndex = parsed.events.findIndex((event) => !event.idempotencyKey);
        if (missingIndex >= 0) {
          throw new Error(`Usage telemetry event ${missingIndex} requires an explicit idempotencyKey`);
        }
      }
      const body: UsageTelemetryBatch = {
        events: await Promise.all(
          parsed.events.map(async (event) => {
            if (event.idempotencyKey) return event;
            const idempotencyKey = await deriveUsageTelemetryIdempotencyKey(event);
            return idempotencyKey ? { ...event, idempotencyKey } : event;
          }),
        ),
      };
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = typeof payload === "object" && payload && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : `HTTP ${res.status}`;
        throw new Error(`Usage telemetry ingest failed: ${message}`);
      }
      return UsageTelemetryIngestResponseSchema.parse(payload);
    },
  };
}
