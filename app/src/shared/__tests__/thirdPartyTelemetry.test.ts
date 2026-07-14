import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { UsageTelemetryEventSchema } from '@jaywedgeworth22/congress-trading-shared';
import type { Env, QueueMessage, ThirdPartyUsageTelemetryEvent } from '../types';
import {
  deliverUsageTelemetryEvent,
  enqueueUsageTelemetryEvent,
  flushUsageTelemetryFallback,
  providerForThirdPartyRequest,
  recordMeasuredThirdPartyUsage,
  stableMeasuredUsageIdempotencyKey,
  trackedFetch,
  type MeasuredThirdPartyUsage,
  withThirdPartyTelemetry,
  withoutThirdPartyTelemetry,
} from '../thirdPartyTelemetry';

const testModuleUrl = (import.meta as ImportMeta & { readonly url: string }).url;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const deliveryEvent: ThirdPartyUsageTelemetryEvent = {
  idempotencyKey: 'ct-third-party:delivery-test',
  sourceApp: 'congress-trade',
  environment: 'test',
  provider: 'openai',
  service: 'llm',
  project: 'congress-trade',
  label: 'extract-document',
  keyRef: 'ct-third-party:delivery-test',
  billingMode: 'actual',
  metricType: 'usage',
  quantity: 1,
  unit: 'request',
  requests: 1,
  confidence: 'actual',
  occurredAt: '2026-07-13T12:00:00.000Z',
};

function fakeEnv(messages: QueueMessage[]): Env {
  return {
    USAGE_MONITOR_ENVIRONMENT: 'test',
    INGEST_QUEUE: {
      send: vi.fn(async (message: QueueMessage) => {
        messages.push(message);
      }),
    },
  } as unknown as Env;
}

