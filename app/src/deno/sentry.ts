/**
 * Production `#sentry` binding.
 *
 * This is the real Deno SDK adapter (`@sentry/deno`), not the retired dummy
 * passthrough.  `initProductionSentry` is the boot path used by `main.ts`
 * after Infisical refresh.  Capture/monitor helpers no-op until a DSN is
 * present and `init` succeeds.
 */

import * as DenoSentry from '@sentry/deno';
import {
  createSentryBindings,
  type ProductionSentryBindings,
  type SentryInitInput,
  type SentryInitResult,
  type SentrySdkLike,
} from '../shared/sentryRuntime.ts';

const sdk = DenoSentry as unknown as SentrySdkLike;
const bindings: ProductionSentryBindings = createSentryBindings(sdk);

export const withSentry = bindings.withSentry;
export const withMonitor = bindings.withMonitor;
export const captureException = bindings.captureException;
export const captureMessage = bindings.captureMessage;
export const setTags = bindings.setTags;
export const consoleLoggingIntegration = bindings.consoleLoggingIntegration;
export const isSentryInitialized = bindings.isInitialized;

export function initProductionSentry(
  env: SentryInitInput,
  tracesSampleRate?: number,
): SentryInitResult {
  return bindings.initProductionSentry(env, tracesSampleRate);
}
