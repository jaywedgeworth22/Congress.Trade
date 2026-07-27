#!/bin/bash
set -e
export INFISICAL_TOKEN=$(infisical login --method=universal-auth --client-id=0be350b7-598a-4ac8-8497-81dc3c53ec44 --client-secret=1cb5dda1d8704005394065ff9902353c266f3554b95fcc8b3ad1a64a615acbb5 --silent --plain)
infisical export --projectId f61a79de-8d77-4f0b-9361-4b7208598290 --env prod --format dotenv-export > .env.prod
source .env.prod
deno run -A scripts/export_trades.ts
