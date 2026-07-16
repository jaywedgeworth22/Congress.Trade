import { describe, expect, it } from 'vitest';
import {
  benchmarkCanaryTarget,
  classifyProviderFailure,
  findProviderFailureBlock,
  modelsAffectedByProviderFailure,
} from '../providerFailure';

describe('benchmark provider failure classification', () => {
  it('classifies current project/model access errors without retaining identifiers', () => {
    expect(classifyProviderFailure(
      'openai',
      'gpt-5.6-terra',
      'openai 403 {"error":{"message":"Project proj_example does not have access to model gpt-5.6-terra","code":"model_not_found"}}',
    )).toEqual({
      code: 'model_access_denied',
      scope: 'model',
      retryable: false,
      message: 'The current openai project does not have access to gpt-5.6-terra.',
    });
  });

  it('classifies provider-wide billing limits and preserves a machine-readable reset', () => {
    expect(classifyProviderFailure(
      'anthropic',
      'claude-sonnet-5',
      'You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.',
    )).toMatchObject({
      code: 'provider_usage_limit',
      scope: 'provider',
      retryable: false,
      retryAt: '2026-08-01T00:00:00.000Z',
    });
    expect(classifyProviderFailure(
      'gemini',
      'gemini-3.5-flash',
      'Gemini API 429: Your prepayment credits are depleted.',
    )).toMatchObject({
      code: 'provider_credits_depleted',
      scope: 'provider',
      retryable: false,
    });
  });

  it('does not circuit-break transient or document-specific failures', () => {
    expect(classifyProviderFailure('openai', 'gpt-5.6-terra', 'openai 429 rate limited')).toBeNull();
    expect(classifyProviderFailure('openai', 'gpt-5.6-terra', 'openai: parse error')).toBeNull();
    expect(classifyProviderFailure('xai', 'grok-4.3', 'xai 503 temporarily unavailable')).toBeNull();
  });
});

describe('benchmark provider circuit planning', () => {
  const models = [
    { provider: 'openai', model: 'gpt-5.6-terra' },
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'anthropic', model: 'claude-sonnet-5' },
    { provider: 'anthropic', model: 'claude-haiku-4-5' },
  ];

  it('blocks only the inaccessible OpenAI model while preserving GPT-4o', () => {
    const failure = {
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1', invoked: true,
      ok: false, outcome: 'skipped', error: 'model_not_found', result: null,
    };
    expect(findProviderFailureBlock([failure], models[0])).not.toBeNull();
    expect(findProviderFailureBlock([failure], models[1])).toBeNull();
  });

  it('blocks every model from a provider whose account usage is exhausted', () => {
    const failure = {
      provider: 'anthropic', model: 'claude-sonnet-5', docId: 'H-1', invoked: true,
      ok: false, outcome: 'skipped',
      error: 'You have reached your specified API usage limits.',
      result: null,
    };
    const block = findProviderFailureBlock([failure], models[3]);
    expect(block?.failure).toMatchObject({ code: 'provider_usage_limit', scope: 'provider' });
    if (!block) throw new Error('expected provider-level blocker');
    expect(modelsAffectedByProviderFailure(models, models[2], block.failure)).toEqual(models.slice(2));
  });

  it('admits one provider canary, then one first-document canary per remaining model', () => {
    const documents = [{ docId: 'H-2', ordinal: 1 }, { docId: 'H-1', ordinal: 0 }];
    expect(benchmarkCanaryTarget(documents, [], models, models[1])).toEqual({
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1', scope: 'provider',
    });
    expect(benchmarkCanaryTarget(documents, [{
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1', invoked: false,
      ok: false, outcome: 'running', error: null, result: null,
    }], models, models[1])).toEqual({
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1', scope: 'provider',
    });
    expect(benchmarkCanaryTarget(documents, [{
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1', invoked: true,
      ok: true, outcome: 'would_publish', error: null, result: null,
    }], models, models[1])).toEqual({
      provider: 'openai', model: 'gpt-4o', docId: 'H-1', scope: 'model',
    });
    expect(benchmarkCanaryTarget(documents, [{
      provider: 'openai', model: 'gpt-4o', docId: 'H-1', invoked: true,
      ok: true, outcome: 'would_publish', error: null, result: null,
    }], models, models[1])).toBeNull();
  });

  it('advances past terminal local failures without releasing the provider gate', () => {
    const documents = [
      { docId: 'H-1', ordinal: 0 },
      { docId: 'H-2', ordinal: 1 },
      { docId: 'H-3', ordinal: 2 },
    ];
    const localFailure = {
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-1', invoked: false,
      ok: false, outcome: 'skipped', error: 'R2 document unavailable', result: null,
    };
    expect(benchmarkCanaryTarget(documents, [localFailure], models, models[1])).toEqual({
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-2', scope: 'provider',
    });

    const providerResponse = {
      provider: 'openai', model: 'gpt-5.6-terra', docId: 'H-2', invoked: true,
      ok: true, outcome: 'would_publish', error: null, result: null,
    };
    expect(benchmarkCanaryTarget(
      documents,
      [localFailure, providerResponse],
      models,
      models[1],
    )).toEqual({
      provider: 'openai', model: 'gpt-4o', docId: 'H-1', scope: 'model',
    });
    expect(benchmarkCanaryTarget(
      documents,
      [localFailure, providerResponse],
      models,
      models[0],
    )).toBeNull();
  });
});
