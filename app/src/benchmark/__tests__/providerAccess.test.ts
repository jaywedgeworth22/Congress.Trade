import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import {
  checkOpenAiModelAccess,
  clearOpenAiModelAccessCacheForTests,
  openAiModelAccessDecision,
} from '../providerAccess';

const NOW = Date.parse('2026-07-14T19:00:00.000Z');

afterEach(() => {
  clearOpenAiModelAccessCacheForTests();
  vi.restoreAllMocks();
});

function dependencies(options: {
  key?: string | null;
  response?: () => Response;
  requestError?: Error;
  now?: number;
}) {
  const request = vi.fn(async () => {
    if (options.requestError) throw options.requestError;
    return options.response?.() ?? new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  return {
    request,
    value: {
      resolveKey: async () => options.key ?? null,
      request,
      now: () => options.now ?? NOW,
    },
  };
}

describe('OpenAI benchmark model access', () => {
  it('distinguishes a missing credential without making a provider request', async () => {
    const deps = dependencies({ key: null });
    const report = await checkOpenAiModelAccess({} as Env, {
      models: ['gpt-5.6-terra', 'gpt-4o'],
    }, deps.value as never);

    expect(report).toMatchObject({
      configured: false,
      status: 'not_configured',
      catalogChecked: false,
      cached: false,
      failure: { code: 'provider_not_configured', scope: 'provider', retryable: false },
      models: [
        { model: 'gpt-5.6-terra', availability: 'unavailable', available: false },
        { model: 'gpt-4o', availability: 'unavailable', available: false },
      ],
    });
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('uses the tracked non-generation catalog request and caches project-specific availability', async () => {
    const deps = dependencies({
      key: 'sk-super-secret',
      response: () => new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'gpt-5.4' }, { id: 'gpt-4o' }, { id: 'unrequested-internal-model' }],
      }), { status: 200 }),
    });
    const env = {} as Env;
    const options = { models: ['gpt-5.6-terra', 'gpt-5.4', 'gpt-4o'] };
    const first = await checkOpenAiModelAccess(env, options, deps.value as never);
    const cached = await checkOpenAiModelAccess(env, options, deps.value as never);

    expect(first).toMatchObject({
      configured: true,
      status: 'ready',
      catalogChecked: true,
      cached: false,
      models: [
        {
          model: 'gpt-5.6-terra', availability: 'unavailable', available: false,
          failure: { code: 'model_access_denied', scope: 'model', retryable: false },
        },
        { model: 'gpt-5.4', availability: 'available', available: true },
        { model: 'gpt-4o', availability: 'available', available: true },
      ],
    });
    expect(cached.cached).toBe(true);
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(deps.request).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
      { service: 'llm', operation: 'list-model-access', model: 'catalog' },
      expect.any(Function),
      { envOverride: env, silentQueueFailure: true },
    );
    expect(JSON.stringify(first)).not.toContain('sk-super-secret');
    expect(JSON.stringify(first)).not.toContain('unrequested-internal-model');
    expect(openAiModelAccessDecision(first, 'gpt-5.4')).toBe('available');
    expect(openAiModelAccessDecision(first, 'not-checked')).toBe('unknown');
  });

  it('bypasses the cache on explicit refresh and invalidates it when the key changes', async () => {
    let key = 'sk-first';
    const deps = dependencies({
      key,
      response: () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 }),
    });
    deps.value.resolveKey = async () => key;
    const options = { models: ['gpt-4o'] };

    await checkOpenAiModelAccess({} as Env, options, deps.value as never);
    await checkOpenAiModelAccess({} as Env, options, deps.value as never);
    await checkOpenAiModelAccess({} as Env, { ...options, refresh: true }, deps.value as never);
    key = 'sk-second';
    await checkOpenAiModelAccess({} as Env, options, deps.value as never);

    expect(deps.request).toHaveBeenCalledTimes(3);
  });

  it('classifies an invalid configured credential as a provider-wide block without leaking the response', async () => {
    const deps = dependencies({
      key: 'sk-invalid-secret',
      response: () => new Response(JSON.stringify({
        error: { code: 'invalid_api_key', message: 'Invalid key for project proj_private' },
      }), { status: 401 }),
    });
    const report = await checkOpenAiModelAccess({} as Env, {
      models: ['gpt-5.6-sol', 'gpt-4o'],
    }, deps.value as never);

    expect(report).toMatchObject({
      configured: true,
      status: 'blocked',
      catalogChecked: false,
      failure: { code: 'provider_authentication_failed', scope: 'provider', retryable: false },
      models: [
        { model: 'gpt-5.6-sol', availability: 'unavailable', available: false },
        { model: 'gpt-4o', availability: 'unavailable', available: false },
      ],
    });
    expect(JSON.stringify(report)).not.toContain('sk-invalid-secret');
    expect(JSON.stringify(report)).not.toContain('proj_private');
  });

  it('keeps an ordinary catalog rate limit inconclusive instead of disabling models', async () => {
    const deps = dependencies({
      key: 'sk-rate-limited',
      response: () => new Response(JSON.stringify({
        error: { code: 'rate_limit_exceeded', message: 'Requests per minute exceeded; retry later' },
      }), { status: 429 }),
    });
    const report = await checkOpenAiModelAccess({} as Env, {
      models: ['gpt-5.6-terra'],
    }, deps.value as never);

    expect(report).toMatchObject({
      status: 'error',
      errorCode: 'catalog_rate_limited',
      models: [{ availability: 'unknown', available: null }],
    });
    expect(report.failure).toBeUndefined();
  });

  it('distinguishes exhausted credits from a transient 429', async () => {
    const deps = dependencies({
      key: 'sk-no-credits',
      response: () => new Response(JSON.stringify({
        error: { code: 'insufficient_quota', message: 'You have run out of credits' },
      }), { status: 429 }),
    });
    const report = await checkOpenAiModelAccess({} as Env, {
      models: ['gpt-4o'],
    }, deps.value as never);

    expect(report).toMatchObject({
      status: 'blocked',
      failure: { code: 'provider_credits_depleted', scope: 'provider', retryable: false },
      models: [{ availability: 'unavailable', available: false }],
    });
  });

  it('returns and briefly caches a secret-safe unknown state for transport errors', async () => {
    const deps = dependencies({ key: 'sk-network', requestError: new TypeError('private network detail') });
    const options = { models: ['gpt-5.4'], errorCacheTtlMs: 5_000 };
    const first = await checkOpenAiModelAccess({} as Env, options, deps.value as never);
    const second = await checkOpenAiModelAccess({} as Env, options, deps.value as never);

    expect(first).toMatchObject({
      status: 'error', errorCode: 'network_error',
      models: [{ availability: 'unknown', available: null }],
    });
    expect(second.cached).toBe(true);
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('private network detail');
  });

  it('fails closed on a malformed successful catalog response', async () => {
    const deps = dependencies({
      key: 'sk-malformed',
      response: () => new Response(JSON.stringify({ data: [{ nope: 'missing id' }] }), { status: 200 }),
    });
    const report = await checkOpenAiModelAccess({} as Env, {
      models: ['gpt-5.5'],
    }, deps.value as never);

    expect(report).toMatchObject({
      status: 'error',
      catalogChecked: false,
      errorCode: 'invalid_catalog_response',
      models: [{ model: 'gpt-5.5', availability: 'unknown', available: null }],
    });
  });
});
