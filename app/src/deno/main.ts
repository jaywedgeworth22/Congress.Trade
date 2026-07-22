/// <reference lib="deno.unstable" />
import { createClient } from '@libsql/client/web';
import { S3Client } from '@aws-sdk/client-s3';
import { D1DatabaseShim, KVNamespaceShim, S3BucketShim } from './shims.ts';
import { DurableQueueAdapter, drainDurableQueues, type DurableQueueHandlers } from './durableQueue.ts';
import app from '../index.ts';
import type { Env, QueueMessage } from '../shared/types.ts';
import { resolveSecret, refreshSecrets } from '../secrets/infisical.ts';
import {
  handleCorruptDeadLetterMessage,
  handleDeadLetterMessage,
  handleDeliveryMessage,
  handleIngestMessage,
} from '../index.ts';
import { flushD1Budget } from '../shared/d1Budget.ts';
import { isTerminalUsageTelemetryDeliveryError } from '../shared/thirdPartyTelemetry.ts';
import { maybeRunDailyJobs } from '../jobs.ts';
import { runWatcher } from '../ingestion/watcher.ts';
import { completeDeliveryOutbox, flushDeliveryOutbox } from '../delivery/outbox.ts';
import { completeIngestionOutbox, flushIngestionOutbox } from '../ingestion/outbox.ts';

// 1. Initialize the KV namespace used for configuration and Infisical caching.
// Deno KV Connect does not support queues, so queue bindings are attached only
// after the Turso database has been resolved below.
const kv = await Deno.openKv();
const configKvShim = new KVNamespaceShim(kv, 'config');

function buildEnvironmentValues(): Record<string, string | undefined> {
  const envObj: any = {};
  for (const key of Object.keys(Deno.env.toObject())) {
    envObj[key] = Deno.env.get(key);
  }
  return envObj;
}

// Secret resolution only reads CONFIG_KV and environment values. Keep the
// unavailable runtime bindings out of this bootstrap object rather than
// presenting a producer that cannot durably enqueue yet.
const secretEnv = {
  ...buildEnvironmentValues(),
  CONFIG_KV: configKvShim as any,
} as Env;

// 2. Resolve Infisical secrets at boot
await refreshSecrets(secretEnv);
const tursoUrlRes = await resolveSecret(secretEnv, 'TURSO_DATABASE_URL');
const tursoTokenRes = await resolveSecret(secretEnv, 'TURSO_AUTH_TOKEN');

const tursoUrl = tursoUrlRes.value || Deno.env.get('TURSO_DATABASE_URL') || '';
const tursoToken = tursoTokenRes.value || Deno.env.get('TURSO_AUTH_TOKEN') || '';

if (!tursoUrl || tursoUrl.includes('dummy-url')) {
  console.warn("WARNING: TURSO_DATABASE_URL is missing after resolving secrets. The app is falling back to a dummy URL, which means database connections will fail. Ensure INFISICAL_APP_CLIENT_ID and INFISICAL_APP_CLIENT_SECRET are set in Deno Deploy.");
}

// 3. Initialize Turso DB Shim
const libsqlClient = createClient({
  url: tursoUrl || 'libsql://dummy-url.turso.io', // Provide a valid dummy URL to prevent crash at boot
  authToken: tursoToken,
});
const dbShim = new D1DatabaseShim(libsqlClient);
const durableQueueDb = dbShim as unknown as D1Database;
const ingestQueueShim = new DurableQueueAdapter<QueueMessage>(durableQueueDb, 'ingest');
const deliveryQueueShim = new DurableQueueAdapter<QueueMessage>(durableQueueDb, 'delivery');

const awsS3EndpointRes = await resolveSecret(secretEnv, 'AWS_S3_ENDPOINT');
const awsAccessKeyIdRes = await resolveSecret(secretEnv, 'AWS_ACCESS_KEY_ID');
const awsSecretAccessKeyRes = await resolveSecret(secretEnv, 'AWS_SECRET_ACCESS_KEY');
const awsS3BucketNameRes = await resolveSecret(secretEnv, 'AWS_S3_BUCKET_NAME');
const awsRegionRes = await resolveSecret(secretEnv, 'AWS_REGION');

