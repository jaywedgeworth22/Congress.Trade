#!/usr/bin/env bash
# ship.sh — one-command production deploy for Congress.Trade.
#
# Deploys the Worker (uses your saved `wrangler login` — no API key needed),
# then applies schema + optional data steps through the Worker's own database
# binding via the admin API. This deliberately AVOIDS `wrangler d1 ... --remote`,
# which has OAuth auth issues on this account; the Worker binding works fine.
#
#   ADMIN_TOKEN=xxx bash scripts/ship.sh                  # deploy + ensure schema
#   bash scripts/ship.sh --deploy-only                    # deploy + health only
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --enrich         # + repopulate photos
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --backfill       # + reload senate history
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --house          # + crawl recent House PTRs
#     (bounded by default to 2024-2026, maxFilings=500; override with
#      HOUSE_FROM / HOUSE_TO / HOUSE_MAX env vars)
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-https://congress.trade}"
DEPLOY_ONLY=false
ADMIN_STEPS=()

usage() {
  cat <<'EOF'
Usage: ADMIN_TOKEN=... bash scripts/ship.sh [--enrich] [--backfill] [--house]
       bash scripts/ship.sh --deploy-only

Default mode deploys, checks /api/health, then calls POST /api/admin/migrate.
Use --deploy-only only when intentionally skipping admin post-deploy steps.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --deploy-only)
      DEPLOY_ONLY=true
      ;;
    --enrich|--backfill|--house)
      ADMIN_STEPS+=("$arg")
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$DEPLOY_ONLY" = true ] && [ "${#ADMIN_STEPS[@]}" -gt 0 ]; then
  echo "!! --deploy-only cannot be combined with admin steps." >&2
  exit 2
fi

if [ "$DEPLOY_ONLY" != true ] && [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "!! ADMIN_TOKEN is required for production deploys that run /api/admin/migrate." >&2
  echo "   Set ADMIN_TOKEN=... or pass --deploy-only to explicitly skip admin post-deploy steps." >&2
  exit 1
fi

check_api_health() {
  local body
  body="$(curl -fsS "$BASE/api/health")"
  echo "$body"
  if [[ "$body" != *'"ok":true'* || "$body" != *'"db":true'* ]]; then
    echo "!! /api/health did not report ok=true and db=true." >&2
    exit 1
  fi
}

echo "==> Deploying"
npm run deploy

echo "==> Live API health check"
check_api_health
echo

post() { # $1 = admin path, $2 = json body (optional)
  echo "==> POST /api/admin/$1"
  curl -fsS -X POST "$BASE/api/admin/$1" \
    -H "authorization: Bearer $ADMIN_TOKEN" \
    -H "content-type: application/json" -d "${2:-{}}" && echo
}

if [ "$DEPLOY_ONLY" = true ]; then
  echo "==> Deploy-only mode: skipped /api/admin/migrate and other admin steps."
  echo "==> Done."
  exit 0
fi

# Always ensure the schema is current (idempotent), via the Worker binding.
post migrate

for arg in "${ADMIN_STEPS[@]}"; do
  case "$arg" in
    --enrich)   post enrich-photos ;;
    --backfill) post backfill '{"chambers":["senate"],"limit":20000}' ;;
    --house)    post house-backfill '{"fromYear":'"${HOUSE_FROM:-2024}"',"toYear":'"${HOUSE_TO:-2026}"',"maxFilings":'"${HOUSE_MAX:-500}"'}' ;;
  esac
done

echo "==> Done."
