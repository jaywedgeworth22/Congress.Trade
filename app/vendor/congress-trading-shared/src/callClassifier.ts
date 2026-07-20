// =============================================================================
// congress-trading-shared — call classifier metadata
// =============================================================================
// One shared context describes "who/what/where" made an outbound provider
// call. Two pure builders project it into the two shapes producers need:
//   - `openrouterRequestEnrichment` — fields to merge into an OpenRouter
//     completions request body: top-level `user`/`session_id` plus a flat
//     `trace` object. NOTE: per OpenRouter's Broadcast docs, `trace` ITSELF is
//     the arbitrary-metadata object — additional keys placed directly in
//     `trace` are forwarded as trace metadata (and `environment` is a
//     recognized `trace` key). Do NOT nest the fields under a `metadata`
//     sub-object, and never emit a bare top-level `metadata` field.
//   - `telemetryEventClassifier` — the same classifier keys, shaped as a flat
//     string map suitable for a pushed `UsageTelemetryEvent`'s `metadata`
//     field (see `usageTelemetry.ts`).
// `buildCallClassifier` is a convenience wrapper that returns both shapes at
// once for call sites that need to both enrich a request and push telemetry
// from the same context.
//
// All three functions are pure: no I/O, no side effects, deterministic for a
// given `ctx`. Undefined optional fields are omitted from the outputs rather
// than serialized as `undefined`/`null`.
//
// Validation split (deliberate):
//   - STATIC classifier fields (`sourceApp`, `environment`, `service`,
//     `feature`, `keyRef`, `gitSha`) are deploy-time constants — an invalid
//     value is a programming error, so the builders THROW (fail fast in
//     tests, never ship a misclassified call).
//   - RUNTIME-DYNAMIC fields (`user`, `sessionId`) vary per call and must
//     never break a paid LLM request — blank/whitespace-only values are
//     treated as absent and simply OMITTED from the outputs.
// =============================================================================

import { z } from "zod";

/**
 * Normalizes a runtime-dynamic identifier: trims, then treats an empty
 * result as absent so a blank value can never fail a paid call.
 */
const dynamicIdSchema = z
  .string()
  .trim()
  .max(128)
  .transform((value) => (value === "" ? undefined : value))
  .optional();

/**
 * Shared identity/classification context for a single outbound provider call.
 * `sourceApp` is required; every other field is optional and simply omitted
 * from the builder outputs when absent.
 *
 * Static classifier fields reject blank strings (fail fast — they are
 * deploy-time constants). The runtime-dynamic `user`/`sessionId` fields
 * instead collapse blank/whitespace-only values to absent.
 */
export const CallClassifierContextSchema = z.object({
  /** Producer app identifier, e.g. "congress-trade" or "socratic-trade". */
  sourceApp: z.string().trim().min(1).max(80),
  /** Deploy environment, e.g. "production" | "staging" | "development". */
  environment: z.string().trim().min(1).max(80).optional(),
  /** Logical service/subsystem within the app, e.g. "extraction-worker". */
  service: z.string().trim().min(1).max(120).optional(),
  /** Finer-grained feature/call-site tag, e.g. "openrouter-vision-extract". */
  feature: z.string().trim().min(1).max(120).optional(),
  /** Reference to the API key used (name/alias, never the raw secret). */
  keyRef: z.string().trim().min(1).max(160).optional(),
  /** Deployed commit SHA or version tag for the calling build. */
  gitSha: z.string().trim().min(1).max(80).optional(),
  /**
   * Deterministic per-caller/end-user identifier (OpenRouter `user`, max 128
   * chars per OpenRouter's documented limit). Runtime-dynamic: blank values
   * are treated as absent, never an error.
   */
  user: dynamicIdSchema,
  /**
   * Run/session identifier grouping related calls (OpenRouter `session_id`,
   * max 128 chars per OpenRouter's documented limit). Runtime-dynamic: blank
   * values are treated as absent, never an error.
   */
  sessionId: dynamicIdSchema,
});

export type CallClassifierContext = z.infer<typeof CallClassifierContextSchema>;

/**
 * The flat `trace` object merged into an OpenRouter request body. Per
 * OpenRouter's Broadcast docs, `trace` itself carries arbitrary metadata
 * keys — there is no `metadata` sub-object.
 */
export interface CallClassifierTrace {
  sourceApp: string;
  environment?: string;
  service?: string;
  feature?: string;
  keyRef?: string;
  gitSha?: string;
}

