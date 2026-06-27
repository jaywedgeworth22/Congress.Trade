#!/usr/bin/env bash
# ship.sh — one-command production deploy for Congress.Trade.
#
# Deploys the Worker (uses your saved `wrangler login` — no API key needed),
# then applies schema + optional data steps through the Worker's own database
# binding via the admin API. This deliberately AVOIDS `wrangler d1 ... --remote`,
# which has OAuth auth issues on this account; the Worker binding works fine.
#
#   bash scripts/ship.sh                                  # deploy + ensure schema
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --enrich         # + repopulate photos
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --backfill       # + reload senate history
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --house          # + crawl recent House PTRs
#     (bounded by default to 2024-2026, maxFilings=500; override with
#      HOUSE_FROM / HOUSE_TO / HOUSE_MAX env vars)
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="https://congress.trade"

echo "==> Deploying"
npm run deploy

echo "==> Live check"
curl -s "$BASE/health" && echo

post() { # $1 = admin path, $2 = json body (optional)
  if [ -z "${ADMIN_TOKEN:-}" ]; then
    echo "!! ADMIN_TOKEN not set — skipping /$1 (run: ADMIN_TOKEN=xxx bash scripts/ship.sh $*)"
    return 0
  fi
  echo "==> POST /api/admin/$1"
  curl -s -X POST "$BASE/api/admin/$1" \
    -H "authorization: Bearer $ADMIN_TOKEN" \
    -H "content-type: application/json" -d "${2:-{}}" && echo
}

# Always ensure the schema is current (idempotent), via the Worker binding.
post migrate

for arg in "$@"; do
  case "$arg" in
    --enrich)   post enrich-photos ;;
    --backfill) post backfill '{"chambers":["senate"],"limit":20000}' ;;
    --house)    post house-backfill '{"fromYear":'"${HOUSE_FROM:-2024}"',"toYear":'"${HOUSE_TO:-2026}"',"maxFilings":'"${HOUSE_MAX:-500}"'}' ;;
  esac
done

echo "==> Done."