// Prefer AWS_* Infisical keys; fall back to CF_R2_S3_* names used in operator
// secret stores so Deno prod can read the same R2 S3 API token without a rename.
const awsS3Endpoint = awsS3EndpointRes.value
  || Deno.env.get('AWS_S3_ENDPOINT')
  || Deno.env.get('CF_R2_S3_ENDPOINT')
  || Deno.env.get('CF_R2_S3_API')
  || undefined;
const awsAccessKeyId = awsAccessKeyIdRes.value
  || Deno.env.get('AWS_ACCESS_KEY_ID')
  || Deno.env.get('CF_R2_S3_ACCESS_KEY_ID')
  || '';
const awsSecretAccessKey = awsSecretAccessKeyRes.value
  || Deno.env.get('AWS_SECRET_ACCESS_KEY')
  || Deno.env.get('CF_R2_S3_SECRET_ACCESS_KEY')
  || '';
const awsS3BucketName = awsS3BucketNameRes.value
  || Deno.env.get('AWS_S3_BUCKET_NAME')
  || Deno.env.get('CF_R2_BUCKET_NAME')
  || 'congress-trade';
const awsRegion = awsRegionRes.value || Deno.env.get('AWS_REGION') || 'auto';

// 4. Initialize S3 (R2) Shim
const s3Client = new S3Client({
  region: awsRegion,
  endpoint: awsS3Endpoint,
  // Garage and R2 both support path-style S3 requests. Path style is required
  // for Garage because the Coolify TLS certificate covers the endpoint host,
  // not arbitrary bucket-name subdomains.
  forcePathStyle: true,
  credentials: {
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey,
  },
});
const s3Shim = new S3BucketShim(s3Client, awsS3BucketName);

// Helper to construct the FULL Env object
function buildEnv(): Env {
  return {
    ...buildEnvironmentValues(),
    CONFIG_KV: configKvShim as any,
    DB: dbShim as any,
    RAW_FILES: s3Shim as any,
    INGEST_QUEUE: ingestQueueShim as any,
    DELIVERY_QUEUE: deliveryQueueShim as any,
  } as Env;
}

const durableQueueHandlers: DurableQueueHandlers = {
  handleIngestMessage,
  handleDeliveryMessage,
  handleDeadLetterMessage,
  handleCorruptDeadLetterMessage,
  isTerminalDeadLetterError: (message, error) =>
    message.type === 'usage.telemetry'
    && isTerminalUsageTelemetryDeliveryError(error),
  completeIngestionOutbox,
  completeDeliveryOutbox,
};

// Start Cron Tasks. Deno Deploy does not run the Cloudflare Worker
// `scheduled()` entrypoint, so the live filing watcher and durable outbox
// reconciliations must be wired here explicitly. Without this, Deno serves
// the API and can execute daily enrichment while discovering no new filings.
Deno.cron("Worker scheduled tasks", "* * * * *", async () => {
  const env = buildEnv();
  try {
    const result = await runWatcher(env, new Date());
    console.log('Deno watcher completed', result);
  } catch (err) {
    // A scheduler tick must not prevent outbox recovery or daily maintenance.
    console.error('Deno watcher tick failed:', err);
  }
  try {
    await flushIngestionOutbox(env, { limit: 100 });
  } catch (err) {
    console.error('Deno ingestion outbox flush failed:', err);
  }
  try {
    await flushDeliveryOutbox(env, { limit: 100 });
  } catch (err) {
    console.error('Deno delivery outbox flush failed:', err);
  }
  try {
    const drained = await drainDurableQueues(env, durableQueueHandlers);
    if (drained.ingest.claimed > 0 || drained.delivery.claimed > 0) {
      console.log('Deno durable queues drained', drained);
    }
  } catch (err) {
    // Queue-state SQL errors must surface. The next cron tick can reclaim a
    // stale processing lease; producer INSERT failures already reject callers.
    console.error('Deno durable queue drain failed:', err);
  }
  try {
    await maybeRunDailyJobs(env);
  } catch (err) {
    console.error('Deno daily jobs failed:', err);
  }
  await flushD1Budget(env);
});

// Dummy context to satisfy Cloudflare signature
const dummyCtx = {
  waitUntil: (promise: Promise<any>) => {
    promise.catch(console.error);
  },
  passThroughOnException: () => {},
};

// Start HTTP Server
Deno.serve(async (req) => {
  const env = buildEnv();
  return app.fetch(req, env, dummyCtx as any);
});
