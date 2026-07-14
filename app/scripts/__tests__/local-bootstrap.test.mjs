import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(APP_DIR, '../scripts/merge-local-dev-vars.mjs');
const tempDirs = [];
const EXPLICIT_LOCAL_ENV_KEYS = [
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'SENTRY_TRACES_SAMPLE_RATE',
  'ADMIN_OPEN_IN_DEV',
  'USAGE_MONITOR_ENVIRONMENT',
];
const WRANGLER_DOTENV_16_3_1_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), 'ct-infisical-bootstrap-'));
  tempDirs.push(dir);
  return dir;
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('INFISICAL_') || EXPLICIT_LOCAL_ENV_KEYS.includes(key)) delete env[key];
  }
  delete env.APP_DIR;
  delete env.DEV_VARS_FILE;
  delete env.GLOBAL_API_KEYS_FILE;
  delete env.CT_LOCAL_BOOTSTRAP_TEST_MODE;
  delete env.CT_LOCAL_BOOTSTRAP_TEST_APP_DIR;
  delete env.CT_LOCAL_BOOTSTRAP_TEST_DEV_VARS_FILE;
  delete env.CT_LOCAL_BOOTSTRAP_TEST_GLOBAL_KEYS_FILE;
  return { ...env, ...overrides };
}

function runBootstrap({ globalFile, devVarsFile, env = {}, cwd }) {
  const pathOverrides = {
    CT_LOCAL_BOOTSTRAP_TEST_MODE: '1',
    CT_LOCAL_BOOTSTRAP_TEST_APP_DIR: APP_DIR,
    CT_LOCAL_BOOTSTRAP_TEST_DEV_VARS_FILE: devVarsFile,
  };
  if (globalFile !== undefined) {
    pathOverrides.CT_LOCAL_BOOTSTRAP_TEST_GLOBAL_KEYS_FILE = globalFile;
  }
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    ...(cwd ? { cwd } : {}),
    env: cleanEnv({
      ...pathOverrides,
      ...env,
    }),
  });
}

function writeKeys(path, contents, mode = 0o600) {
  writeFileSync(path, contents, { encoding: 'utf8', mode });
  chmodSync(path, mode);
}

