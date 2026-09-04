/**
 * Public-web Sentry browser loader for Congress.Trade.
 *
 * The ingest DSN is public-by-design (same as NEXT_PUBLIC_ / VITE_ client
 * DSNs).  Never interpolates SENTRY_AUTH_TOKEN.  Designer 2026-09-04 update:
 * web session Replay defaults to 10%.  Error Replay is 100% masked.
 * Feedback is on unless SENTRY_FEEDBACK_ENABLED is an explicit falsy.
 *
 * Kill switches: SENTRY_BROWSER_ENABLED=false, SENTRY_FEEDBACK_ENABLED=false,
 * sample-rate env vars.  Unset SENTRY_DSN → empty string (CSP stays tight).
 */

export const SENTRY_BROWSER_SCRIPT_ORIGIN = 'https://browser.sentry-cdn.com';
export const SENTRY_BROWSER_BUNDLE =
  'https://browser.sentry-cdn.com/10.70.0/bundle.tracing.replay.feedback.min.js';

export type SentryBrowserInput = {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_BROWSER_ENABLED?: string;
  SENTRY_FEEDBACK_ENABLED?: string;
  SENTRY_REPLAY_SESSION_SAMPLE_RATE?: string;
  SENTRY_REPLAY_ERROR_SAMPLE_RATE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
};

export type SentryBrowserResolution =
  | { enabled: false }
  | {
    enabled: true;
    dsn: string;
    environment: string;
    scriptSrc: string;
    connectOrigin: string;
    tracesSampleRate: number;
    replaysSessionSampleRate: number;
    replaysOnErrorSampleRate: number;
    feedbackEnabled: boolean;
  };

function jsonLiteral(value: string): string {
  return JSON.stringify(value);
}

function envFalsy(raw: string | undefined): boolean {
  return raw ? /^(false|0|off|no)$/i.test(raw.trim()) : false;
}

function clampRate(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 1);
}

/** Ingest origin from a DSN.  No wildcards — CSP tests forbid `*`. */
export function sentryIngestOrigin(dsn: string): string | undefined {
  try {
    const url = new URL(dsn);
    if (!url.host) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

export function resolveSentryBrowser(env: SentryBrowserInput): SentryBrowserResolution {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return { enabled: false };
  if (envFalsy(env.SENTRY_BROWSER_ENABLED)) return { enabled: false };
  const connectOrigin = sentryIngestOrigin(dsn);
  if (!connectOrigin) return { enabled: false };
  return {
    enabled: true,
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
    scriptSrc: SENTRY_BROWSER_BUNDLE,
    connectOrigin,
    tracesSampleRate: clampRate(env.SENTRY_TRACES_SAMPLE_RATE, 0.2),
    replaysSessionSampleRate: clampRate(env.SENTRY_REPLAY_SESSION_SAMPLE_RATE, 0.1),
    replaysOnErrorSampleRate: clampRate(env.SENTRY_REPLAY_ERROR_SAMPLE_RATE, 1),
    feedbackEnabled: !envFalsy(env.SENTRY_FEEDBACK_ENABLED),
  };
}

export function renderSentryBrowserScript(env: SentryBrowserInput): string {
  const resolved = resolveSentryBrowser(env);
  if (!resolved.enabled) return '';
  const init: Record<string, unknown> = {
    dsn: resolved.dsn,
    environment: resolved.environment,
    sendDefaultPii: false,
    tracesSampleRate: resolved.tracesSampleRate,
    replaysSessionSampleRate: resolved.replaysSessionSampleRate,
    replaysOnErrorSampleRate: resolved.replaysOnErrorSampleRate,
  };
  const integrations: string[] = [
    'Sentry.browserTracingIntegration()',
    'Sentry.replayIntegration({maskAllText:true,blockAllMedia:true})',
  ];
  if (resolved.feedbackEnabled) {
    integrations.push(
      "Sentry.feedbackIntegration({colorScheme:'light',autoInject:true,showBranding:false,buttonLabel:'Report a problem',submitButtonLabel:'Send',formTitle:'Report a problem'})",
    );
  }
  return [
    '<script>',
    '(function(){',
    'var n=document.createElement("script");',
    'n.async=1;n.crossOrigin="anonymous";',
    'n.src=' + jsonLiteral(resolved.scriptSrc) + ';',
    'n.onload=function(){',
    'if(!window.Sentry)return;',
    'window.Sentry.init(Object.assign(' + JSON.stringify(init) + ',{integrations:[' +
      integrations.join(',') +
      ']}));',
    '};',
    'document.head.appendChild(n);',
    '})();',
    '</script>',
  ].join('');
}
