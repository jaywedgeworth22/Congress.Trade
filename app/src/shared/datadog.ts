/**
 * Process-wide Datadog bindings.  Init is fail-closed: missing or partial
 * keys leave logs/APM/RUM disabled and the app still boots.
 */

import type { MiddlewareHandler } from 'hono';
import {
  resolveDatadogBackend,
  resolveDatadogRum,
  type DatadogBackendReason,
  type DatadogInitInput,
  type DatadogRumReason,
} from './datadogRuntime.ts';
import { createDatadogTransport, type DatadogTransport } from './datadogTransport.ts';
import type { Env } from './types.ts';

export interface DatadogInitResult {
  logs: boolean;
  apm: boolean;
  rum: boolean;
  backendReason: DatadogBackendReason;
  rumReason: DatadogRumReason;
}

const noopTransport: DatadogTransport = {
  enabled: false,
  log: () => undefined,
  span: () => undefined,
  flush: async () => undefined,
};

let transport: DatadogTransport = noopTransport;
let initializedInput: DatadogInitInput | undefined;
let consoleHooked = false;
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

function hookConsole(): void {
  if (consoleHooked) return;
  consoleHooked = true;
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    if (!transport.enabled) return;
    transport.log({ status: 'warn', message: formatConsoleArgs(args) });
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    if (!transport.enabled) return;
    transport.log({ status: 'error', message: formatConsoleArgs(args) });
  };
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return '[unserializable]';
    }
  }).join(' ').slice(0, 2_000);
}

export function resetDatadogForTests(): void {
  transport = noopTransport;
  initializedInput = undefined;
  if (consoleHooked) {
    console.warn = originalWarn;
    console.error = originalError;
    consoleHooked = false;
  }
}

export function initProductionDatadog(
  input: DatadogInitInput,
  fetchImpl: typeof fetch = fetch,
): DatadogInitResult {
  initializedInput = input;
  const backend = resolveDatadogBackend(input);
  const rum = resolveDatadogRum(input);
  try {
    transport = createDatadogTransport(backend, fetchImpl);
    if (transport.enabled) hookConsole();
    return {
      logs: backend.enabled,
      apm: backend.enabled,
      rum: rum.enabled,
      backendReason: backend.reason,
      rumReason: rum.reason,
    };
  } catch {
    transport = noopTransport;
    return {
      logs: false,
      apm: false,
      rum: rum.enabled,
      backendReason: 'init-failed',
      rumReason: rum.reason,
    };
  }
}

export function getDatadogTransport(): DatadogTransport {
  return transport;
}

export function getDatadogInitInput(): DatadogInitInput | undefined {
  return initializedInput;
}

export function datadogLog(status: 'warn' | 'error', message: string): void {
  transport.log({ status, message });
}

export function datadogCaptureException(err: unknown, attributes?: Record<string, string>): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  transport.log({
    status: 'error',
    message,
    attributes: attributes as Record<string, string | number | boolean> | undefined,
  });
}

function requestPath(url: string): string {
  try {
    return new URL(url, 'http://congress.trade').pathname || '/';
  } catch {
    return '/';
  }
}

function skipQuietHealth(path: string, status: number): boolean {
  return status < 400 && (path === '/health' || path === '/api/health');
}

export function datadogRequestMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const started = Date.now();
    try {
      await next();
    } finally {
      if (!transport.enabled) return;
      const path = requestPath(c.req.url);
      const status = c.res?.status ?? 500;
      if (skipQuietHealth(path, status)) return;
      const error = status >= 400;
      transport.span({
        name: 'web.request',
        resource: `${c.req.method} ${path}`,
        startMs: started,
        durationMs: Math.max(0, Date.now() - started),
        error,
        meta: {
          'http.method': c.req.method,
          'http.status_code': String(status),
          'http.url': path,
        },
      });
      if (error) {
        transport.log({
          status: status >= 500 ? 'error' : 'warn',
          message: `${c.req.method} ${path} ${status}`,
          attributes: { status, path },
        });
      }
    }
  };
}
