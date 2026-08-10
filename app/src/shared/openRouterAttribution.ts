/**
 * OpenRouter app attribution + usage-compliance classifier helpers.
 *
 * Two layers, deliberately kept together:
 * 1. **App attribution headers** — so OpenRouter Activity / Apps analytics
 *    (`openrouter.ai/apps?url=https://congress.trade`) and public rankings
 *    group this fleet under one app page. Docs:
 *    https://openrouter.ai/docs/app-attribution
 * 2. **Request classifier enrichment** — `user` + flat `trace.{sourceApp,…}`
 *    so Broadcast/Activity filters and Usage-Monitor pushed events can slice
 *    by app, service, feature, keyRef. Shared contract:
 *    `buildCallClassifier` / `openrouterRequestEnrichment` in
 *    congress-trading-shared (DESIGN-usage-compliance-classifier.md).
 *
 * Every OpenRouter call site in this repo must use these helpers — do not
 * hand-roll headers or scatter `sourceApp: 'congress-trade'` literals.
 */

import {
  openrouterRequestEnrichment,
  type OpenRouterRequestEnrichment,
} from '@jaywedgeworth22/congress-trading-shared';
import type { Env } from './types.ts';
import { environmentName } from './thirdPartyTelemetry.ts';

/** Canonical producer / OpenRouter app identity for Congress.Trade. */
export const OPENROUTER_SOURCE_APP = 'congress-trade' as const;

/** Primary domain for OpenRouter app rankings (HTTP-Referer). */
export const OPENROUTER_APP_REFERER = 'https://congress.trade';

/** Display name on OpenRouter Activity / Apps (X-OpenRouter-Title + X-Title). */
export const OPENROUTER_APP_TITLE = 'Congress.Trade';

/**
 * Default Infisical/env secret name for the primary OpenRouter inference key.
 * Used as `keyRef` / `producerKeyRef` for Usage-Monitor key attribution.
 */
export const OPENROUTER_PRIMARY_KEY_REF = 'OPENROUTER_API_KEY';

export type OpenRouterClassifierOpts = {
  /** Logical service (extractor / subsystem name). */
  service: string;
  /** Finer call-site tag, e.g. vision-extract-house / doc-class / senate-paper. */
  feature?: string;
  /** Secret name alias (never the raw key). Defaults to OPENROUTER_API_KEY. */
  keyRef?: string;
  /**
   * Deterministic per-doc/job id → OpenRouter top-level `user` (max 128).
   * Blank/undefined is omitted (never sent as "").
   */
  user?: string | null;
  /**
   * Run/session id → OpenRouter `session_id`. Blank/undefined is omitted.
   */
  sessionId?: string | null;
};

/**
 * HTTP headers that create/maintain the OpenRouter app page for Congress.Trade.
 * Always include both X-OpenRouter-Title (current) and X-Title (back-compat).
 */
export function openRouterAttributionHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': OPENROUTER_APP_REFERER,
    'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
    // Back-compat: older OpenRouter analytics still honor X-Title.
    'X-Title': OPENROUTER_APP_TITLE,
  };
}

/**
 * Build request-body enrichment for an OpenRouter completions call.
 * Best-effort: returns undefined on any builder failure so a misconfigured
 * static field never blocks a paid extraction.
 */
export function buildOpenRouterClassifier(
  env: Env,
  opts: OpenRouterClassifierOpts,
): OpenRouterRequestEnrichment | undefined {
  try {
    return openrouterRequestEnrichment({
      sourceApp: OPENROUTER_SOURCE_APP,
      environment: environmentName(env),
      service: opts.service,
      feature: opts.feature || undefined,
      keyRef: opts.keyRef || OPENROUTER_PRIMARY_KEY_REF,
      gitSha: env.CF_VERSION_METADATA?.id || env.CF_VERSION_METADATA?.tag || undefined,
      user: opts.user || undefined,
      sessionId: opts.sessionId || undefined,
    });
  } catch (err) {
    console.warn(
      'openRouterAttribution: classifier enrichment failed; sending request without it:',
      (err as Error).message,
    );
    return undefined;
  }
}

/**
 * Flat metadata map for Usage-Monitor pushed events — mirrors classifier keys
 * so dashboard filters can group by app/service/feature without parsing OR
 * Activity alone.
 */
export function openRouterTelemetryMetadata(
  env: Env,
  opts: OpenRouterClassifierOpts,
): Record<string, string> {
  const enrichment = buildOpenRouterClassifier(env, opts);
  const meta: Record<string, string> = {
    sourceApp: OPENROUTER_SOURCE_APP,
    keyRef: opts.keyRef || OPENROUTER_PRIMARY_KEY_REF,
  };
  if (enrichment?.trace.environment) meta.environment = enrichment.trace.environment;
  if (enrichment?.trace.service) meta.service = enrichment.trace.service;
  if (enrichment?.trace.feature) meta.feature = enrichment.trace.feature;
  if (enrichment?.trace.gitSha) meta.gitSha = enrichment.trace.gitSha;
  if (opts.user) meta.user = String(opts.user).slice(0, 128);
  if (opts.sessionId) meta.sessionId = String(opts.sessionId).slice(0, 128);
  return meta;
}