function fallbackBucket(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const put = vi.fn(async (key: string, value: unknown) => {
    if (typeof value !== 'string') throw new Error('test bucket expects string values');
    objects.set(key, value);
  });
  const remove = vi.fn(async (key: string | string[]) => {
    for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
  });
  const bucket = {
    put,
    delete: remove,
    async get(key: string) {
      const value = objects.get(key);
      return value == null ? null : { text: async () => value };
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const filtered = [...objects.keys()]
        .filter((key) => !options?.prefix || key.startsWith(options.prefix));
      const keys = filtered.slice(0, options?.limit ?? filtered.length);
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
  } as unknown as R2Bucket;
  return { bucket, objects, put, remove };
}

describe('third-party usage telemetry', () => {
  it('classifies providers from an exact host allowlist and never emits an arbitrary host', () => {
    expect(providerForThirdPartyRequest('https://api.openai.com/v1/responses')).toBe('openai');
    expect(providerForThirdPartyRequest('https://api.openai.com.evil.example/v1')).toBe('external-api');
    expect(providerForThirdPartyRequest('https://tenant.cloudflareaccess.com/cdn-cgi/access/certs')).toBe('cloudflare-access');
    expect(providerForThirdPartyRequest('https://o123.ingest.us.sentry.io/api/1/envelope/')).toBe('sentry');
    expect(providerForThirdPartyRequest('https://customer.example/hook', 'subscriber-webhook')).toBe('webhook');
  });

  it('meters an SDK transport with an explicit Env without relying on handler context', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    await trackedFetch(
      'https://o123.ingest.sentry.io/api/1/envelope/',
      { method: 'POST' },
      { service: 'observability', operation: 'send-envelope' },
      vi.fn(async () => new Response('', { status: 200 })),
      { envOverride: env, silentQueueFailure: true },
    );
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(message.event).toMatchObject({
      provider: 'sentry',
      service: 'observability',
      label: 'send-envelope',
      quantity: 1,
      unit: 'request',
    });
  });

  it('queues a receiver-compatible, secret-safe event for a successful attempt', async () => {
    const messages: QueueMessage[] = [];
    const inputUrl = 'https://api.openai.com/v1/responses?api_key=never-store-this';
    await withThirdPartyTelemetry(fakeEnv(messages), () =>
      trackedFetch(
        inputUrl,
        { headers: { authorization: 'Bearer never-store-this' }, body: 'secret-body', method: 'POST' },
        { service: 'llm', operation: 'extract-document', model: 'gpt-4o' },
        vi.fn(async () => new Response('{}', { status: 200 })),
      ),
    );

    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.type).toBe('usage.telemetry');
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(() => UsageTelemetryEventSchema.parse(message.event)).not.toThrow();
    expect(message.event).toMatchObject({
      provider: 'openai',
      service: 'llm',
      label: 'extract-document',
      metricType: 'usage',
      quantity: 1,
      unit: 'request',
      requests: 1,
      billingMode: 'actual',
      confidence: 'actual',
      metadata: { model: 'gpt-4o', success: true, status: 200 },
    });
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('never-store-this');
    expect(serialized).not.toContain('secret-body');
    expect(serialized).not.toContain('api.openai.com');
  });

  it('queues failures without leaking provider error messages', async () => {
    const messages: QueueMessage[] = [];
    const error = new TypeError('Bearer secret-token failed at https://private.example/path');
    await expect(
      withThirdPartyTelemetry(fakeEnv(messages), () =>
        trackedFetch(
          'https://api.mistral.ai/v1/ocr',
          undefined,
          { service: 'ocr', operation: 'extract-document', model: 'mistral-ocr-latest' },
          vi.fn(async () => { throw error; }),
        ),
      ),
    ).rejects.toBe(error);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('typeerror');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('private.example');
  });

  it('suppresses telemetry-delivery bootstrap calls to prevent recursive amplification', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    await withThirdPartyTelemetry(env, () =>
      withoutThirdPartyTelemetry(env, () =>
        trackedFetch(
          'https://app.infisical.com/api/v3/secrets/raw',
          undefined,
          { service: 'secret-management', operation: 'read-telemetry-bootstrap', dynamicTarget: 'infisical' },
          vi.fn(async () => new Response('{}', { status: 200 })),
        ),
      ),
    );
    expect(messages).toEqual([]);
  });

  it.each([
    ['service origin', 'https://usage.jays.services'],
    ['legacy full endpoint', 'https://usage.jays.services/api/ingest/usage/'],
  ])('sends to exactly one canonical ingest path from a %s config', async (_label, configuredUrl) => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ ok: true, accepted: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const env = {
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_ENVIRONMENT: 'test',
      USAGE_MONITOR_INGEST_URL: configuredUrl,
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    await deliverUsageTelemetryEvent(env, deliveryEvent);

    expect(requestedUrls).toEqual(['https://usage.jays.services/api/ingest/usage']);
  });

  it('persists the exact idempotent event to the R2 fallback when Queue hand-off fails', async () => {
    const fallback = fallbackBucket();
    const env = {
      INGEST_QUEUE: { send: vi.fn(async () => { throw new Error('queue unavailable'); }) },
      RAW_FILES: fallback.bucket,
    } as unknown as Env;

    const accepted = await enqueueUsageTelemetryEvent(env, deliveryEvent);

    expect(accepted).toBe(true);
    expect(fallback.put).toHaveBeenCalledOnce();
    const [key, value] = fallback.put.mock.calls[0];
    expect(key).toBe('_ops/usage-telemetry/ct-third-party%3Adelivery-test.json');
    expect(JSON.parse(String(value))).toEqual(deliveryEvent);
  });

  it('reports a secret-safe terminal loss when Queue and fallback persistence both fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      INGEST_QUEUE: { send: vi.fn(async () => { throw new Error('queue-secret-value'); }) },
      RAW_FILES: { put: vi.fn(async () => { throw new TypeError('r2-secret-value'); }) },
    } as unknown as Env;

    const accepted = await enqueueUsageTelemetryEvent(env, deliveryEvent);

    expect(accepted).toBe(false);
    const serializedLog = JSON.stringify(error.mock.calls);
    expect(serializedLog).toContain('usage telemetry durability exhausted');
    expect(serializedLog).toContain('TypeError');
    expect(serializedLog).not.toContain('queue-secret-value');
    expect(serializedLog).not.toContain('r2-secret-value');
    error.mockRestore();
  });

  it('retains fallback events until the receiver accepts them, then deletes them', async () => {
    const key = '_ops/usage-telemetry/ct-third-party%3Adelivery-test.json';
    const fallback = fallbackBucket({ [key]: JSON.stringify(deliveryEvent) });
    let receiverAvailable = false;
    vi.stubGlobal('fetch', vi.fn(async () => receiverAvailable
      ? new Response(JSON.stringify({ ok: true, accepted: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ error: 'receiver unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })));
    const env = {
      RAW_FILES: fallback.bucket,
      USAGE_MONITOR_ENABLED: 'true',
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'test-token',
    } as unknown as Env;

    expect(await flushUsageTelemetryFallback(env)).toEqual({ listed: 1, delivered: 0, failed: 1 });
    expect(fallback.objects.has(key)).toBe(true);
    expect(fallback.remove).not.toHaveBeenCalled();

    receiverAvailable = true;
    expect(await flushUsageTelemetryFallback(env)).toEqual({ listed: 1, delivered: 1, failed: 0 });
    expect(fallback.objects.has(key)).toBe(false);
    expect(fallback.remove).toHaveBeenCalledWith(key);
  });

  it('accepts actual measured cost while dropping unapproved metadata fields', async () => {
    const messages: QueueMessage[] = [];
    await recordMeasuredThirdPartyUsage(fakeEnv(messages), {
      provider: 'openai',
      service: 'llm',
      operation: 'benchmark-cost',
      idempotencyKey: 'CT Batch Run 123 Cost',
      occurredAt: '2026-07-13T12:00:00.000Z',
      model: 'gpt-4o',
      metricType: 'cost',
      costUsd: 0.0123,
      billingMode: 'actual',
      confidence: 'actual',
      metadata: {
        costSource: 'usage-priced',
        benchmarkRunId: 'run-123',
        cacheWriteTokens: 31,
        cacheWriteOneHourTokens: 17,
        serviceTier: 'priority',
        toolName: 'attachment_search',
        attachmentSearchCalls: 2,
        costInUsdTicks: 321_000_000,
        requestUrl: 'https://never.example/secret',
      },
    });
    const message = messages[0];
    if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
    expect(message.event.idempotencyKey).toBe('ct-batch-run-123-cost');
    expect(message.event.costUsd).toBe(0.0123);
    expect(message.event.metadata).toMatchObject({
      model: 'gpt-4o',
      costSource: 'usage-priced',
      benchmarkRunId: 'run-123',
      cacheWriteTokens: 31,
      cacheWriteOneHourTokens: 17,
      serviceTier: 'priority',
      toolName: 'attachment_search',
      attachmentSearchCalls: 2,
      costInUsdTicks: 321_000_000,
    });
    expect(JSON.stringify(message)).not.toContain('never.example');
  });

  it('requires a valid occurrence timestamp at runtime for every explicit stable key', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = {
      provider: 'xai',
      service: 'llm',
      operation: 'benchmark-provider-cost',
      idempotencyKey: 'ct-sync-xai-response-123-cost',
      metricType: 'cost',
      quantity: 0,
      unit: 'usd',
      costUsd: 0,
    };

    await expect(recordMeasuredThirdPartyUsage(
      env,
      base as unknown as MeasuredThirdPartyUsage,
    )).resolves.toBe(false);
    await expect(recordMeasuredThirdPartyUsage(
      env,
      { ...base, occurredAt: 'not-a-timestamp' } as unknown as MeasuredThirdPartyUsage,
    )).resolves.toBe(false);
    expect(messages).toEqual([]);
    expect(diagnostic).toHaveBeenNthCalledWith(1, 'usage telemetry event rejected', {
      errorType: 'missingOccurredAt',
    });
    expect(diagnostic).toHaveBeenNthCalledWith(2, 'usage telemetry event rejected', {
      errorType: 'invalidOccurredAt',
    });
    const serializedDiagnostic = JSON.stringify(diagnostic.mock.calls);
    expect(serializedDiagnostic).not.toContain('ct-sync-xai-response-123-cost');
    expect(serializedDiagnostic).not.toContain('not-a-timestamp');
    diagnostic.mockRestore();
  });

  it('reconstructs byte-identical stable-key events for every measured dimension across time', async () => {
    const messages: QueueMessage[] = [];
    const env = fakeEnv(messages);
    const occurrence = '2026-07-13T12:00:00.123Z';
    const dimensions: Array<{
      suffix: string;
      service: string;
      metricType: 'usage' | 'cost';
      quantity: number;
      unit: 'token' | 'page' | 'call' | 'usd';
      costUsd?: number;
    }> = [
      { suffix: 'cost', service: 'llm', metricType: 'cost', quantity: 0, unit: 'usd', costUsd: 0 },
      { suffix: 'tokens', service: 'llm', metricType: 'usage', quantity: 950, unit: 'token' },
      { suffix: 'pages', service: 'ocr', metricType: 'usage', quantity: 3, unit: 'page' },
      { suffix: 'attachment-search', service: 'llm', metricType: 'usage', quantity: 2, unit: 'call' },
    ];
    const emit = async () => {
      for (const dimension of dimensions) {
        await recordMeasuredThirdPartyUsage(env, {
          provider: 'xai',
          service: dimension.service,
          operation: `benchmark-${dimension.suffix}`,
          idempotencyKey: await stableMeasuredUsageIdempotencyKey(
            'provider-result', dimension.suffix, 'xai', 'response-123',
          ),
          occurredAt: occurrence,
          model: 'grok-4.3',
          metricType: dimension.metricType,
          quantity: dimension.quantity,
          unit: dimension.unit,
          ...(dimension.costUsd == null ? {} : { costUsd: dimension.costUsd }),
          billingMode: 'actual',
          confidence: 'actual',
        });
      }
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T13:00:00.000Z'));
    await emit();
    vi.setSystemTime(new Date('2026-07-14T01:00:00.000Z'));
    await emit();

    expect(messages).toHaveLength(dimensions.length * 2);
    for (const [index, dimension] of dimensions.entries()) {
      expect(JSON.stringify(messages[index])).toBe(JSON.stringify(messages[index + dimensions.length]));
      const message = messages[index];
      if (message.type !== 'usage.telemetry') throw new Error('unexpected message');
      const expectedKey = await stableMeasuredUsageIdempotencyKey(
        'provider-result', dimension.suffix, 'xai', 'response-123',
      );
      expect(message.event).toMatchObject({
        idempotencyKey: expectedKey,
        occurredAt: occurrence,
        quantity: dimension.quantity,
        ...(dimension.costUsd == null ? {} : { costUsd: dimension.costUsd }),
      });
    }
  });
});

function workerTypeScriptFiles(root: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
    if (entry.isDirectory()) files.push(...workerTypeScriptFiles(url));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(url);
  }
  return files;
}

function operatorJavaScriptFiles(root: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
    if (entry.isDirectory()) files.push(...operatorJavaScriptFiles(url));
    else if (entry.name.endsWith('.mjs')) files.push(url);
  }
  return files;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function fetchMemberName(expression: ts.Expression): string | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (
    ts.isElementAccessExpression(current)
    && current.argumentExpression
    && (ts.isStringLiteral(current.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
  ) {
    return current.argumentExpression.text;
  }
  return undefined;
}

function isRawFetchReference(expression: ts.Expression, aliases: Set<string>): boolean {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    return current.text === 'fetch' || current.text === 'fetchImpl' || aliases.has(current.text);
  }
  const memberName = fetchMemberName(current);
  if (memberName === 'fetch' || memberName === 'fetchImpl') return true;
  if (
    ts.isBinaryExpression(current)
    && (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isRawFetchReference(current.left, aliases) || isRawFetchReference(current.right, aliases);
  }
  if (ts.isConditionalExpression(current)) {
    return isRawFetchReference(current.whenTrue, aliases) || isRawFetchReference(current.whenFalse, aliases);
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'bind'
  ) {
    return isRawFetchReference(current.expression.expression, aliases);
  }
  return false;
}

function isRawFetchCallee(expression: ts.Expression, aliases: Set<string>): boolean {
  const current = unwrapExpression(expression);
  if (isRawFetchReference(current, aliases)) return true;
  return ts.isPropertyAccessExpression(current)
    && (current.name.text === 'call' || current.name.text === 'apply')
    && isRawFetchReference(current.expression, aliases);
}

function rawFetchAliases(ast: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const candidates: Array<{ name: string; initializer: ts.Expression }> = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        candidates.push({ name: node.name.text, initializer: node.initializer });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(element.name)
            && ((ts.isIdentifier(property) && property.text === 'fetch')
              || (ts.isStringLiteral(property) && property.text === 'fetch'))
          ) {
            aliases.add(element.name.text);
          }
        }
      }
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
    ) {
      candidates.push({ name: node.left.text, initializer: node.right });
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (!aliases.has(candidate.name) && isRawFetchReference(candidate.initializer, aliases)) {
        aliases.add(candidate.name);
        changed = true;
      }
    }
  }
  return aliases;
}

