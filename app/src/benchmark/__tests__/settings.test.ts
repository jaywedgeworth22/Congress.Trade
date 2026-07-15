import { describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types';
import {
  BenchmarkSettingsConflictError,
  BenchmarkSettingsValidationError,
  BenchmarkSettingsWriteError,
  readBenchmarkLineupSettings,
  saveBenchmarkLineupSettings,
  validateBenchmarkLineup,
} from '../settings';

const OLD = {
  a: 'mistral:mistral-ocr-latest',
  b: 'openai:gpt-5.6-terra',
  c: 'anthropic:claude-haiku-4-5',
};

const NEW = {
  a: { provider: 'openai', model: 'gpt-5.6-terra' },
  b: { provider: 'gemini', model: 'gemini-3.5-flash' },
  c: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

function dependencies(state: Record<string, string>, options: { failOnce?: string } = {}) {
  let failed = false;
  return {
    resolve: async (_env: Env, keys: string[]) => Object.fromEntries(
      keys.map((key) => [key, state[key]]),
    ),
    readSource: async () => Object.fromEntries(
      Object.entries(state).filter(([key]) => key.startsWith('AGREEMENT_HOUSE_MODEL_')
        || key.startsWith('AGREEMENT_SENATE_MODEL_')
        || key.startsWith('AGREEMENT_EXEC_MODEL_')),
    ),
    configuredKey: async () => 'configured-key',
    write: async (_env: Env, _source: 'app' | 'shared', key: string, value: string) => {
      if (!failed && options.failOnce === key) {
        failed = true;
        throw new Error('simulated Infisical write failure');
      }
      state[key] = value;
    },
    remove: async (_env: Env, _source: 'app' | 'shared', key: string) => {
      delete state[key];
    },
    refresh: async () => ({}),
  };
}

function initialState(): Record<string, string> {
  return {
    AGREEMENT_AUTOPUBLISH_MODEL_A: OLD.a,
    AGREEMENT_AUTOPUBLISH_MODEL_B: OLD.b,
    AGREEMENT_MODEL_C: OLD.c,
  };
}

describe('benchmark lineup settings', () => {
  it('reads the effective global fallback and reports credential availability without values', async () => {
    const env = {
      ...initialState(),
      OPENAI_API_KEY: 'openai-key',
      MISTRAL_API_KEY: 'mistral-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
    } as unknown as Env;
    const settings = await readBenchmarkLineupSettings(env, 'house');
    expect(settings.lineup).toEqual({
      a: { provider: 'mistral', model: 'mistral-ocr-latest' },
      b: { provider: 'openai', model: 'gpt-5.6-terra' },
      c: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(settings.valid).toBe(true);
    expect(settings.version).toMatch(/^[a-f0-9]{64}$/);
    expect(settings.catalog.find((model) => model.provider === 'openai')).toMatchObject({
      configured: true,
    });
    expect(JSON.stringify(settings)).not.toContain('openai-key');
  });

  it('rejects a lineup that lets one provider corroborate itself', () => {
    expect(() => validateBenchmarkLineup({
      a: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      b: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      c: { provider: 'openai', model: 'gpt-5.6-terra' },
    })).toThrow(BenchmarkSettingsValidationError);
  });

  it('writes all three chamber keys and verifies readback', async () => {
    const state = initialState();
    const deps = dependencies(state);
    const current = await readBenchmarkLineupSettings({} as Env, 'senate', deps as never);
    const saved = await saveBenchmarkLineupSettings({} as Env, {
      chamber: 'senate',
      ...NEW,
      expectedVersion: current.version,
    }, deps as never);

    expect(saved.settings.lineup).toEqual(NEW);
    expect(saved.audit).toMatchObject({
      readbackVerified: true,
      rollbackAttempted: false,
      writtenKeys: [
        'AGREEMENT_SENATE_MODEL_A',
        'AGREEMENT_SENATE_MODEL_B',
        'AGREEMENT_SENATE_MODEL_C',
      ],
    });
    expect(state.AGREEMENT_SENATE_MODEL_A).toBe('openai:gpt-5.6-terra');
    expect(state.AGREEMENT_SENATE_MODEL_B).toBe('gemini:gemini-3.5-flash');
    expect(state.AGREEMENT_SENATE_MODEL_C).toBe('anthropic:claude-sonnet-4-6');
  });

  it('supports the first-ever chamber save when no effective lineup exists', async () => {
    const state: Record<string, string> = {};
    const deps = dependencies(state);
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);
    expect(current).toMatchObject({ lineup: null, valid: false });

    const saved = await saveBenchmarkLineupSettings({} as Env, {
      chamber: 'house',
      ...NEW,
      expectedVersion: current.version,
    }, deps as never);

    expect(saved.settings).toMatchObject({ lineup: NEW, valid: true });
    expect(saved.audit).toMatchObject({ readbackVerified: true, rollbackAttempted: false });
    expect(state.AGREEMENT_HOUSE_MODEL_A).toBe('openai:gpt-5.6-terra');
    expect(state.AGREEMENT_HOUSE_MODEL_B).toBe('gemini:gemini-3.5-flash');
    expect(state.AGREEMENT_HOUSE_MODEL_C).toBe('anthropic:claude-sonnet-4-6');
  });

  it('rolls back a partial write without pinning inherited branch overrides', async () => {
    const state = initialState();
    const deps = dependencies(state, { failOnce: 'AGREEMENT_EXEC_MODEL_B' });
    const current = await readBenchmarkLineupSettings({} as Env, 'executive', deps as never);

    let thrown: unknown;
    try {
      await saveBenchmarkLineupSettings({} as Env, {
        chamber: 'executive',
        ...NEW,
        expectedVersion: current.version,
      }, deps as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BenchmarkSettingsWriteError);
    expect((thrown as BenchmarkSettingsWriteError).audit).toMatchObject({
      rollbackAttempted: true,
      rollbackVerified: true,
    });
    expect(state.AGREEMENT_EXEC_MODEL_A).toBeUndefined();
    expect(state.AGREEMENT_EXEC_MODEL_B).toBeUndefined();
    expect(state.AGREEMENT_EXEC_MODEL_C).toBeUndefined();
  });

  it('verifies exact rollback to missing source values when no fallback lineup exists', async () => {
    const state: Record<string, string> = {};
    const deps = dependencies(state, { failOnce: 'AGREEMENT_HOUSE_MODEL_B' });
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);

    let thrown: unknown;
    try {
      await saveBenchmarkLineupSettings({} as Env, {
        chamber: 'house',
        ...NEW,
        expectedVersion: current.version,
      }, deps as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BenchmarkSettingsWriteError);
    expect((thrown as BenchmarkSettingsWriteError).audit).toMatchObject({
      rollbackAttempted: true,
      rollbackVerified: true,
      previousVersion: current.version,
    });
    expect(state.AGREEMENT_HOUSE_MODEL_A).toBeUndefined();
    expect(state.AGREEMENT_HOUSE_MODEL_B).toBeUndefined();
    expect(state.AGREEMENT_HOUSE_MODEL_C).toBeUndefined();
  });

  it('rejects a stale optimistic version before any write', async () => {
    const state = initialState();
    const deps = dependencies(state);
    await expect(saveBenchmarkLineupSettings({} as Env, {
      chamber: 'house',
      ...NEW,
      expectedVersion: 'stale-version',
    }, deps as never)).rejects.toBeInstanceOf(BenchmarkSettingsConflictError);
    expect(state.AGREEMENT_HOUSE_MODEL_A).toBeUndefined();
  });

  it('checks the lease fence before each write and refuses stale rollback', async () => {
    const state = initialState();
    const deps = dependencies(state, { failOnce: 'AGREEMENT_HOUSE_MODEL_B' });
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);
    let fenceChecks = 0;

    let thrown: unknown;
    try {
      await saveBenchmarkLineupSettings({} as Env, {
        chamber: 'house',
        ...NEW,
        expectedVersion: current.version,
      }, deps as never, {
        assertLease: async () => {
          fenceChecks += 1;
          if (fenceChecks >= 3) throw new Error('lease replaced by successor');
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BenchmarkSettingsWriteError);
    expect((thrown as BenchmarkSettingsWriteError).audit).toMatchObject({
      writtenKeys: ['AGREEMENT_HOUSE_MODEL_A'],
      rollbackAttempted: true,
      rollbackVerified: false,
    });
    expect(fenceChecks).toBe(3);
    // The stale writer leaves its partial value for the live owner to reconcile;
    // critically, it does not delete or overwrite the successor's keyspace.
    expect(state.AGREEMENT_HOUSE_MODEL_A).toBe('openai:gpt-5.6-terra');
  });

  it('aborts a timed-out Infisical mutation before the lease can expire', async () => {
    const state = initialState();
    let firstWrite = true;
    let aborted = false;
    const deps = {
      ...dependencies(state),
      write: async (
        _env: Env,
        _source: 'app' | 'shared',
        key: string,
        value: string,
        options?: { signal?: AbortSignal },
      ) => {
        if (!firstWrite) {
          state[key] = value;
          return;
        }
        firstWrite = false;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    };
    const current = await readBenchmarkLineupSettings({} as Env, 'house', deps as never);

    await expect(saveBenchmarkLineupSettings({} as Env, {
      chamber: 'house',
      ...NEW,
      expectedVersion: current.version,
    }, deps as never, {
      operationTimeoutMs: 1_000,
      assertLease: async () => undefined,
    })).rejects.toBeInstanceOf(BenchmarkSettingsWriteError);
    expect(aborted).toBe(true);
  });
});
