/// <reference lib="deno.unstable" />
import { createClient } from 'npm:@libsql/client/web';
import { S3Client } from 'npm:@aws-sdk/client-s3';
import { D1DatabaseShim, KVNamespaceShim, QueueShim, R2BucketShim } from './shims.ts';
import worker from '../index.ts';
import type { Env } from '../shared/types.ts';
import { resolveSecret, refreshSecrets } from '../secrets/infisical.ts';

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

if (!tursoUrl) {
  console.warn("WARNING: TURSO_DATABASE_URL is missing after resolving secrets.");
}

// 3. Initialize Turso DB Shim
const libsqlClient = createClient({
  url: tursoUrl || 'libsql://dummy-url.turso.io', // Provide a valid dummy URL to prevent crash at boot
  authToken: tursoToken,
});
const dbShim = new D1DatabaseShim(libsqlClient);

// 4. Initialize S3 (R2) Shim
const s3Client = new S3Client({
  region: 'auto',
  endpoint: Deno.env.get('CF_R2_S3_ENDPOINT') || `https://${Deno.env.get('CF_R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: Deno.env.get('CF_R2_S3_ACCESS_KEY_ID') || '',
    secretAccessKey: Deno.env.get('CF_R2_S3_SECRET_ACCESS_KEY') || '',
  },
});
const r2Shim = new R2BucketShim(s3Client, Deno.env.get('R2_BUCKET_NAME') || 'congress-trade');

// Helper to construct the FULL Env object
function buildEnv(): Env {
  const env = buildBaseEnv();
  env.DB = dbShim as any;
  env.RAW_FILES = r2Shim as any;
  return env;
}

// Dummy context to satisfy Cloudflare signature
const dummyCtx = {
  waitUntil: (promise: Promise<any>) => {
    promise.catch(console.error);
  },
  passThroughOnException: () => {},
};

// Start Queue Listener
kv.listenQueue(async (msg: any) => {
  const env = buildEnv();
  const queueName = msg.queue || 'ingest'; // Fallback
  const batch = {
    queue: queueName,
    messages: [
      {
        body: msg.body,
        attempts: 1,
        ack: () => {},
        retry: () => {
          console.error("Retry not fully implemented in Deno queue shim yet");
        }
      }
    ]
  };
  await worker.queue(batch as any, env, dummyCtx as any);
});

// Start Cron Tasks
Deno.cron("Worker scheduled tasks", "* * * * *", async () => {
  const env = buildEnv();
  await worker.scheduled({} as any, env, dummyCtx as any);
});

// Start HTTP Server
Deno.serve(async (req) => {
  const env = buildEnv();
  return worker.fetch(req, env, dummyCtx as any);
});