function parseWithWranglerDotenv(contents) {
  const parsed = {};
  const normalized = contents.replace(/\r\n?/gm, '\n');
  WRANGLER_DOTENV_16_3_1_LINE.lastIndex = 0;
  for (const match of normalized.matchAll(WRANGLER_DOTENV_16_3_1_LINE)) {
    let value = (match[2] || '').trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, '\n');
      value = value.replace(/\\r/g, '\r');
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

describe('safe local Infisical bootstrap', () => {
  it('does not treat the current working directory as HOME when HOME is absent', () => {
    const dir = fixtureDir();
    const fakeCwd = resolve(dir, 'cwd');
    const devVarsFile = resolve(dir, '.dev.vars');
    mkdirSync(resolve(fakeCwd, '.secrets'), { recursive: true });
    writeKeys(
      resolve(fakeCwd, '.secrets/global-api-keys'),
      [
        'INFISICAL_CT_CLIENT_ID=cwd-client-must-not-load',
        'INFISICAL_CT_CLIENT_SECRET=cwd-secret-must-not-load',
        '',
      ].join('\n'),
    );

    const result = runBootstrap({
      globalFile: undefined,
      devVarsFile,
      cwd: fakeCwd,
      env: { HOME: '' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(devVarsFile)).toThrow();
    expect(`${result.stdout}${result.stderr}`).not.toContain('cwd-secret-must-not-load');
  });

  it('maps canonical CT and CT-shared identities and supplies project defaults', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(
      globalFile,
      [
        'INFISICAL_CT_CLIENT_ID: "ct-client-fixture"',
        'INFISICAL_CT_CLIENT_SECRET="ct-secret-fixture"',
        'INFISICAL_CT_SHARED_CLIENT_ID="shared-client-fixture"',
        'INFISICAL_CT_SHARED_CLIENT_SECRET="shared-secret-fixture"',
        'OPENAI_API_KEY="must-not-be-imported"',
        '',
      ].join('\n'),
    );

    const result = runBootstrap({
      globalFile,
      devVarsFile,
      env: { OPENAI_API_KEY: 'environment-provider-key-must-not-be-imported' },
    });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(devVarsFile, 'utf8');
    expect(output).toContain('INFISICAL_APP_PROJECT_ID="f61a79de-8d77-4f0b-9361-4b7208598290"');
    expect(output).toContain('INFISICAL_APP_CLIENT_ID="ct-client-fixture"');
    expect(output).toContain('INFISICAL_APP_CLIENT_SECRET="ct-secret-fixture"');
    expect(output).toContain('INFISICAL_SHARED_PROJECT_ID="18f563a3-9c88-454c-96eb-28fc9678f3ba"');
    expect(output).toContain('INFISICAL_SHARED_CLIENT_ID="shared-client-fixture"');
    expect(output).toContain('INFISICAL_SHARED_CLIENT_SECRET="shared-secret-fixture"');
    expect(output).not.toContain('INFISICAL_CT_');
    expect(output).not.toContain('OPENAI_API_KEY');
    expect(output).not.toContain('environment-provider-key-must-not-be-imported');
    expect(lstatSync(devVarsFile).mode & 0o777).toBe(0o600);
    expect(`${result.stdout}${result.stderr}`).not.toContain('ct-secret-fixture');
    expect(`${result.stdout}${result.stderr}`).not.toContain('shared-secret-fixture');
  });

  it('round-trips imported quotes, backslashes, literal escapes, and tabs through Wrangler dotenv', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    const clientId = String.raw`client\path\nliteral\"quoted` + '\tactual-tab';
    const clientSecret = String.raw`secret'\branch\rliteral` + '\t"quoted"';
    const projectId = ['project', "'", '"', '`', 'mixed'].join('');
    writeKeys(
      globalFile,
      [
        `INFISICAL_CT_CLIENT_ID='${clientId}'`,
        `INFISICAL_CT_CLIENT_SECRET=\`${clientSecret}\``,
        `INFISICAL_CT_PROJECT_ID=${projectId}`,
        '',
      ].join('\n'),
    );

    const wranglerPackage = JSON.parse(
      readFileSync(resolve(APP_DIR, 'node_modules/wrangler/package.json'), 'utf8'),
    );
    expect(wranglerPackage.devDependencies.dotenv).toBe('16.3.1');

    const result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    const parsed = parseWithWranglerDotenv(readFileSync(devVarsFile, 'utf8'));
    expect(parsed.INFISICAL_APP_CLIENT_ID).toBe(clientId);
    expect(parsed.INFISICAL_APP_CLIENT_SECRET).toBe(clientSecret);
    expect(parsed.INFISICAL_APP_PROJECT_ID).toBe(projectId);
    expect(lstatSync(devVarsFile).mode & 0o777).toBe(0o600);
    expect(`${result.stdout}${result.stderr}`).not.toContain(clientSecret);
  });

  it('uses Wrangler escaped-quote semantics instead of backslash parity for managed values', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    const source = [
      String.raw`INFISICAL_CT_CLIENT_ID="client\\"quoted"`,
      'INFISICAL_CT_CLIENT_SECRET="fixture-secret"',
      '',
    ].join('\n');
    writeKeys(globalFile, source);
    const expected = parseWithWranglerDotenv(source).INFISICAL_CT_CLIENT_ID;

    const result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    const parsed = parseWithWranglerDotenv(readFileSync(devVarsFile, 'utf8'));
    expect(parsed.INFISICAL_APP_CLIENT_ID).toBe(expected);
    expect(`${result.stdout}${result.stderr}`).not.toContain('fixture-secret');
  });

  it('fails closed when an imported value has no lossless single-line dotenv form', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'missing-global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    const unrepresentable = [' leading', "'", '"', '`', '#trailing '].join('');

    const result = runBootstrap({
      globalFile,
      devVarsFile,
      env: {
        INFISICAL_APP_CLIENT_ID: unrepresentable,
        INFISICAL_APP_CLIENT_SECRET: 'representable-secret',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'local dev variable INFISICAL_APP_CLIENT_ID cannot be represented losslessly',
    );
    expect(result.stderr).not.toContain(unrepresentable);
    expect(() => readFileSync(devVarsFile)).toThrow();
  });

  it('accepts the shared machine identity names already present in the global file', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(
      globalFile,
      [
        'INFISICAL_SHARED_CLIENT_ID=shared-client-generic',
        'INFISICAL_SHARED_CLIENT_SECRET=shared-secret-generic',
        '',
      ].join('\n'),
    );

    const result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(devVarsFile, 'utf8');
    expect(output).toContain('INFISICAL_SHARED_CLIENT_ID="shared-client-generic"');
    expect(output).toContain('INFISICAL_SHARED_CLIENT_SECRET="shared-secret-generic"');
    expect(output).toContain('INFISICAL_SHARED_PROJECT_ID="18f563a3-9c88-454c-96eb-28fc9678f3ba"');
  });

  it('retains only the documented early-init and local selectors from explicit env', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'missing-global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');

    const result = runBootstrap({
      globalFile,
      devVarsFile,
      env: {
        SENTRY_DSN: 'https://public@example.invalid/1',
        SENTRY_ENVIRONMENT: 'development',
        SENTRY_TRACES_SAMPLE_RATE: '0.1',
        ADMIN_OPEN_IN_DEV: 'true',
        USAGE_MONITOR_ENVIRONMENT: 'local',
        OPENAI_API_KEY: 'provider-key-must-stay-out',
        PRICE_PROVIDER: 'provider-selector-must-stay-out',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(devVarsFile, 'utf8');
    expect(output).toContain('SENTRY_DSN="https://public@example.invalid/1"');
    expect(output).toContain('SENTRY_ENVIRONMENT="development"');
    expect(output).toContain('SENTRY_TRACES_SAMPLE_RATE="0.1"');
    expect(output).toContain('ADMIN_OPEN_IN_DEV="true"');
    expect(output).toContain('USAGE_MONITOR_ENVIRONMENT="local"');
    expect(output).not.toContain('OPENAI_API_KEY');
    expect(output).not.toContain('PRICE_PROVIDER');
    expect(output).not.toContain('provider-key-must-stay-out');
    expect(lstatSync(devVarsFile).mode & 0o777).toBe(0o600);
  });

  it('prefers explicit runtime-name environment overrides over canonical file aliases', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(
      globalFile,
      [
        'INFISICAL_CT_CLIENT_ID=file-client',
        'INFISICAL_CT_CLIENT_SECRET=file-secret',
        '',
      ].join('\n'),
    );

    const result = runBootstrap({
      globalFile,
      devVarsFile,
      env: {
        INFISICAL_APP_PROJECT_ID: 'explicit-project',
        INFISICAL_APP_CLIENT_ID: 'explicit-client',
        INFISICAL_APP_CLIENT_SECRET: 'explicit-secret',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(devVarsFile, 'utf8');
    expect(output).toContain('INFISICAL_APP_PROJECT_ID="explicit-project"');
    expect(output).toContain('INFISICAL_APP_CLIENT_ID="explicit-client"');
    expect(output).toContain('INFISICAL_APP_CLIENT_SECRET="explicit-secret"');
    expect(output).not.toContain('file-client');
    expect(output).not.toContain('file-secret');
  });

  it('preserves non-empty .dev.vars values and fills only empty placeholders', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(
      globalFile,
      [
        'INFISICAL_CT_CLIENT_ID=file-client',
        'INFISICAL_CT_CLIENT_SECRET=file-secret',
        '',
      ].join('\n'),
    );
    writeKeys(
      devVarsFile,
      [
        'INFISICAL_APP_PROJECT_ID=""',
        'INFISICAL_APP_CLIENT_ID="existing-client"',
        'INFISICAL_APP_CLIENT_SECRET="existing-secret"',
        '',
      ].join('\n'),
      0o640,
    );

    const result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(devVarsFile, 'utf8');
    expect(output).toContain('INFISICAL_APP_PROJECT_ID="f61a79de-8d77-4f0b-9361-4b7208598290"');
    expect(output).toContain('INFISICAL_APP_CLIENT_ID="existing-client"');
    expect(output).toContain('INFISICAL_APP_CLIENT_SECRET="existing-secret"');
    expect(output).not.toContain('file-client');
    expect(output).not.toContain('file-secret');
    expect(lstatSync(devVarsFile).mode & 0o777).toBe(0o600);
  });

  it('replaces an empty managed assignment after a comment and blank line at its actual source line', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(
      globalFile,
      [
        'INFISICAL_CT_CLIENT_ID=file-client',
        'INFISICAL_CT_CLIENT_SECRET=file-secret',
        '',
      ].join('\n'),
    );
    writeKeys(
      devVarsFile,
      [
        '# preserve this comment and the following blank line',
        '',
        'INFISICAL_APP_PROJECT_ID=""',
        'UNRELATED=keep',
        '',
      ].join('\n'),
    );

    let result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(devVarsFile, 'utf8');
    expect(output).toContain(
      '# preserve this comment and the following blank line\n\n' +
        'INFISICAL_APP_PROJECT_ID="f61a79de-8d77-4f0b-9361-4b7208598290"\n',
    );
    expect(output).toContain('UNRELATED=keep\n');
    expect(output.match(/^INFISICAL_APP_PROJECT_ID=/gm)).toHaveLength(1);
    expect(parseWithWranglerDotenv(output).INFISICAL_APP_PROJECT_ID).toBe(
      'f61a79de-8d77-4f0b-9361-4b7208598290',
    );

    result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(devVarsFile, 'utf8')).toBe(output);
  });

  it('parses only managed .dev.vars keys and byte-preserves unrelated dotenv content', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(
      globalFile,
      [
        'INFISICAL_CT_CLIENT_ID=file-client',
        'INFISICAL_CT_CLIENT_SECRET=file-secret',
        '',
      ].join('\n'),
    );
    const unrelated = [
      'UNRELATED_INLINE=`literal # keep`',
      'UNRELATED_COLON: "colon line one',
      'INFISICAL_APP_CLIENT_ID=must-remain-unparsed-colon',
      'colon line three"',
      String.raw`UNRELATED_EVEN_BACKSLASHES="slash line one \\"`,
      'INFISICAL_SHARED_CLIENT_SECRET=must-remain-unparsed-even-backslashes',
      'slash line three"',
      'UNRELATED_MULTILINE=`line one',
      'INFISICAL_APP_CLIENT_ID=must-remain-unparsed',
      'line three`',
      'lowercase-unrelated=`lower line one',
      'INFISICAL_SHARED_CLIENT_ID=must-remain-unparsed-lowercase',
      'lower line three`',
      'dotted.unrelated=`dotted line one',
      'INFISICAL_SHARED_CLIENT_SECRET=must-remain-unparsed-dotted',
      'dotted line three`',
      'UNRELATED_COMMENT=bare value # keep this comment',
      '',
    ].join('\r\n');
    writeKeys(devVarsFile, `${unrelated}INFISICAL_APP_PROJECT_ID: \r\n`);

    const result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(devVarsFile, 'utf8');
    expect(output.startsWith(unrelated)).toBe(true);
    expect(output).toContain('INFISICAL_APP_CLIENT_ID=must-remain-unparsed\r\n');
    expect(output).toContain(
      'INFISICAL_APP_CLIENT_ID=must-remain-unparsed-colon\r\n',
    );
    expect(output).toContain(
      'INFISICAL_SHARED_CLIENT_SECRET=must-remain-unparsed-even-backslashes\r\n',
    );
    expect(output).toContain(
      'INFISICAL_SHARED_CLIENT_ID=must-remain-unparsed-lowercase\r\n',
    );
    expect(output).toContain(
      'INFISICAL_SHARED_CLIENT_SECRET=must-remain-unparsed-dotted\r\n',
    );
    expect(output).toContain('UNRELATED_COMMENT=bare value # keep this comment\r\n');
    expect(output).toContain('INFISICAL_APP_PROJECT_ID="f61a79de-8d77-4f0b-9361-4b7208598290"\r\n');
    expect(output).toContain('INFISICAL_APP_CLIENT_ID="file-client"\r\n');
    expect(output).toContain('INFISICAL_APP_CLIENT_SECRET="file-secret"\r\n');
  });

  it('ignores generic ambient path variables even in the explicit test harness', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    const redirectedFile = resolve(dir, 'must-not-be-written');
    writeKeys(
      globalFile,
      'INFISICAL_CT_CLIENT_ID="fixture-client"\nINFISICAL_CT_CLIENT_SECRET="fixture-secret"\n',
    );

    const result = runBootstrap({
      globalFile,
      devVarsFile,
      env: {
        APP_DIR: resolve(dir, 'ambient-app'),
        DEV_VARS_FILE: redirectedFile,
        GLOBAL_API_KEYS_FILE: resolve(dir, 'ambient-global-keys'),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(devVarsFile, 'utf8')).toContain(
      'INFISICAL_APP_CLIENT_ID="fixture-client"',
    );
    expect(() => readFileSync(redirectedFile)).toThrow();
  });

  it('fails closed on incomplete pairs without creating .dev.vars or leaking values', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(globalFile, 'INFISICAL_CT_CLIENT_ID="partial-client-fixture"\n');

    const result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('INFISICAL_CT_CLIENT_ID and INFISICAL_CT_CLIENT_SECRET');
    expect(result.stderr).not.toContain('partial-client-fixture');
    expect(() => readFileSync(devVarsFile)).toThrow();
  });

  it('rejects insecure or symlinked global key files', () => {
    const dir = fixtureDir();
    const insecureFile = resolve(dir, 'insecure-keys');
    const symlinkFile = resolve(dir, 'linked-keys');
    const brokenSymlinkFile = resolve(dir, 'broken-linked-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    writeKeys(insecureFile, 'INFISICAL_CT_CLIENT_ID=x\nINFISICAL_CT_CLIENT_SECRET=y\n', 0o644);

    let result = runBootstrap({ globalFile: insecureFile, devVarsFile });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not be readable or writable by group/other');

    symlinkSync(resolve(dir, 'missing-keys-target'), brokenSymlinkFile);
    result = runBootstrap({ globalFile: brokenSymlinkFile, devVarsFile });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('regular, non-symlink file');

    chmodSync(insecureFile, 0o600);
    symlinkSync(insecureFile, symlinkFile);
    result = runBootstrap({ globalFile: symlinkFile, devVarsFile });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('regular, non-symlink file');
  });

  it('rejects live and broken .dev.vars symlinks instead of following or ignoring them', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'missing-global-api-keys');
    const liveTarget = resolve(dir, 'real-dev-vars');
    writeKeys(liveTarget, 'INFISICAL_APP_CLIENT_ID="must-not-be-read"\n');

    for (const [name, target] of [
      ['live-dev-vars-link', liveTarget],
      ['broken-dev-vars-link', resolve(dir, 'missing-dev-vars-target')],
    ]) {
      const devVarsFile = resolve(dir, name);
      symlinkSync(target, devVarsFile);
      const result = runBootstrap({ globalFile, devVarsFile });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('app/.dev.vars must be a regular, non-symlink file');
      expect(result.stderr).not.toContain('must-not-be-read');
    }
  });

  it('parses assignments as inert data rather than executing shell syntax', () => {
    const dir = fixtureDir();
    const globalFile = resolve(dir, 'global-api-keys');
    const devVarsFile = resolve(dir, '.dev.vars');
    const marker = resolve(dir, 'must-not-exist');
    writeKeys(
      globalFile,
      [
        `INFISICAL_CT_CLIENT_ID="$(touch ${marker})"`,
        'INFISICAL_CT_CLIENT_SECRET="literal-secret"',
        '',
      ].join('\n'),
    );

    const result = runBootstrap({ globalFile, devVarsFile });
    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(readFileSync(devVarsFile, 'utf8')).toContain('$(touch ');
    expect(`${result.stdout}${result.stderr}`).not.toContain('literal-secret');
  });
});
