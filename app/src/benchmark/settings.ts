import type { Env } from '../shared/types';
import {
  DEFAULT_CANDIDATES,
  keyFor,
  type BakeoffCandidate,
  type Provider,
} from '../extraction/bakeoff';
import {
  deleteSecret,
  readSourceSecrets,
  refreshSecrets,
  resolveSecrets,
  updateSecret,
  type SecretMutationOptions,
} from '../secrets/infisical';
import type {
  BenchmarkChamber,
  BenchmarkModelRef,
  BenchmarkSelectedLineup,
} from './persistence';

type LineupSlot = 'a' | 'b' | 'c';

export const BENCHMARK_LINEUP_KEYS: Record<
  BenchmarkChamber,
  Record<LineupSlot, string>
> = {
  house: {
    a: 'AGREEMENT_HOUSE_MODEL_A',
    b: 'AGREEMENT_HOUSE_MODEL_B',
    c: 'AGREEMENT_HOUSE_MODEL_C',
  },
  senate: {
    a: 'AGREEMENT_SENATE_MODEL_A',
    b: 'AGREEMENT_SENATE_MODEL_B',
    c: 'AGREEMENT_SENATE_MODEL_C',
  },
  executive: {
    a: 'AGREEMENT_EXEC_MODEL_A',
    b: 'AGREEMENT_EXEC_MODEL_B',
    c: 'AGREEMENT_EXEC_MODEL_C',
  },
};

/**
 * LlamaParse is selectable in the benchmark UI but intentionally absent from
 * DEFAULT_CANDIDATES (the automatic bake-off default). Keep it in the same
 * server-side catalog so the UI cannot save an arbitrary provider/model pair.
 */
const LLAMAPARSE_CANDIDATES: BakeoffCandidate[] = [
  { provider: 'llamaparse', model: 'fast' },
  { provider: 'llamaparse', model: 'cost-effective' },
  { provider: 'llamaparse', model: 'agentic' },
];

export function benchmarkModelCatalog(): BakeoffCandidate[] {
  const byKey = new Map<string, BakeoffCandidate>();
  for (const candidate of [...DEFAULT_CANDIDATES, ...LLAMAPARSE_CANDIDATES]) {
    byKey.set(`${candidate.provider}:${candidate.model}`, { ...candidate });
  }
  return [...byKey.values()];
}

export interface BenchmarkCatalogEntry extends BenchmarkModelRef {
  configured: boolean;
}

export interface BenchmarkLineupSettings {
  chamber: BenchmarkChamber;
  lineup: BenchmarkSelectedLineup | null;
  /** SHA-256 over the explicit chamber values. */
  version: string;
  valid: boolean;
  keys: Record<LineupSlot, string>;
  catalog: BenchmarkCatalogEntry[];
}

export interface BenchmarkSettingsAudit {
  chamber: BenchmarkChamber;
  keys: string[];
  previousVersion: string;
  resultingVersion: string | null;
  writtenKeys: string[];
  readbackVerified: boolean;
  rollbackAttempted: boolean;
  rollbackVerified: boolean | null;
}

export class BenchmarkSettingsValidationError extends Error {}

export class BenchmarkSettingsConflictError extends Error {
  constructor(
    message: string,
    readonly current: BenchmarkLineupSettings,
  ) {
    super(message);
  }
}

export class BenchmarkSettingsWriteError extends Error {
  constructor(
    message: string,
    readonly audit: BenchmarkSettingsAudit,
  ) {
    super(message);
  }
}

interface SettingsDependencies {
  resolve: typeof resolveSecrets;
  readSource: typeof readSourceSecrets;
  configuredKey: typeof keyFor;
  write: (
    env: Env,
    source: 'app' | 'shared',
    key: string,
    value: string,
    options?: SecretMutationOptions,
  ) => Promise<void>;
  remove: (
    env: Env,
    source: 'app' | 'shared',
    key: string,
    options?: SecretMutationOptions,
  ) => Promise<void>;
  refresh: typeof refreshSecrets;
}

export interface BenchmarkSettingsMutationControl {
  /** D1-backed ownership/freshness assertion supplied by the admin route. */
  assertLease?: () => Promise<void>;
  /** Per Infisical/readback operation bound; mutation fetches are also aborted. */
  operationTimeoutMs?: number;
}

const DEFAULT_SETTINGS_OPERATION_TIMEOUT_MS = 15_000;

const DEFAULT_DEPENDENCIES: SettingsDependencies = {
  resolve: resolveSecrets,
  readSource: readSourceSecrets,
  configuredKey: keyFor,
  write: updateSecret,
  remove: deleteSecret,
  refresh: refreshSecrets,
};

async function boundedSettingsOperation<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function settingsOperationTimeout(control: BenchmarkSettingsMutationControl): number {
  const timeoutMs = control.operationTimeoutMs ?? DEFAULT_SETTINGS_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new BenchmarkSettingsValidationError('operationTimeoutMs must be between 1 and 60000');
  }
  return timeoutMs;
}

