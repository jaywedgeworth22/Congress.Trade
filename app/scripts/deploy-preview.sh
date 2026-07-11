#!/usr/bin/env bash
# deploy-preview.sh — deploy the current checkout to the isolated preview Worker.
#
# Auto-runs scripts/provision-preview.sh if app/wrangler.preview.toml is missing.
# Does not deploy congress.trade.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="wrangler.preview.toml"
if [ ! -f "$CONFIG" ] \
  || ! grep -q 'global_fetch_strictly_public' "$CONFIG" \
  || ! grep -q 'queue = "congress-feed-preview-ingest-dlq"' "$CONFIG" \
  || ! grep -q 'queue = "congress-feed-preview-delivery-dlq"' "$CONFIG"; then
  echo "$CONFIG is missing or stale; provisioning/refreshing isolated preview resources first."
  bash scripts/provision-preview.sh
fi

npm run typecheck
npm test
npx wrangler d1 migrations apply DB --remote --config "$CONFIG"
npx wrangler d1 execute DB --remote --config "$CONFIG" --file scripts/seed-preview-fixtures.sql
npx wrangler deploy --config "$CONFIG"

PREVIEW_BASE="${PREVIEW_APP_BASE_URL:-$(sed -nE 's/^[[:space:]]*APP_BASE_URL[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$CONFIG" | tail -1)}"
if [ -z "$PREVIEW_BASE" ] || [[ "$PREVIEW_BASE" == *"<your-workers-subdomain>"* ]]; then
  echo "Could not determine preview APP_BASE_URL for /api/health. Set PREVIEW_APP_BASE_URL or rerun scripts/provision-preview.sh." >&2
  exit 1
fi

echo "==> Preview API health check"
HEALTH_BODY="$(curl -fsS "$PREVIEW_BASE/api/health")"
echo "$HEALTH_BODY"
if [[ "$HEALTH_BODY" != *'"ok":true'* || "$HEALTH_BODY" != *'"db":true'* ]]; then
  echo "Preview /api/health did not report ok=true and db=true." >&2
  exit 1
fi
echo
echo "Preview URL: $PREVIEW_BASE"
