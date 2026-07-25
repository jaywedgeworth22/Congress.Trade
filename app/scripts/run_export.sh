#!/bin/bash
set -e
export INFISICAL_TOKEN=$(infisical login --method=universal-auth --client-id=***REMOVED*** --client-secret=***REMOVED*** --silent --plain)
infisical export --projectId f61a79de-8d77-4f0b-9361-4b7208598290 --env prod --format dotenv-export > .env.prod
source .env.prod
deno run -A scripts/export_trades.ts