function cleanModelRef(value: BenchmarkModelRef, field: string): BenchmarkModelRef {
  if (!value || typeof value !== 'object') {
    throw new BenchmarkSettingsValidationError(`${field} must be {provider,model}`);
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim().toLowerCase() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model) {
    throw new BenchmarkSettingsValidationError(`${field} must be {provider,model}`);
  }
  return { provider, model };
}

export function parseBenchmarkModelRef(value: string | undefined): BenchmarkModelRef | null {
  if (!value) return null;
  const [provider, ...modelParts] = value.trim().split(':');
  const model = modelParts.join(':').trim();
  return provider && model ? { provider: provider.toLowerCase(), model } : null;
}

export function serializeBenchmarkModelRef(value: BenchmarkModelRef): string {
  return `${value.provider}:${value.model}`;
}

export function validateBenchmarkModel(
  value: BenchmarkModelRef,
  field = 'model',
): BakeoffCandidate {
  const model = cleanModelRef(value, field);
  const match = benchmarkModelCatalog().find(
    (candidate) => candidate.provider === model.provider && candidate.model === model.model,
  );
  if (!match) {
    throw new BenchmarkSettingsValidationError(
      `${field} is not in the benchmark model catalog`,
    );
  }
  return match;
}

export function validateBenchmarkLineup(input: {
  a: BenchmarkModelRef;
  b: BenchmarkModelRef;
  c: BenchmarkModelRef;
}): BenchmarkSelectedLineup {
  const lineup: BenchmarkSelectedLineup = {
    a: validateBenchmarkModel(input.a, 'a'),
    b: validateBenchmarkModel(input.b, 'b'),
    c: validateBenchmarkModel(input.c, 'c'),
  };
  const models = [lineup.a, lineup.b, lineup.c as BenchmarkModelRef];
  if (new Set(models.map(serializeBenchmarkModelRef)).size !== 3) {
    throw new BenchmarkSettingsValidationError('a, b, and c must be three distinct models');
  }
  if (new Set(models.map((model) => model.provider)).size !== 3) {
    throw new BenchmarkSettingsValidationError('a, b, and c must use three distinct providers');
  }
  return lineup;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function sameLineup(
  actual: BenchmarkSelectedLineup | null,
  expected: BenchmarkSelectedLineup,
): boolean {
  if (!actual?.c || !expected.c) return false;
  return (['a', 'b', 'c'] as const).every(
    (slot) => serializeBenchmarkModelRef(actual[slot] as BenchmarkModelRef)
      === serializeBenchmarkModelRef(expected[slot] as BenchmarkModelRef),
  );
}

async function readSettingsWithDependencies(
  env: Env,
  chamber: BenchmarkChamber,
  dependencies: SettingsDependencies,
): Promise<BenchmarkLineupSettings> {
  const keys = BENCHMARK_LINEUP_KEYS[chamber];
  const requestedKeys = [keys.a, keys.b, keys.c] as const;
  const values = await dependencies.resolve(env, [...requestedKeys]);
  const branchValues = {
    a: values[keys.a],
    b: values[keys.b],
    c: values[keys.c],
  };
  const a = parseBenchmarkModelRef(branchValues.a);
  const b = parseBenchmarkModelRef(branchValues.b);
  const c = parseBenchmarkModelRef(branchValues.c);
  const lineup = a && b && c ? { a, b, c } : null;
  let valid = false;
  if (lineup) {
    try {
      validateBenchmarkLineup(lineup);
      valid = true;
    } catch {
      valid = false;
    }
  }
  const version = await sha256(JSON.stringify({ chamber, branchValues }));
  const catalog = benchmarkModelCatalog();
  const configuredByProvider = new Map<Provider, boolean>();
  await Promise.all([...new Set(catalog.map((candidate) => candidate.provider))].map(async (provider) => {
    configuredByProvider.set(provider, Boolean(await dependencies.configuredKey(env, provider)));
  }));
  return {
    chamber,
    lineup,
    version,
    valid,
    keys,
    catalog: catalog.map((candidate) => ({
      ...candidate,
      configured: configuredByProvider.get(candidate.provider) ?? false,
    })),
  };
}

export async function readBenchmarkLineupSettings(
  env: Env,
  chamber: BenchmarkChamber,
  dependencies: Partial<SettingsDependencies> = {},
): Promise<BenchmarkLineupSettings> {
  return readSettingsWithDependencies(env, chamber, { ...DEFAULT_DEPENDENCIES, ...dependencies });
}

export async function saveBenchmarkLineupSettings(
  env: Env,
  input: {
    chamber: BenchmarkChamber;
    a: BenchmarkModelRef;
    b: BenchmarkModelRef;
    c: BenchmarkModelRef;
    expectedVersion: string;
  },
  dependencies: Partial<SettingsDependencies> = {},
  control: BenchmarkSettingsMutationControl = {},
): Promise<{ settings: BenchmarkLineupSettings; audit: BenchmarkSettingsAudit }> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const timeoutMs = settingsOperationTimeout(control);
  const assertLease = control.assertLease ?? (async () => undefined);
  const lineup = validateBenchmarkLineup(input);
  if (!input.expectedVersion || typeof input.expectedVersion !== 'string') {
    throw new BenchmarkSettingsValidationError('expectedVersion is required');
  }
  const current = await boundedSettingsOperation(
    'read current benchmark settings',
    timeoutMs,
    () => readSettingsWithDependencies(env, input.chamber, deps),
  );
  if (current.version !== input.expectedVersion) {
    throw new BenchmarkSettingsConflictError('benchmark lineup settings changed; reload and retry', current);
  }

  const requested = [lineup.a, lineup.b, lineup.c as BenchmarkModelRef];
  const configured = await boundedSettingsOperation(
    'validate benchmark provider credentials',
    timeoutMs,
    () => Promise.all(
      requested.map((model) => deps.configuredKey(env, model.provider as Provider)),
    ),
  );
  const missingProviders = requested
    .filter((_model, index) => !configured[index])
    .map((model) => model.provider);
  if (missingProviders.length) {
    throw new BenchmarkSettingsValidationError(
      `provider credentials are not configured: ${missingProviders.join(', ')}`,
    );
  }

  const keys = BENCHMARK_LINEUP_KEYS[input.chamber];
  const writes: Array<{ slot: LineupSlot; key: string; value: string }> = [
    { slot: 'a', key: keys.a, value: serializeBenchmarkModelRef(lineup.a) },
    { slot: 'b', key: keys.b, value: serializeBenchmarkModelRef(lineup.b) },
    { slot: 'c', key: keys.c, value: serializeBenchmarkModelRef(lineup.c as BenchmarkModelRef) },
  ];
  // Snapshot only source-owned branch overrides. Inherited global/shared/env
  // values are intentionally absent so rollback deletes a newly-created app
  // override instead of pinning today's fallback forever.
  const sourceValues = await boundedSettingsOperation(
    'read current benchmark source overrides',
    timeoutMs,
    () => deps.readSource(env, 'app'),
  );
  const priorValues: Record<LineupSlot, string | undefined> = {
    a: sourceValues[keys.a],
    b: sourceValues[keys.b],
    c: sourceValues[keys.c],
  };
  const audit: BenchmarkSettingsAudit = {
    chamber: input.chamber,
    keys: writes.map((write) => write.key),
    previousVersion: current.version,
    resultingVersion: null,
    writtenKeys: [],
    readbackVerified: false,
    rollbackAttempted: false,
    rollbackVerified: null,
  };

  try {
    for (const write of writes) {
      await assertLease();
      await boundedSettingsOperation(
        `write ${write.key}`,
        timeoutMs,
        (signal) => deps.write(env, 'app', write.key, write.value, { signal }),
      );
      audit.writtenKeys.push(write.key);
    }
    await boundedSettingsOperation(
      'refresh benchmark settings',
      timeoutMs,
      () => deps.refresh(env),
    );
    const settings = await boundedSettingsOperation(
      'verify benchmark settings',
      timeoutMs,
      () => readSettingsWithDependencies(env, input.chamber, deps),
    );
    if (!sameLineup(settings.lineup, lineup)) {
      throw new Error('Infisical readback did not match the requested lineup');
    }
    // Do not report success after this writer's lease expired or was replaced
    // while readback was in flight.
    await assertLease();
    audit.readbackVerified = true;
    audit.resultingVersion = settings.version;
    return { settings, audit };
  } catch (error) {
    audit.rollbackAttempted = true;
    try {
      for (const write of writes) {
        // A stale writer must never undo a successor's values. Losing the
        // owner-token fence aborts rollback immediately.
        await assertLease();
        const priorValue = priorValues[write.slot];
        if (priorValue === undefined) {
          await boundedSettingsOperation(
            `rollback delete ${write.key}`,
            timeoutMs,
            (signal) => deps.remove(env, 'app', write.key, { signal }),
          );
        } else {
          await boundedSettingsOperation(
            `rollback write ${write.key}`,
            timeoutMs,
            (signal) => deps.write(env, 'app', write.key, priorValue, { signal }),
          );
        }
      }
      await boundedSettingsOperation(
        'refresh rolled-back benchmark settings',
        timeoutMs,
        () => deps.refresh(env),
      );
      const rolledBack = await boundedSettingsOperation(
        'verify rolled-back benchmark settings',
        timeoutMs,
        () => readSettingsWithDependencies(env, input.chamber, deps),
      );
      const restoredSource = await boundedSettingsOperation(
        'verify rolled-back benchmark source overrides',
        timeoutMs,
        () => deps.readSource(env, 'app'),
      );
      await assertLease();
      const exactSourceRollback = writes.every(
        (write) => restoredSource[write.key] === priorValues[write.slot],
      );
      audit.rollbackVerified = exactSourceRollback && rolledBack.version === current.version;
    } catch {
      audit.rollbackVerified = false;
    }
    throw new BenchmarkSettingsWriteError(
      `failed to save benchmark lineup: ${(error as Error).message}`,
      audit,
    );
  }
}
