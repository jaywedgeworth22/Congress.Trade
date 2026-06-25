#!/usr/bin/env bash
# deploy-preview.sh — deploy the current checkout to the isolated preview Worker.
#
# Requires app/wrangler.preview.toml from scripts/provision-preview.sh.
# Does not deploy congress.trade.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="wrangler.preview.toml"
if [ ! -f "$CONFIG" ]; then
  echo "$CONFIG is missing. Run: bash scripts/provision-preview.sh"
  exit 1
fi

npm run typecheck
npm test
npx wrangler deploy --config "$CONFIG"
