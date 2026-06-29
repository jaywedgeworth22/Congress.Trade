#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_SYNC_KEYS = [
  'ADMIN_TOKEN',
  'INGEST_TOKEN',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ARBITRATION_API_KEY',
  'FMP_API_KEY',
  'FMP_DAILY_CALL_CAP',
  'WEBHOOK_SIGNING_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'ALERT_EMAIL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_TRIAL_DAYS',
];

const DEFAULT_REQUIRED_KEYS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/infisical-bridge.mjs check [options]
  node scripts/infisical-bridge.mjs cloudflare [options]
  node scripts/infisical-bridge.mjs dev [options] -- [command]

Options:
  --env=<dev|staging|prod>          Infisical environment (default: dev)
  --project-id=<id>                 Infisical congress-trade project id
  --shared-project-id=<id>          Optional shared-at-ct project id
  --token=<token>                   Infisical service/machine token
  --keys=A,B,C                      Keys to sync/check
  --required=A,B,C                  Keys that must exist (default: Google OAuth)
  --config=<path>                   Wrangler config for cloudflare command
  --bridge-config=<path>            Local bridge config (default: .infisical-bridge.json)
  --dry-run                         Show key names that would sync

Environment:
  INFISICAL_ENV
  INFISICAL_PROJECT_ID
  INFISICAL_SHARED_PROJECT_ID
  INFISICAL_TOKEN
  INFISICAL_BRIDGE_KEYS
  INFISICAL_REQUIRED_KEYS
  WRANGLER_CONFIG
`);
  process.exit(exitCode);
}

function readBridgeConfig(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseArgs(argv) {
  if (argv[2] === '--help' || argv[2] === '-h') usage(0);
  const args = { command: argv[2], rest: [] };
  let passthrough = false;
  for (const arg of argv.slice(3)) {
    if (passthrough) {
      args.rest.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      console.error(`Unknown argument: ${arg}`);
      usage(1);
    }
    args[match[1].replaceAll('-', '_')] = match[2];
  }
  return args;
}

function splitList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    input: options.input,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout;
}

function exportInfisical({ env, projectId, token }) {
  if (!projectId) return {};
  const infisicalArgs = [
    'export',
    '--silent',
    `--env=${env}`,
    '--format=json',
    `--projectId=${projectId}`,
  ];
  if (token) infisicalArgs.push(`--token=${token}`);
  const output = run('infisical', infisicalArgs);
  const parsed = JSON.parse(output || '{}');
  if (Array.isArray(parsed)) {
    return Object.fromEntries(
      parsed
        .map((entry) => ({
          key: entry?.key ?? entry?.secretKey ?? entry?.name,
          value: entry?.value ?? entry?.secretValue ?? '',
        }))
        .filter((entry) => typeof entry.key === 'string')
        .map((entry) => [entry.key, entry.value]),
    );
  }
  return parsed;
}

function resolveSecrets({ env, projectId, sharedProjectId, token }) {
  const shared = exportInfisical({ env, projectId: sharedProjectId, token });
  const app = exportInfisical({ env, projectId, token });
  return { ...shared, ...app };
}

function assertRequired(secrets, requiredKeys) {
  const missing = requiredKeys.filter((key) => !String(secrets[key] ?? '').trim());
  if (missing.length) {
    throw new Error(`Missing required Infisical secrets: ${missing.join(', ')}`);
  }
}

function selectedSecrets(secrets, keys) {
  return keys
    .filter((key) => String(secrets[key] ?? '').trim())
    .map((key) => [key, String(secrets[key])]);
}

function putCloudflareSecret(key, value, wranglerConfig) {
  const args = ['wrangler', 'secret', 'put', key];
  if (wranglerConfig) args.push('--config', wranglerConfig);
  run('npx', args, { input: `${value}\n` });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.command || !['check', 'cloudflare', 'dev'].includes(args.command)) usage(1);
  const config = readBridgeConfig(args.bridge_config || process.env.INFISICAL_BRIDGE_CONFIG || '.infisical-bridge.json');

  const env = args.env || process.env.INFISICAL_ENV || config.env || 'dev';
  const projectId = args.project_id || process.env.INFISICAL_PROJECT_ID || config.projectId;
  const sharedProjectId =
    args.shared_project_id || process.env.INFISICAL_SHARED_PROJECT_ID || config.sharedProjectId;
  const token = args.token || process.env.INFISICAL_TOKEN || config.token;
  const keys = splitList(args.keys || process.env.INFISICAL_BRIDGE_KEYS, config.keys || DEFAULT_SYNC_KEYS);
  const requiredKeys = splitList(
    args.required || process.env.INFISICAL_REQUIRED_KEYS,
    config.requiredKeys || DEFAULT_REQUIRED_KEYS,
  );
  const wranglerConfig = args.config || process.env.WRANGLER_CONFIG || config.wranglerConfig || 'wrangler.toml';

  if (!projectId && args.command !== 'dev') {
    throw new Error('INFISICAL_PROJECT_ID is required for check/cloudflare');
  }

  if (args.command === 'dev') {
    const command = args.rest.length ? args.rest : ['wrangler', 'dev'];
    const runArgs = ['run', '--silent', `--env=${env}`];
    if (projectId) runArgs.push(`--projectId=${projectId}`);
    if (token) runArgs.push(`--token=${token}`);
    runArgs.push('--', ...command);
    const result = spawnSync('infisical', runArgs, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }

  const secrets = resolveSecrets({ env, projectId, sharedProjectId, token });
  assertRequired(secrets, requiredKeys);
  const entries = selectedSecrets(secrets, keys);

  if (args.command === 'check' || args.dryRun) {
    console.log(`Infisical ${env}: ${entries.length} configured key(s) found.`);
    for (const [key] of entries) console.log(`- ${key}`);
    if (args.command === 'check') return;
  }

  for (const [key, value] of entries) {
    console.log(`Syncing ${key} -> Cloudflare Worker secret`);
    putCloudflareSecret(key, value, wranglerConfig);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
