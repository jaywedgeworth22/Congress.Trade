import { resolveSecret } from "./app/src/secrets/infisical.ts";

const secretEnv = {
  INFISICAL_CLIENT_ID: "0be350b7-598a-4ac8-8497-81dc3c53ec44",
  INFISICAL_CLIENT_SECRET: "1cb5dda1d8704005394065ff9902353c266f3554b95fcc8b3ad1a64a615acbb5",
  INFISICAL_PROJECT_ID: "0be350b7-598a-4ac8-8497-81dc3c53ec44",
  INFISICAL_ENVIRONMENT: "prod",
} as any;

const res = await resolveSecret(secretEnv, 'SENTRY_DSN');
console.log("SENTRY_DSN in Infisical:", res.value);
