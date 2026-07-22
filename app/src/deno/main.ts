/// <reference lib="deno.unstable" />
import { createClient } from 'npm:@libsql/client/web';
import { S3Client } from 'npm:@aws-sdk/client-s3';
import { D1DatabaseShim, KVNamespaceShim, QueueShim, S3BucketShim } from './shims.ts';
import app from '../index.ts';
import type { Env, QueueMessage } from '../shared/types.ts';
import { resolveSecret, refreshSecrets } from '../secrets/infisical.ts';
import { handleIngestMessage, handleDeliveryMessage, handleDeadLetterMessage } from '../index.ts';
import { flushD1Budget } from '../shared/d1Budget.ts';
import { maybeRunDailyJobs } from '../jobs.ts';
import { runWatcher } from '../ingestion/watcher.ts';
import { isTerminalUsageTelemetryDeliveryError, persistUsageTelemetryFallback } from '../shared/thirdPartyTelemetry.ts';
import { completeDeliveryOutbox, flushDeliveryOutbox } from '../delivery/outbox.ts';
import { completeIngestionOutbox, flushIngestionOutbox } from '../ingestion/outbox.ts';

// 1. Initialize KV Shims first because Infisical needs CONFIG_KV for caching
const kv = await Deno.openKv();
const configKvShim = new KVNamespaceShim(kv, 'config');
const ingestQueueShim = new QueueShim(kv, 'ingest');
const deliveryQueueShim = new QueueShim(kv, 'delivery');

// Helper to construct the base Env object (without DB and RAW_FILES)
function buildBaseEnv(): Env {
  const envObj: any = {};
  for (const key of Object.keys(Deno.env.toObject())) {
    envObj[key] = Deno.env.get(key);
  }
  return {
    ...envObj,
    CONFIG_KV: configKvShim as any,
    INGEST_QUEUE: ingestQueueShim as any,
    DELIVERY_QUEUE: deliveryQueueShim as any,
  } as Env;
}

const baseEnv = buildBaseEnv();

// 2. Resolve Infisical secrets at boot
await refreshSecrets(baseEnv);
const tursoUrlRes = await resolveSecret(baseEnv, 'TURSO_DATABASE_URL');
const tursoTokenRes = await resolveSecret(baseEnv, 'TURSO_AUTH_TOKEN');

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

const awsS3EndpointRes = await resolveSecret(baseEnv, 'AWS_S3_ENDPOINT');
const awsAccessKeyIdRes = await resolveSecret(baseEnv, 'AWS_ACCESS_KEY_ID');
const awsSecretAccessKeyRes = await resolveSecret(baseEnv, 'AWS_SECRET_ACCESS_KEY');
const awsS3BucketNameRes = await resolveSecret(baseEnv, 'AWS_S3_BUCKET_NAME');
const awsRegionRes = await resolveSecret(baseEnv, 'AWS_REGION');

const awsS3Endpoint = awsS3EndpointRes.value || Deno.env.get('AWS_S3_ENDPOINT');
const awsAccessKeyId = awsAccessKeyIdRes.value || Deno.env.get('AWS_ACCESS_KEY_ID') || '';
const awsSecretAccessKey = awsSecretAccessKeyRes.value || Deno.env.get('AWS_SECRET_ACCESS_KEY') || '';
const awsS3BucketName = awsS3BucketNameRes.value || Deno.env.get('AWS_S3_BUCKET_NAME') || 'congress-trade';
const awsRegion = awsRegionRes.value || Deno.env.get('AWS_REGION') || 'us-east-1';

// 4. Initialize S3 (R2) Shim
const s3Client = new S3Client({
  region: awsRegion,
  endpoint: awsS3Endpoint,
  credentials: {
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey,
  },
});
const s3Shim = new S3BucketShim(s3Client, awsS3BucketName);

// Helper to construct the FULL Env object
function buildEnv(): Env {
  const env = buildBaseEnv();
  env.DB = dbShim as any;
  env.RAW_FILES = s3Shim as any;
  return env;
}

// Start Queue Listener
kv.listenQueue(async (msg: any) => {
  const env = buildEnv();
  const queueName = msg.queue || 'ingest'; // Fallback
  
  const isDeadLetterQueue = queueName.endsWith('-dlq');
  const isDelivery = queueName.includes('delivery');
  
  const dummyMessage = {
    body: msg.body,
    attempts: 1,
    ack: () => {},
    retry: () => {
      console.error("Retry not fully implemented in Deno queue shim yet");
    }
  };
  
  try {
    if (isDeadLetterQueue) {
      await handleDeadLetterMessage(env, queueName, dummyMessage.body as QueueMessage, dummyMessage.attempts);
    } else if (isDelivery) {
      const shouldComplete = await handleDeliveryMessage(env, dummyMessage.body as QueueMessage);
      if (shouldComplete && (dummyMessage.body as QueueMessage).type === 'delivery.dispatch') {
        await completeDeliveryOutbox(env, (dummyMessage.body as any).txId);
      }
    } else {
      await handleIngestMessage(env, dummyMessage.body as QueueMessage, dummyMessage.attempts);
      if ((dummyMessage.body as QueueMessage).type === 'filing.new') {
        await completeIngestionOutbox(env, (dummyMessage.body as any).docId);
      }
    }
    dummyMessage.ack();
  } catch (err) {
    console.error(`Queue ${queueName} message failed:`, err);
    dummyMessage.retry();
  }
  
  await flushD1Budget(env);
});

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
