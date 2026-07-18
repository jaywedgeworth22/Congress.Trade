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
#   bash scripts/ship.sh --deploy-no-verify               # deploy (wrangler + sourcemaps) only,
#                                                          # NO liveness/health/migrate calls against
#                                                          # congress.trade. For runners without the
#                                                          # Cloudflare-allowlisted egress IP (e.g. a
#                                                          # GitHub-hosted CI runner). Pair with a later
#                                                          # --verify-only run from an allowlisted runner.
#   ADMIN_TOKEN=xxx bash scripts/ship.sh --verify-only    # migrate + health checks only, no redeploy.
#                                                          # For a lightweight follow-up job on the
#                                                          # allowlisted runner after --deploy-no-verify.
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
DEPLOY_NO_VERIFY=false
VERIFY_ONLY=false
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
       bash scripts/ship.sh --deploy-no-verify
       ADMIN_TOKEN=... bash scripts/ship.sh --verify-only [--enrich] [--backfill] [--house]

Default mode deploys, checks /health liveness, migrates, then checks /api/health readiness.
Use --deploy-only only when intentionally skipping admin post-deploy steps.
Use --deploy-no-verify to deploy the Worker (wrangler + sourcemaps) with NO liveness/health/
migrate calls against congress.trade at all — for runners without the Cloudflare-allowlisted
egress IP. Pair it with a later --verify-only run (from an allowlisted runner) to complete
migrate + health.
Use --verify-only to run liveness + migrate + health/readiness checks WITHOUT redeploying the
Worker — a lightweight follow-up to --deploy-no-verify on the allowlisted runner.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --deploy-only)
      DEPLOY_ONLY=true
      ;;
    --deploy-no-verify)
      DEPLOY_NO_VERIFY=true
      ;;
    --verify-only)
      VERIFY_ONLY=true
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

MODE_COUNT=0
[ "$DEPLOY_ONLY" = true ] && MODE_COUNT=$((MODE_COUNT + 1))
[ "$DEPLOY_NO_VERIFY" = true ] && MODE_COUNT=$((MODE_COUNT + 1))
[ "$VERIFY_ONLY" = true ] && MODE_COUNT=$((MODE_COUNT + 1))
if [ "$MODE_COUNT" -gt 1 ]; then
  echo "!! --deploy-only, --deploy-no-verify, and --verify-only are mutually exclusive." >&2
  exit 2
fi

if { [ "$DEPLOY_ONLY" = true ] || [ "$DEPLOY_NO_VERIFY" = true ]; } && [ "${#ADMIN_STEPS[@]}" -gt 0 ]; then
  echo "!! --deploy-only/--deploy-no-verify cannot be combined with admin steps." >&2
  exit 2
fi

if [ "$DEPLOY_ONLY" != true ] && [ "$DEPLOY_NO_VERIFY" != true ] && [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "!! ADMIN_TOKEN is required for production deploys that run /api/admin/migrate." >&2
  echo "   Set ADMIN_TOKEN=... or pass --deploy-only/--deploy-no-verify to explicitly skip admin post-deploy steps." >&2
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

check_liveness() {
  local base="$1"
  curl -fsS -A "$UA" "$base/health" | grep -q '"ok":true'
}

# Post-deploy smoke: fetch the served dashboard HTML (with a browser UA, same
# Cloudflare-challenge reason as above) and run `node --check` on every inline
# <script> block. Guards against shipping a dashboard whose embedded JS fails
# to parse in the browser (2026-07-12 outage: /health was green while the
# served page's inline script was syntactically broken).
check_dashboard_scripts() {
  local page_url="$1"
  local html_file
  html_file="$(mktemp)"
  trap 'rm -f "$html_file"' RETURN
  if ! curl -fsS -A "$UA" "$page_url" -o "$html_file"; then
    echo "!! Failed to fetch dashboard HTML from $page_url." >&2
    return 1
  fi
  node - "$html_file" <<'NODE_SMOKE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const html = fs.readFileSync(process.argv[2], 'utf8');
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let index = 0;
let checked = 0;
let match;
while ((match = scriptRe.exec(html)) !== null) {
  index++;
  const attrs = match[1];
  const body = match[2];
  if (/\bsrc\s*=/i.test(attrs)) continue; // external script — nothing inline to parse
  if (!body.trim()) continue; // empty block
  const tmp = path.join(os.tmpdir(), `ship-inline-script-${process.pid}-${index}.js`);
  fs.writeFileSync(tmp, body);
  const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) {
    console.error(`!! Inline <script> #${index} in served HTML failed to parse.`);
    console.error('   First lines of the failing block:');
    for (const line of body.split('\n').slice(0, 5)) console.error(`   | ${line}`);
    console.error((result.stderr || result.stdout || '').trim());
    process.exit(1);
  }
  checked++;
}
if (checked === 0) {
  console.error('!! No inline <script> blocks found in served HTML — dashboard markup looks wrong.');
  process.exit(1);
}
console.log(`   OK: ${checked} inline <script> block(s) parsed cleanly.`);
NODE_SMOKE
}

if [ "$VERIFY_ONLY" != true ]; then
  echo "==> Deploying"
  npm run deploy
else
  echo "==> Verify-only mode: Worker already deployed by a separate job; skipping npm run deploy."
fi

if [ "$DEPLOY_NO_VERIFY" = true ]; then
  echo "==> Deploy-no-verify mode: Worker deployed; skipped liveness/health/migrate checks against congress.trade."
  echo "   Run 'ADMIN_TOKEN=... bash scripts/ship.sh --verify-only' from a runner with the"
  echo "   Cloudflare-allowlisted egress IP to complete migrate + health verification."
  echo "==> Done."
  exit 0
fi

echo "==> Live Worker liveness check"
ADMIN_BASE="$BASE"
if check_liveness "$BASE"; then
  :
elif [ -n "$WORKERS_DEV_HOST" ]; then
  echo "   Primary liveness check failed. Retrying via workers.dev bypass: https://$WORKERS_DEV_HOST/health"
  if check_liveness "https://$WORKERS_DEV_HOST"; then
    ADMIN_BASE="https://$WORKERS_DEV_HOST"
    echo "   Using workers.dev bypass for admin API calls."
  else
    echo "!! /health failed on workers.dev bypass as well." >&2
    exit 1
  fi
else
  echo "!! /health failed on $BASE. Set WORKERS_DEV_HOST to retry via workers.dev bypass." >&2
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
  echo "==> Deploy-only mode: skipped /api/admin/migrate; verifying existing schema readiness."
  check_api_health "$ADMIN_BASE/api/health" "$ADMIN_BASE"
  echo "==> Served-HTML inline script parse smoke"
  check_dashboard_scripts "$ADMIN_BASE/"
  echo "==> Done."
  exit 0
fi

# Always ensure the schema is current (idempotent), via the Worker binding.
post migrate

echo "==> Live API readiness check"
check_api_health "$ADMIN_BASE/api/health" "$ADMIN_BASE"

echo "==> Served-HTML inline script parse smoke"
check_dashboard_scripts "$ADMIN_BASE/"

for arg in "${ADMIN_STEPS[@]}"; do
  case "$arg" in
    --enrich)   post enrich-photos ;;
    --backfill) post backfill '{"chambers":["senate"],"limit":20000}' ;;
    --house)    post house-backfill '{"fromYear":'"${HOUSE_FROM:-2024}"',"toYear":'"${HOUSE_TO:-2026}"',"maxFilings":'"${HOUSE_MAX:-500}"'}' ;;
  esac
done

echo "==> Done."