/**
 * Fields to merge into an OpenRouter completions request body. Spread this
 * into the request body — do NOT rename `trace`, nest its fields under a
 * `metadata` sub-object, or hoist them to the top level; OpenRouter treats
 * `trace` itself as the arbitrary-metadata object.
 */
export interface OpenRouterRequestEnrichment {
  user?: string;
  session_id?: string;
  trace: CallClassifierTrace;
}

/**
 * Flat string map of classifier fields, safe to merge into a pushed
 * `UsageTelemetryEvent`'s `metadata` field (see `UsageTelemetryMetadataSchema`
 * in `usageTelemetry.ts`, which accepts `Record<string, string | number |
 * boolean | null>`).
 */
export type CallClassifierTelemetryMetadata = Record<string, string>;

/** Combined output of applying both classifier builders to the same context. */
export interface CallClassifierOutputs {
  openrouterRequestEnrichment: OpenRouterRequestEnrichment;
  telemetryMetadata: CallClassifierTelemetryMetadata;
}

/**
 * Builds the fields to merge into an OpenRouter completions request body:
 * top-level `user`/`session_id` plus a flat `trace: { sourceApp, ... }`
 * object (no `metadata` nesting anywhere).
 *
 * Throws if a STATIC classifier field fails validation (e.g. missing/blank
 * `sourceApp`) — those are deploy-time constants and should fail fast. The
 * runtime-dynamic `user`/`sessionId` are OMITTED (never thrown on) when
 * undefined, empty, or whitespace-only, so a blank per-call id can never
 * break a paid LLM request.
 *
 * Caller contract: for absent optional STATIC fields pass `undefined`, never
 * `""` (a blank static field throws by design). Telemetry producers pushing
 * the provider's generation id should likewise send
 * `response.id || undefined` for `providerRequestId` — never an empty string.
 */
export function openrouterRequestEnrichment(
  ctx: CallClassifierContext,
): OpenRouterRequestEnrichment {
  const parsed = CallClassifierContextSchema.parse(ctx);

  const trace: CallClassifierTrace = { sourceApp: parsed.sourceApp };
  if (parsed.environment !== undefined) trace.environment = parsed.environment;
  if (parsed.service !== undefined) trace.service = parsed.service;
  if (parsed.feature !== undefined) trace.feature = parsed.feature;
  if (parsed.keyRef !== undefined) trace.keyRef = parsed.keyRef;
  if (parsed.gitSha !== undefined) trace.gitSha = parsed.gitSha;

  const result: OpenRouterRequestEnrichment = { trace };
  if (parsed.user !== undefined) result.user = parsed.user;
  if (parsed.sessionId !== undefined) result.session_id = parsed.sessionId;
  return result;
}

/**
 * Builds the classifier fields to attach to a pushed usage-telemetry event's
 * `metadata` map.
 *
 * Throws if a STATIC classifier field fails validation (e.g. missing/blank
 * `sourceApp`); the runtime-dynamic `user`/`sessionId` are omitted when
 * undefined, empty, or whitespace-only (see `openrouterRequestEnrichment`
 * for the full caller contract).
 */
export function telemetryEventClassifier(
  ctx: CallClassifierContext,
): CallClassifierTelemetryMetadata {
  const parsed = CallClassifierContextSchema.parse(ctx);

  const metadata: CallClassifierTelemetryMetadata = { sourceApp: parsed.sourceApp };
  if (parsed.environment !== undefined) metadata.environment = parsed.environment;
  if (parsed.service !== undefined) metadata.service = parsed.service;
  if (parsed.feature !== undefined) metadata.feature = parsed.feature;
  if (parsed.keyRef !== undefined) metadata.keyRef = parsed.keyRef;
  if (parsed.gitSha !== undefined) metadata.gitSha = parsed.gitSha;
  if (parsed.user !== undefined) metadata.user = parsed.user;
  if (parsed.sessionId !== undefined) metadata.sessionId = parsed.sessionId;
  return metadata;
}

/**
 * Convenience wrapper returning both classifier shapes for the same context
 * in one call. Equivalent to calling `openrouterRequestEnrichment(ctx)` and
 * `telemetryEventClassifier(ctx)` separately.
 */
export function buildCallClassifier(ctx: CallClassifierContext): CallClassifierOutputs {
  return {
    openrouterRequestEnrichment: openrouterRequestEnrichment(ctx),
    telemetryMetadata: telemetryEventClassifier(ctx),
  };
}
