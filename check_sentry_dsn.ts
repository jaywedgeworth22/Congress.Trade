import { resolveSecret } from "./app/src/secrets/infisical.ts";

const secretEnv = {
  INFISICAL_CLIENT_ID: "***REMOVED***",
  INFISICAL_CLIENT_SECRET: "***REMOVED***",
  INFISICAL_PROJECT_ID: "***REMOVED***",
  INFISICAL_ENVIRONMENT: "prod",
} as any;

const res = await resolveSecret(secretEnv, 'SENTRY_DSN');
console.log("SENTRY_DSN in Infisical:", res.value);
