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
WORKERS_DEV_HOST="${WORKERS_DEV_HOST:-}"
ADMIN_BASE="$BASE"
DEPLOY_ONLY=false
ADMIN_STEPS=()

# congress.trade sits behind a Cloudflare managed challenge that 403s requests
# with no browser User-Agent (e.g. a CI runner's or script's bare curl). Send a
# real browser UA on every request to the app — both the health check and the
# admin POST steps below — so a plain `ADMIN_TOKEN=... bash scripts/ship.sh`
# doesn't pass health and then 403 on /api/admin/migrate.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

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
  local health_url="${1:-$BASE/api/health}"
  local label="${2:-$BASE}"
  local attempts delay body_file body code i
  attempts="${DEPLOY_HEALTH_ATTEMPTS:-8}"
  delay="${DEPLOY_HEALTH_DELAY_SECONDS:-10}"
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' RETURN

  for ((i = 1; i <= attempts; i++)); do
    code="$(curl -sS -A "$UA" -o "$body_file" -w '%{http_code}' "$health_url" || true)"
    body="$(cat "$body_file")"
    if [[ "$code" == 2* && "$body" == *'"ok":true'* && "$body" == *'"db":true'* ]]; then
      echo "$body"
      return 0
    fi

    echo "   /api/health attempt $i/$attempts on $label failed (HTTP ${code:-curl-error})." >&2
    if [ "$i" -lt "$attempts" ]; then
      sleep "$delay"
    fi
  done

  echo "$body" >&2
  echo "!! /api/health on $label did not report ok=true and db=true after $attempts attempt(s)." >&2
  return 1
}

echo "==> Deploying"
npm run deploy

echo "==> Live API health check"
if check_api_health "$BASE/api/health" "$BASE"; then
  : # health check passed on primary domain
elif [ -n "$WORKERS_DEV_HOST" ]; then
  echo "   Primary health check failed. Retrying via workers.dev bypass: https://$WORKERS_DEV_HOST/api/health"
  if check_api_health "https://$WORKERS_DEV_HOST/api/health" "workers.dev"; then
    ADMIN_BASE="https://$WORKERS_DEV_HOST"
    echo "   Using workers.dev bypass for admin API calls."
  else
    echo "!! /api/health failed on workers.dev bypass as well." >&2
    exit 1
  fi
else
  echo "!! /api/health failed on $BASE. Set WORKERS_DEV_HOST to retry via workers.dev bypass." >&2
  exit 1
fi
echo

post() { # $1 = admin path, $2 = json body (optional)
  echo "==> POST /api/admin/$1"
  curl -fsS -A "$UA" -X POST "$ADMIN_BASE/api/admin/$1" \
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
