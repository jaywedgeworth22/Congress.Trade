#!/usr/bin/env bash
# smoke-wave4.sh — Wave-4 go-live smoke probe for auth + Stripe paywall
#
# Probes the production API endpoints related to user auth and billing
# entitlement and prints a PASS/FAIL checklist. Exits 0 if all checks pass,
# exits 1 if any probe fails.
#
#   BASE=https://congress.trade bash scripts/smoke-wave4.sh
#   ADMIN_TOKEN=xxx bash scripts/smoke-wave4.sh   # (reserved for future admin probes)
#
# Uses a browser User-Agent to bypass the Cloudflare managed challenge that
# blocks bare curl UA strings (same approach as ship.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-https://congress.trade}"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m' # No Color

FAILURES=0
CHECKS=0

pass()  { printf "  ${GREEN}PASS${NC}  %s\n" "$1"; CHECKS=$((CHECKS + 1)); }
fail()  { printf "  ${RED}FAIL${NC}  %s\n" "$1"; shift; for line in "$@"; do printf "        %s\n" "$line"; done; CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); }

# probe <label> <method> <path> <http-code-check> <body-check-regex> [json-body]
# http-code-check: "2xx" = any 2xx, "3xx" = any 3xx, "200" = exact 200, etc.
# body-check-regex: extended regex (grep -E) that must match the response body.
probe() {
  local label="$1" method="$2" path="$3" code_check="$4" body_re="$5"
  local json_body="${6:-}"
  local body_file code body

  body_file="$(mktemp)"
  if [ -n "$json_body" ]; then
    code="$(curl -sS -A "$UA" -X "$method" -H "Content-Type: application/json" -d "$json_body" -o "$body_file" -w '%{http_code}' --max-time 10 "$BASE$path" 2>/dev/null || true)"
  else
    code="$(curl -sS -A "$UA" -X "$method" -o "$body_file" -w '%{http_code}' --max-time 10 "$BASE$path" 2>/dev/null || true)"
  fi
  body="$(cat "$body_file" 2>/dev/null || true)"
  rm -f "$body_file"

  # Truncate body for display (keep first 200 chars)
  local body_short="${body:0:200}"

  # Check status code
  local code_ok=false
  case "$code_check" in
    2xx) [[ "$code" == 2* ]] && code_ok=true ;;
    3xx) [[ "$code" == 3* ]] && code_ok=true ;;
    *)   [[ "$code" == "$code_check" ]] && code_ok=true ;;
  esac

  if [ "$code_ok" != true ]; then
    fail "${BOLD}${method} ${path}${NC}" \
      "expected HTTP ${code_check}, got HTTP ${code}" \
      "body: ${body_short}"
    return
  fi

  # Check body content
  if [ -n "$body_re" ]; then
    if echo "$body" | grep -qE "$body_re"; then
      pass "${BOLD}${method} ${path}${NC}"
    else
      fail "${BOLD}${method} ${path}${NC}" \
        "HTTP ${code} but body did not match /${body_re}/" \
        "body: ${body_short}"
    fi
  else
    pass "${BOLD}${method} ${path}${NC}"
  fi
}

echo "================================================"
echo " Wave-4 Go-Live Smoke Probe"
echo " BASE=${BASE}"
echo "================================================"
echo ""

# --- 1. Health check --------------------------------------------------------
echo "--- Health ---"
probe "basic health + DB connectivity" \
  GET "/api/health" \
  "200" \
  '"ok":true.*"db":true'
echo ""

# --- 2. Auth /me (identity + entitlement) ------------------------------------
echo "--- Auth ---"
# When not signed in, /auth/me returns 200 with user:null and entitlement:"free".
# This tests that the auth router is mounted and responding.
probe "auth identity probe (unauthenticated)" \
  GET "/auth/me" \
  "200" \
  '"user".*"entitlement"'
echo ""

# --- 3. Billing status (Stripe paywall configured) ---------------------------
echo "--- Billing ---"
# When Stripe is wired, this returns {"configured":true,"entitlement":"free",...}.
# When NOT wired, it returns {"configured":false,...} — this is the key Wave-4 go-live check.
probe "Stripe billing status" \
  GET "/billing/status" \
  "200" \
  '"configured":true'
echo ""

# --- 4. Google OAuth redirect ------------------------------------------------
echo "--- OAuth ---"
# When GOOGLE_OAUTH_CLIENT_ID is configured, /auth/google/start returns a 302
# redirect to Google's consent screen. When NOT configured, returns 503.
probe "Google OAuth redirect" \
  GET "/auth/google/start" \
  "3xx" \
  ""
echo ""

# --- 5. Magic link request ---------------------------------------------------
echo "--- Magic Link ---"
probe "Magic link request" \
  POST "/auth/magic/request" \
  "200" \
  '"ok":true.*"sent":(true|false)' \
  '{"email":"test@example.com"}'
echo ""

# --- 6. Checkout round-trip (unauthenticated) --------------------------------
echo "--- Checkout ---"
# We expect a 401 because we are unauthenticated.
probe "Checkout requires auth" \
  POST "/billing/checkout" \
  "401" \
  '"needLogin":true'
echo ""

# --- Summary ----------------------------------------------------------------
echo "================================================"
if [ "$FAILURES" -eq 0 ]; then
  echo -e " ${GREEN}All ${CHECKS} checks passed.${NC}"
  echo " Wave-4 auth + paywall endpoints are live."
  echo "================================================"
  exit 0
else
  echo -e " ${RED}${FAILURES}/${CHECKS} checks failed.${NC}"
  if grep -q '"configured":false' <(curl -sS -A "$UA" "$BASE/billing/status" 2>/dev/null || true) 2>/dev/null; then
    echo ""
    echo " NOTE: /billing/status returned configured:false."
    echo " Stripe secret may not be set (STRIPE_SECRET_KEY via wrangler secret put)."
    echo " Check that STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, and STRIPE_PRICE_ANNUAL"
    echo " are present in both wrangler.toml [vars] and production secrets."
  fi
  echo "================================================"
  exit 1
fi
