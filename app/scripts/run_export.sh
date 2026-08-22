#!/bin/bash
set -e
export INFISICAL_TOKEN=$(infisical login --method=universal-auth --client-id="${INFISICAL_APP_CLIENT_ID}" --client-secret="${INFISICAL_APP_CLIENT_SECRET}" --silent --plain)
infisical export --projectId "${INFISICAL_APP_PROJECT_ID}" --env "${INFISICAL_ENV:-prod}" --format dotenv-export > .env.prod
source .env.prod
deno run -A scripts/export_trades.ts