function rawFetchViolations(relative: string, source: string): string[] {
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = rawFetchAliases(ast);
  const violations: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRawFetchCallee(node.expression, aliases)) {
      const callee = unwrapExpression(node.expression);
      const isTelemetryPrimitive =
        relative === 'shared/thirdPartyTelemetry.ts'
        && ts.isIdentifier(callee)
        && callee.text === 'fetchImpl';
      const isOperatorTelemetryPrimitive =
        relative === 'scripts/usage-telemetry.mjs'
        && ts.isIdentifier(callee)
        && callee.text === 'fetchImpl';
      const isInternalHonoDispatch =
        relative === 'index.ts'
        && ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'app'
        && callee.name.text === 'fetch';
      if (!isTelemetryPrimitive && !isOperatorTelemetryPrimitive && !isInternalHonoDispatch) {
        const pos = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        violations.push(`${relative}:${pos.line + 1}:${callee.getText(ast)}`);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return violations;
}

describe('outbound-call inventory enforcement', () => {
  it('routes every deployed Worker and operator third-party fetch through a tracked transport', () => {
    const srcRoot = new URL('../../', testModuleUrl);
    const scriptsRoot = new URL('../../../scripts/', testModuleUrl);
    const violations: string[] = [];
    for (const file of workerTypeScriptFiles(srcRoot)) {
      const relative = decodeURIComponent(file.pathname.slice(srcRoot.pathname.length));
      // These are browser-side, same-origin API calls embedded in the dashboard.
      if (relative === 'ui/dashboardHtml.ts') continue;
      const source = readFileSync(file, 'utf8') as string;
      violations.push(...rawFetchViolations(relative, source));
    }
    for (const file of operatorJavaScriptFiles(scriptsRoot)) {
      const scriptRelative = decodeURIComponent(file.pathname.slice(scriptsRoot.pathname.length));
      // This operator script calls Congress.Trade's own admin route. The model
      // provider request it triggers happens inside the instrumented Worker.
      if (scriptRelative === 'retry-llamaparse-failed.mjs') continue;
      const source = readFileSync(file, 'utf8') as string;
      violations.push(...rawFetchViolations(`scripts/${scriptRelative}`, source));
    }
    expect(violations).toEqual([]);
  }, 15_000);

  it('detects aliased, bound, destructured, and member fetch calls in server code', () => {
    const source = [
      'const alias = fetch;',
      'alias("https://example.test/alias");',
      'const bound = globalThis.fetch.bind(globalThis);',
      'bound("https://example.test/bound");',
      'const { fetch: destructured } = globalThis;',
      'destructured("https://example.test/destructured");',
      'client.fetch("https://example.test/member");',
      'globalThis.fetch.call(globalThis, "https://example.test/call");',
    ].join('\n');

    expect(rawFetchViolations('fixture.ts', source)).toEqual([
      'fixture.ts:2:alias',
      'fixture.ts:4:bound',
      'fixture.ts:6:destructured',
      'fixture.ts:7:client.fetch',
      'fixture.ts:8:globalThis.fetch.call',
    ]);
  });

  it('keeps browser dashboard source and the tracked transport boundary explicitly scoped out', () => {
    expect(rawFetchViolations('ui/dashboardHtml.ts', 'fetch("/api/health")')).toEqual([
      'ui/dashboardHtml.ts:1:fetch',
    ]);
    expect(rawFetchViolations(
      'shared/thirdPartyTelemetry.ts',
      'async function transport(fetchImpl: typeof fetch) { return fetchImpl("https://example.test"); }',
    )).toEqual([]);
  });

  it('keeps the Usage Monitor ingest transport centralized and non-recursive', () => {
    const srcRoot = new URL('../../', testModuleUrl);
    const scriptsRoot = new URL('../../../scripts/', testModuleUrl);
    const owners: string[] = [];
    for (const file of workerTypeScriptFiles(srcRoot)) {
      const relative = decodeURIComponent(file.pathname.slice(srcRoot.pathname.length));
      if (readFileSync(file, 'utf8').includes('createUsageTelemetryClient')) owners.push(relative);
    }
    for (const file of operatorJavaScriptFiles(scriptsRoot)) {
      const relative = `scripts/${decodeURIComponent(file.pathname.slice(scriptsRoot.pathname.length))}`;
      if (readFileSync(file, 'utf8').includes('createUsageTelemetryClient')) owners.push(relative);
    }
    expect(owners.sort()).toEqual([
      'scripts/usage-telemetry.mjs',
      'shared/thirdPartyTelemetry.ts',
    ]);
  });
});
