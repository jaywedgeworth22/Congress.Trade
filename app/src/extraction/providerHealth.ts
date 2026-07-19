/**
 * src/extraction/providerHealth.ts
 *
 * Provider-health-aware routing for live extraction (self-healing, replaces
 * agent-driven slot swaps).
 *
 * Three cooperating pieces:
 *
 * 1. ROLLING HEALTH WINDOW — every concrete provider:model read (success or
 *    failure) is recorded into a per-model KV window
 *    (`provider_health:<provider>:<model>`), with failures classified into
 *    stable error classes (billing / auth / quota / parse / timeout / other).
 *
 * 2. PER-MODEL CIRCUIT BREAKER — when billing/auth failures hit the trip
 *    threshold (default >=5 consecutive, or >=80% of attempts in a 15-minute
 *    window), the concrete provider:model is banned via
 *    `provider_ban:<provider>:<model>` (KV, TTL'd). This EXTENDS the existing
 *    per-provider ban (`provider_ban:<provider>` in configuredVision.ts) —
 *    it never replaces it — and is keyed per concrete model, never per
 *    composite extractor-chain name.
 *
 * 3. RUNTIME OVERLAY SUBSTITUTION — when a configured slot's model is banned,
 *    the live extractor may substitute the CHEAPEST healthy candidate from
 *    the offered benchmark catalog (DEFAULT_CANDIDATES) for that request.
 *    This is an overlay, not a config write: the configured lineup in
 *    Infisical stays authoritative and resumes automatically once the ban
 *    expires / health recovers. Substitutions are auditable via
 *    ingestion_decisions (action 'provider_substituted') and surfaced in
 *    GET /api/admin/diagnostics.
 *
 * COST GUARD: substitution preference order is cheapest-first per the shared
 * rate card, and a substitute costing more than
 * PROVIDER_OVERLAY_COST_RATIO_LIMIT (default 3x) of the configured slot's
 * rate-card cost is FLAGGED in the audit row and diagnostics (the exact
 * failure mode this guards: a dead cheap primary silently failing over to a
 * frontier model and burning real money in hours).
 *
 * KV read-modify-write is not transactional across isolates; the window is a
 * health heuristic, not an accounting record, so a rare lost update only
 * delays a trip by one observation.
 */

import type { Env } from '../shared/types';
import { resolveSecrets } from '../secrets/infisical';
import {
  DEFAULT_CANDIDATES,
  isRetiredDisclosureCandidate,
  keyFor,
  type BakeoffCandidate,
  type Provider,
} from './bakeoff';
import { getUnderlyingProvider, isOpenRouterAuto } from '../benchmark/settings';
import { estimateNominalReadCostUsd } from './benchmarkMetrics';

export type ProviderErrorClass = 'billing' | 'auth' | 'quota' | 'parse' | 'timeout' | 'other';

/** Error classes that indicate a dead account/key rather than a bad document. */
export const BREAKER_ERROR_CLASSES: readonly ProviderErrorClass[] = ['billing', 'auth'];

const label = (c: { provider: string; model: string }): string => `${c.provider}:${c.model}`;

/**
 * Classify one extraction error string into a stable, secret-safe class.
 * Billing/auth/quota patterns intentionally mirror classifyProviderFailure
 * (providerFailure.ts) and the isProviderRateLimit regexes so the same
 * failure is never counted under two different classes by two code paths.
 */
export function classifyProviderErrorClass(
  error: string | null | undefined,
): ProviderErrorClass | null {
  const message = (error ?? '').trim().toLowerCase();
  if (!message) return null;
  if (
    /\b402\b/.test(message)
    || message.includes('payment required')
    || message.includes('credits are depleted')
    || message.includes('prepayment credits')
    || message.includes('credit balance is too low')
    || message.includes('insufficient_quota')
    || message.includes('billing hard limit')
  ) return 'billing';
  if (
    /\b401\b/.test(message)
    || message.includes('invalid_api_key')
    || message.includes('invalid api key')
    || message.includes('authentication')
    || message.includes('unauthorized')
    || message.includes('api key not configured')
    || message.includes('rejected the configured credential')
  ) return 'auth';
  if (
    /\b429\b/.test(message)
    || message.includes('too many requests')
    || /rate[- ]?limit/.test(message)
    || message.includes('quota exceeded')
    || message.includes('usage limit')
  ) return 'quota';
  if (
    /\b408\b/.test(message)
    || /\b504\b/.test(message)
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('aborted')
    || message.includes('abort')
  ) return 'timeout';
  if (
    message.includes('parse')
    || message.includes('json')
    || message.includes('no candidate text')
    || message.includes('empty completion')
    || message.includes('no text')
    || message.includes('empty markdown')
  ) return 'parse';
  return 'other';
}

