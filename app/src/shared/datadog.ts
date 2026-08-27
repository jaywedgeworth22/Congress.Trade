/**
 * Process-wide Datadog bindings.  Init is fail-closed: missing or partial
 * keys leave logs/APM/RUM disabled and the app still boots.
 */

import type { MiddlewareHandler } from 'hono';
import {
  resolveDatadogBackend,
  resolveDatadogRum,
  type DatadogBackendConfig,
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

interface DdSpan {
  setTag: (key: string, value: unknown) => void;
  finish: () => void;
}

interface DdTracer {
  init: (options: Record<string, unknown>) => void;
  startSpan: (name: string, options?: Record<string, unknown>) => DdSpan;
  currentSpan?: () => DdSpan | null;
}

let transport: DatadogTransport = noopTransport;
let initializedInput: DatadogInitInput | undefined;
let activeTracer: DdTracer | null = null;
let consoleHooked = false;
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

export async function tryInitDdTracer(backend: DatadogBackendConfig): Promise<void> {
  try {
    if (activeTracer) return;
    if (typeof (globalThis as any).Deno !== 'undefined') {
      const denoEnv = (globalThis as any).Deno.env;
      if (backend.service && !denoEnv.get('DD_SERVICE')) denoEnv.set('DD_SERVICE', backend.service);
      if (backend.env && !denoEnv.get('DD_ENV')) denoEnv.set('DD_ENV', backend.env);
      if (backend.site && !denoEnv.get('DD_SITE')) denoEnv.set('DD_SITE', backend.site);
      if (backend.version && !denoEnv.get('DD_VERSION')) denoEnv.set('DD_VERSION', backend.version);
      if (backend.apiKey && !backend.agentHost && !denoEnv.get('DD_TRACE_EXPERIMENTAL_EXPORTER')) {
        denoEnv.set('DD_TRACE_EXPERIMENTAL_EXPORTER', 'agentless');
      }
      if (backend.apiKey && !denoEnv.get('DD_API_KEY')) denoEnv.set('DD_API_KEY', backend.apiKey);
      if (backend.agentHost && !denoEnv.get('DD_AGENT_HOST')) denoEnv.set('DD_AGENT_HOST', backend.agentHost);
    }
    const imported = await import(/* webpackIgnore: true */ 'npm:dd-trace').catch(() => null);
    const tracer = (imported?.default ?? imported) as DdTracer | null;
    if (tracer && typeof tracer.init === 'function') {
      tracer.init({
        service: backend.service,
        env: backend.env,
        version: backend.version,
        site: backend.site,
        sampleRate: backend.sampleRate,
        hostname: backend.agentHost,
        logInjection: true,
        runtimeMetrics: true,
        profiling: false,
        appsec: false,
        startupLogs: false,
      });
      activeTracer = tracer;
    }
  } catch (err) {
    console.warn('[datadog] dd-trace init no-op:', err instanceof Error ? err.message : err);
  }
}

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
  activeTracer = null;
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
    if (transport.enabled) {
      hookConsole();
      void tryInitDdTracer(backend as DatadogBackendConfig);
    }
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

export function getActiveDdTracer(): DdTracer | null {
  return activeTracer;
}

export function startDatadogSpan(
  name: string,
  options: {
    resource?: string;
    service?: string;
    tags?: Record<string, string | number | boolean>;
  } = {},
): { finish: (error?: boolean) => void; setTag: (key: string, value: unknown) => void } {
  const started = Date.now();
  let ddSpan: DdSpan | undefined;
  try {
    if (activeTracer && typeof activeTracer.startSpan === 'function') {
      ddSpan = activeTracer.startSpan(name, {
        service: options.service,
        tags: {
          resource: options.resource,
          ...(options.tags ?? {}),
        },
      });
    }
  } catch {}

  return {
    setTag: (key: string, value: unknown) => {
      try {
        if (ddSpan) ddSpan.setTag(key, value);
      } catch {}
    },
    finish: (error = false) => {
      try {
        if (ddSpan) {
          if (error) ddSpan.setTag('error', 1);
          ddSpan.finish();
        }
      } catch {}
      if (transport.enabled) {
        transport.span({
          name,
          resource: options.resource ?? name,
          startMs: started,
          durationMs: Math.max(0, Date.now() - started),
          error,
          meta: Object.fromEntries(
            Object.entries(options.tags ?? {}).map(([k, v]) => [k, String(v)]),
          ),
        });
      }
    },
  };
}

export async function traceDatadogOperation<T>(
  name: string,
  resource: string,
  fn: () => Promise<T>,
  tags?: Record<string, string | number | boolean>,
): Promise<T> {
  const span = startDatadogSpan(name, { resource, tags });
  try {
    const result = await fn();
    span.finish(false);
    return result;
  } catch (err) {
    span.setTag('error.message', err instanceof Error ? err.message : String(err));
    span.finish(true);
    throw err;
  }
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
    let ddSpan: DdSpan | undefined;
    const path = requestPath(c.req.url);
    const method = c.req.method;
    const resource = `${method} ${path}`;

    if (activeTracer && typeof activeTracer.startSpan === 'function') {
      try {
        ddSpan = activeTracer.startSpan('web.request', {
          tags: {
            'http.method': method,
            'http.url': path,
            'resource.name': resource,
          },
        });
      } catch {}
    }

    try {
      await next();
    } catch (err) {
      if (ddSpan) {
        ddSpan.setTag('error', 1);
        ddSpan.setTag('error.message', err instanceof Error ? err.message : String(err));
      }
      throw err;
    } finally {
      const status = c.res?.status ?? 500;
      const error = status >= 400;
      if (ddSpan) {
        try {
          ddSpan.setTag('http.status_code', status);
          if (error) ddSpan.setTag('error', 1);
          ddSpan.finish();
        } catch {}
      }
      if (!transport.enabled) return;
      if (skipQuietHealth(path, status)) return;
      transport.span({
        name: 'web.request',
        resource,
        startMs: started,
        durationMs: Math.max(0, Date.now() - started),
        error,
        meta: {
          'http.method': method,
          'http.status_code': String(status),
          'http.url': path,
        },
      });
      if (error) {
        transport.log({
          status: status >= 500 ? 'error' : 'warn',
          message: `${method} ${path} ${status}`,
          attributes: { status, path },
        });
      }
    }
  };
}
