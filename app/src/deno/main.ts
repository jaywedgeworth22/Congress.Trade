/// <reference lib="deno.unstable" />
import { createClient } from '@libsql/client';
import { S3Client } from '@aws-sdk/client-s3';
import { D1DatabaseShim, KVNamespaceShim, S3BucketShim } from './shims.ts';
import { DurableQueueAdapter } from './durableQueue.ts';
import app from '../index.ts';
import type { Env, QueueMessage } from '../shared/types.ts';
import { resolveSecret, refreshSecrets } from '../secrets/infisical.ts';
import { resolveDenoCostProfile } from './costProfile.ts';
import { createRuntimeQueueHandlers } from './runtimeHandlers.ts';
import { runScheduledTick } from './scheduledTick.ts';
import { registerDailyLaneCrons, resolveDailyLaneDeadlineMs } from './cronLanes.ts';

// 1. Initialize the KV namespace used for configuration and Infisical caching.
// Deno KV Connect does not support queues, so queue bindings are attached only
// after the Turso database has been resolved below.
let tursoDbShim: D1DatabaseShim | null = null;
const kvPath = Deno.env.get('DENO_KV_PATH') || undefined;
const kv = await Deno.openKv(kvPath);
const configKvShim = new KVNamespaceShim(kv, 'config', () => tursoDbShim);

function buildEnvironmentValues(): Record<string, string | undefined> {
  const envObj: Record<string, string | undefined> = {};
  const paths = ['.prod.vars', './.prod.vars', 'app/.prod.vars', '/app/.prod.vars'];
  for (const p of paths) {
    try {
      const text = Deno.readTextFileSync(p);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (k && v && !envObj[k]) envObj[k] = v;
        }
      }
      if (Object.keys(envObj).length > 0) break;
    } catch {}
  }
  for (const key of Object.keys(Deno.env.toObject())) {
    const v = Deno.env.get(key);
    if (v) envObj[key] = v;
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
tursoDbShim = dbShim;
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

const durableQueueHandlers = createRuntimeQueueHandlers();
const costProfile = resolveDenoCostProfile(Deno.env);

// Start Cron Tasks. Deno Deploy does not run the Cloudflare Worker
// `scheduled()` entrypoint, so the live filing watcher and durable outbox
// reconciliations must be wired here explicitly — unless an external
// scheduler owns ticks (DENO_DISABLE_INTERNAL_CRON=true → Coolify/GH Actions
// call POST /api/admin/runtime-tick). Default profile is free (every 5 min,
// tiny drain batches) so we survive free-tier after Aug 1.
// In-isolate overlap guard: Deno.cron does not wait for a slow previous tick,
// so without this a >5-minute tick would stack watcher/outbox work in the same
// isolate. Cross-isolate overlap (cron vs POST /api/admin/runtime-tick) is
// covered by the DB-backed singleton inside runScheduledTick.
let tickInFlight = false;

if (!costProfile.disableInternalCron) {
  console.log(
    `Deno cost profile=${costProfile.name} cron="${costProfile.cronSchedule}" ` +
      `drainLimit=${costProfile.drainLimit} claimSize=${costProfile.drainClaimSize}`,
  );
  Deno.cron('Worker scheduled tasks', costProfile.cronSchedule, async () => {
    if (tickInFlight) {
      console.warn('Deno cron tick skipped: previous tick still running');
      return;
    }
    tickInFlight = true;
    // The 45s deadline now aborts the tick pipeline instead of abandoning it:
    // lanes stop at the next boundary and the queue drain stops claiming.
    const tickAbort = new AbortController();
    try {
      const env = buildEnv();
      const tickPromise = runScheduledTick(
        env,
        durableQueueHandlers,
        costProfile,
        new Date(),
        // Daily work moved to dedicated staggered lane crons (cronLanes.ts)
        // with multi-minute deadlines; the 45s tick must not run or starve it.
        { signal: tickAbort.signal, includeDailyJobs: false },
      );
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          tickAbort.abort(new Error('Deno cron tick exceeded 45s deadline'));
          reject(new Error('Deno cron tick exceeded 45s deadline'));
        }, 45_000);
      });

      try {
        const result = await Promise.race([tickPromise, timeoutPromise]);
        if (result.skippedOverlap) {
          console.log('Deno tick skipped: another tick holds the singleton lock');
        } else if (result.aborted) {
          console.warn('Deno tick aborted before completing all lanes', {
            errors: result.errors,
          });
        } else if (result.skippedDrain) {
          console.log('Deno tick idle (skipped outbox/queue drain)', {
            profile: result.profile,
            watcher: result.watcher,
          });
        } else if (result.watcher) {
          console.log('Deno watcher completed', result.watcher);
        }
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    } catch (err) {
      console.error('Deno cron tick caught error:', err);
    } finally {
      tickInFlight = false;
    }
  });

  // Staggered daily lane crons: market data (enrichment/prices) → bulk R2
  // snapshot → filer (photos/bioguide/ticker backfill) → retention sweeps.
  // Each lane has its own hourly window, KV date stamp, singleton lock, and
  // multi-minute deadline, so a slow provider lane can no longer starve the
  // lanes behind it (the old single-stamp chain died at the tick's 45s).
  registerDailyLaneCrons(buildEnv, resolveDailyLaneDeadlineMs(Deno.env));
} else {
  console.log(
    'Deno internal cron disabled (DENO_DISABLE_INTERNAL_CRON); ' +
      'drive background work via POST /api/admin/runtime-tick',
  );
}

// Dummy context to satisfy Cloudflare signature
const dummyCtx = {
  waitUntil: (promise: Promise<any>) => {
    promise.catch(console.error);
  },
  passThroughOnException: () => {},
};

// Start HTTP Server
const portStr = Deno.env.get('PORT');
const port = portStr ? parseInt(portStr, 10) : 5000;
Deno.serve({ port }, async (req) => {
  const env = buildEnv();
  return app.fetch(req, env, dummyCtx as any);
});