// ---------------------------------------------------------------------------
// Rolling health window (KV)
// ---------------------------------------------------------------------------

export interface ProviderHealthEvent {
  /** Epoch ms. */
  t: number;
  ok: boolean;
  cls?: ProviderErrorClass;
}

export interface ProviderHealthWindow {
  events: ProviderHealthEvent[];
}

export interface ProviderHealthSummary {
  attempts: number;
  failures: number;
  failureRate: number;
  /** Trailing run of consecutive billing/auth failures (any success resets). */
  consecutiveBreakerFailures: number;
  byClass: Partial<Record<ProviderErrorClass, number>>;
}

export interface ProviderHealthThresholds {
  windowMs: number;
  consecutiveThreshold: number;
  failureRateThreshold: number;
  minSamples: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: ProviderHealthThresholds = {
  windowMs: 15 * 60 * 1000,
  consecutiveThreshold: 5,
  failureRateThreshold: 0.8,
  minSamples: 5,
};

const MAX_WINDOW_EVENTS = 60;

export function healthWindowKey(candidate: { provider: string; model: string }): string {
  return `provider_health:${candidate.provider}:${candidate.model}`;
}

export function modelBanKey(candidate: { provider: string; model: string }): string {
  return `provider_ban:${candidate.provider}:${candidate.model}`;
}

/** Prune to the rolling window and cap event count (oldest dropped first). */
export function pruneHealthWindow(
  window: ProviderHealthWindow,
  now: number,
  windowMs: number,
): ProviderHealthWindow {
  const cutoff = now - windowMs;
  const events = window.events.filter((e) => Number.isFinite(e.t) && e.t >= cutoff);
  return { events: events.slice(-MAX_WINDOW_EVENTS) };
}

/** Pure summary of a (pruned) health window. */
export function summarizeHealthWindow(window: ProviderHealthWindow): ProviderHealthSummary {
  const byClass: Partial<Record<ProviderErrorClass, number>> = {};
  let failures = 0;
  for (const event of window.events) {
    if (event.ok) continue;
    failures += 1;
    const cls = event.cls ?? 'other';
    byClass[cls] = (byClass[cls] ?? 0) + 1;
  }
  let consecutiveBreakerFailures = 0;
  for (let i = window.events.length - 1; i >= 0; i--) {
    const event = window.events[i];
    if (event.ok || !BREAKER_ERROR_CLASSES.includes(event.cls ?? 'other')) break;
    consecutiveBreakerFailures += 1;
  }
  const attempts = window.events.length;
  return {
    attempts,
    failures,
    failureRate: attempts ? failures / attempts : 0,
    consecutiveBreakerFailures,
    byClass,
  };
}

/**
 * Pure trip decision: billing/auth failures only (a dead key/account), on
 * either the consecutive-failure rule or the windowed failure-rate rule.
 * Quota/parse/timeout never trip THIS breaker — quota stays with the
 * existing per-provider rate-limit ban, and parse/timeout are usually
 * document- or transport-specific.
 */
export function shouldTripModelBreaker(
  summary: ProviderHealthSummary,
  thresholds: ProviderHealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): boolean {
  if (summary.consecutiveBreakerFailures >= thresholds.consecutiveThreshold) return true;
  const breakerFailures = BREAKER_ERROR_CLASSES
    .reduce((sum, cls) => sum + (summary.byClass[cls] ?? 0), 0);
  return summary.attempts >= thresholds.minSamples
    && summary.attempts > 0
    && breakerFailures / summary.attempts >= thresholds.failureRateThreshold;
}

export interface ProviderHealthKnobs extends ProviderHealthThresholds {
  overlayEnabled: boolean;
  costRatioLimit: number;
  modelBanTtlSeconds: number;
}

interface ProviderHealthSecretEnv {
  PROVIDER_HEALTH_WINDOW_MINUTES?: string;
  PROVIDER_HEALTH_CONSECUTIVE_THRESHOLD?: string;
  PROVIDER_HEALTH_FAILURE_RATE?: string;
  PROVIDER_HEALTH_MIN_SAMPLES?: string;
  PROVIDER_OVERLAY_ENABLED?: string;
  PROVIDER_OVERLAY_COST_RATIO_LIMIT?: string;
  PROVIDER_MODEL_BAN_TTL_SECONDS?: string;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve the live-tunable health/overlay knobs (Infisical-first, env fallback). */
export async function resolveProviderHealthKnobs(env: Env): Promise<ProviderHealthKnobs> {
  let secrets: ProviderHealthSecretEnv = {};
  try {
    secrets = (await resolveSecrets(env, [
      'PROVIDER_HEALTH_WINDOW_MINUTES',
      'PROVIDER_HEALTH_CONSECUTIVE_THRESHOLD',
      'PROVIDER_HEALTH_FAILURE_RATE',
      'PROVIDER_HEALTH_MIN_SAMPLES',
      'PROVIDER_OVERLAY_ENABLED',
      'PROVIDER_OVERLAY_COST_RATIO_LIMIT',
      'PROVIDER_MODEL_BAN_TTL_SECONDS',
    ])) as ProviderHealthSecretEnv;
  } catch {
    // Resolver outage: fall back to defaults rather than blocking extraction.
  }
  return {
    windowMs: positiveNumber(secrets.PROVIDER_HEALTH_WINDOW_MINUTES, 15) * 60 * 1000,
    consecutiveThreshold: Math.round(positiveNumber(secrets.PROVIDER_HEALTH_CONSECUTIVE_THRESHOLD, 5)),
    failureRateThreshold: Math.min(positiveNumber(secrets.PROVIDER_HEALTH_FAILURE_RATE, 0.8), 1),
    minSamples: Math.round(positiveNumber(secrets.PROVIDER_HEALTH_MIN_SAMPLES, 5)),
    overlayEnabled: secrets.PROVIDER_OVERLAY_ENABLED !== 'false',
    costRatioLimit: positiveNumber(secrets.PROVIDER_OVERLAY_COST_RATIO_LIMIT, 3),
    modelBanTtlSeconds: Math.round(positiveNumber(secrets.PROVIDER_MODEL_BAN_TTL_SECONDS, 3600)),
  };
}

export interface RecordProviderHealthResult {
  summary: ProviderHealthSummary;
  errorClass: ProviderErrorClass | null;
  /** True when THIS observation opened the per-model breaker. */
  tripped: boolean;
}

/**
 * Record one concrete provider:model read into the rolling window and trip
 * the per-model breaker when the billing/auth thresholds are crossed.
 * Best-effort: a down KV must never fail or slow the read that produced the
 * observation, so every KV interaction is trapped.
 */
export async function recordProviderHealth(
  env: Env,
  candidate: { provider: string; model: string },
  ok: boolean,
  error?: string | null,
  knobs?: ProviderHealthKnobs,
  now = Date.now(),
): Promise<RecordProviderHealthResult | null> {
  if (!env.CONFIG_KV) return null;
  const resolved = knobs ?? await resolveProviderHealthKnobs(env);
  const errorClass = ok ? null : classifyProviderErrorClass(error) ?? 'other';
  try {
    const key = healthWindowKey(candidate);
    let window: ProviderHealthWindow = { events: [] };
    try {
      const raw = await env.CONFIG_KV.get(key);
      if (raw) {
        const parsed = JSON.parse(raw) as ProviderHealthWindow;
        if (Array.isArray(parsed?.events)) window = parsed;
      }
    } catch {
      // Unreadable window: start fresh.
    }
    window.events.push({ t: now, ok, ...(errorClass ? { cls: errorClass } : {}) });
    window = pruneHealthWindow(window, now, resolved.windowMs);
    const summary = summarizeHealthWindow(window);
    await env.CONFIG_KV.put(key, JSON.stringify(window), {
      expirationTtl: Math.max(Math.ceil((resolved.windowMs / 1000) * 2), 120),
    });

    let tripped = false;
    if (!ok && errorClass && BREAKER_ERROR_CLASSES.includes(errorClass)
      && shouldTripModelBreaker(summary, resolved)) {
      const banKey = modelBanKey(candidate);
      const existing = await env.CONFIG_KV.get(banKey).catch(() => null);
      if (!existing) {
        await env.CONFIG_KV.put(
          banKey,
          String(now + resolved.modelBanTtlSeconds * 1000),
          { expirationTtl: resolved.modelBanTtlSeconds },
        );
        tripped = true;
        console.warn(
          `provider health: circuit breaker OPENED for ${label(candidate)} `
          + `(${errorClass}; ${summary.consecutiveBreakerFailures} consecutive, `
          + `${Math.round(summary.failureRate * 100)}% failure over window)`,
        );
      }
    }
    return { summary, errorClass, tripped };
  } catch (err) {
    console.warn('provider health: record failed:', label(candidate), (err as Error).message);
    return null;
  }
}

/** Seconds until the per-model breaker closes, or null when it is not open. */
export async function providerModelBanRetryAfter(
  env: Env,
  candidate: { provider: string; model: string },
): Promise<number | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(modelBanKey(candidate));
    if (!raw) return null;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= Date.now()) return null;
    return Math.max(1, Math.ceil((until - Date.now()) / 1000));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime overlay substitution
// ---------------------------------------------------------------------------

export interface OverlaySubstitute {
  candidate: BakeoffCandidate;
  nominalCostUsd: number;
  configuredCostUsd: number | null;
  costRatio: number | null;
  /** True when the substitute exceeds the cost-ratio guard (still surfaced, never silent). */
  flagged: boolean;
}

export interface OverlaySelectionDeps {
  /** Injectable for tests; defaults to bakeoff.keyFor (Infisical-backed). */
  keyChecker?: (env: Env, provider: Provider) => Promise<string | null>;
  /** Injectable for tests; defaults to the KV provider/model ban checks. */
  banChecker?: (env: Env, candidate: BakeoffCandidate) => Promise<boolean>;
  catalog?: BakeoffCandidate[];
}

async function defaultBanChecker(env: Env, candidate: BakeoffCandidate): Promise<boolean> {
  if (!env.CONFIG_KV) return false;
  const providerBan = await env.CONFIG_KV.get(`provider_ban:${candidate.provider}`).catch(() => null);
  if (providerBan && Number(providerBan) > Date.now()) return true;
  return (await providerModelBanRetryAfter(env, candidate)) !== null;
}

/**
 * Pick the cheapest healthy substitute from the offered benchmark catalog
 * (DEFAULT_CANDIDATES) for a blocked slot. Returns null when no eligible
 * candidate exists (the slot is then simply skipped, exactly as before).
 *
 * Eligibility: not openrouter/auto, not retired, not in `excludeLabels`
 * (the other configured slots), not sharing an underlying vendor in
 * `excludeUnderlyingProviders` (preserves cross-vendor distinctness with the
 * other live slot), credentials configured, no open provider/model breaker,
 * and a computable rate-card nominal cost (unpriceable models cannot be
 * cost-ranked, so they are never auto-selected).
 */
export async function selectOverlaySubstitute(
  env: Env,
  configured: BakeoffCandidate,
  opts: {
    excludeLabels?: string[];
    excludeUnderlyingProviders?: string[];
    pageCount?: number | null;
    costRatioLimit?: number;
    deps?: OverlaySelectionDeps;
  } = {},
): Promise<OverlaySubstitute | null> {
  const keyChecker = opts.deps?.keyChecker ?? keyFor;
  const banChecker = opts.deps?.banChecker ?? defaultBanChecker;
  const catalog = opts.deps?.catalog ?? DEFAULT_CANDIDATES;
  const excludeLabels = new Set((opts.excludeLabels ?? []).map((v) => v.toLowerCase()));
  const excludeUnderlying = new Set(
    (opts.excludeUnderlyingProviders ?? []).map((v) => v.toLowerCase()),
  );
  const ratioLimit = opts.costRatioLimit ?? 3;
  const configuredCostUsd = estimateNominalReadCostUsd(
    configured.provider,
    configured.model,
    { pageCount: opts.pageCount },
  );

  const priced: Array<{ candidate: BakeoffCandidate; nominalCostUsd: number }> = [];
  for (const candidate of catalog) {
    if (isOpenRouterAuto(candidate) || isRetiredDisclosureCandidate(candidate)) continue;
    if (excludeLabels.has(label(candidate).toLowerCase())) continue;
    if (excludeUnderlying.has(getUnderlyingProvider(candidate).toLowerCase())) continue;
    const nominalCostUsd = estimateNominalReadCostUsd(
      candidate.provider,
      candidate.model,
      { pageCount: opts.pageCount },
    );
    if (nominalCostUsd == null) continue;
    priced.push({ candidate, nominalCostUsd });
  }
  priced.sort((a, b) => a.nominalCostUsd - b.nominalCostUsd
    || label(a.candidate).localeCompare(label(b.candidate)));

  const keyByProvider = new Map<Provider, string | null>();
  for (const entry of priced) {
    const provider = entry.candidate.provider;
    if (!keyByProvider.has(provider)) {
      keyByProvider.set(provider, await keyChecker(env, provider).catch(() => null));
    }
    if (!keyByProvider.get(provider)) continue;
    if (await banChecker(env, entry.candidate)) continue;
    const costRatio = configuredCostUsd != null && configuredCostUsd > 0
      ? entry.nominalCostUsd / configuredCostUsd
      : null;
    return {
      candidate: entry.candidate,
      nominalCostUsd: entry.nominalCostUsd,
      configuredCostUsd,
      costRatio,
      // Never select a model >ratioLimit x the configured slot's rate-card
      // cost silently: an unknown configured cost is also flagged.
      flagged: costRatio == null || costRatio > ratioLimit,
    };
  }
  return null;
}

/** Diagnostics snapshot: active breakers + per-model health windows from KV. */
export async function providerHealthDiagnostics(env: Env): Promise<{
  breakers: Array<{ key: string; scope: 'provider' | 'model'; untilIso: string | null }>;
  models: Array<{ provider: string; model: string; summary: ProviderHealthSummary }>;
} | null> {
  const kv = env.CONFIG_KV as KVNamespace | undefined;
  if (!kv || typeof kv.list !== 'function') return null;
  try {
    const breakers: Array<{ key: string; scope: 'provider' | 'model'; untilIso: string | null }> = [];
    const bans = await kv.list({ prefix: 'provider_ban:', limit: 100 });
    for (const entry of bans.keys) {
      const raw = await kv.get(entry.name).catch(() => null);
      const until = Number(raw);
      const remainder = entry.name.slice('provider_ban:'.length);
      breakers.push({
        key: remainder,
        scope: remainder.includes(':') ? 'model' : 'provider',
        untilIso: Number.isFinite(until) && until > 0 ? new Date(until).toISOString() : null,
      });
    }
    const models: Array<{ provider: string; model: string; summary: ProviderHealthSummary }> = [];
    const windows = await kv.list({ prefix: 'provider_health:', limit: 100 });
    for (const entry of windows.keys) {
      const raw = await kv.get(entry.name).catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as ProviderHealthWindow;
        if (!Array.isArray(parsed?.events)) continue;
        const remainder = entry.name.slice('provider_health:'.length);
        const sep = remainder.indexOf(':');
        if (sep <= 0) continue;
        models.push({
          provider: remainder.slice(0, sep),
          model: remainder.slice(sep + 1),
          summary: summarizeHealthWindow(parsed),
        });
      } catch {
        // Skip malformed windows.
      }
    }
    return { breakers, models };
  } catch (err) {
    console.warn('provider health diagnostics failed:', (err as Error).message);
    return null;
  }
}
