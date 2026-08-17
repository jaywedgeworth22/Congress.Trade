#!/bin/bash
# Offline tests for #1537 overlap + Traefik render.
# No Docker, no Coolify, no network.
#
#   bash scripts/ops/test-deploy-overlap.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REATTACH="${ROOT}/scripts/ops/ct-reattach-proxy.sh"
OVERLAP="${ROOT}/scripts/ops/ct-deploy-overlap.sh"
fail=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL ${name}: got '${got}' want '${want}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_contains() {
  local hay="$1" needle="$2" name="$3"
  if ! printf '%s' "$hay" | grep -qF "$needle"; then
    echo "FAIL ${name}: missing '${needle}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_not_contains() {
  local hay="$1" needle="$2" name="$3"
  if printf '%s' "$hay" | grep -qF "$needle"; then
    echo "FAIL ${name}: unexpectedly contains '${needle}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

# --- decide table ----------------------------------------------------------
decide() {
  DEPLOY_ACTIVE="$1" BUILDER_ACTIVE="$2" APP_RUNNING="$3" HOLD_RUNNING="$4" \
    APP_HEALTHY="$5" OVERLAP_EARLY="$6" HAVE_IMAGE="$7" \
    bash "$OVERLAP" --decide
}

assert_eq "$(decide 1 1 1 0 1 0 1)" "noop" "wait while builder still running"
assert_eq "$(decide 1 0 1 0 1 0 1)" "start-hold" "start hold after builder exits"
assert_eq "$(decide 1 1 1 0 1 1 1)" "start-hold" "early start during build"
assert_eq "$(decide 1 0 0 0 0 0 1)" "start-hold" "late start from remembered image"
assert_eq "$(decide 1 0 0 0 0 0 0)" "noop" "cannot start without image"
assert_eq "$(decide 1 0 1 1 1 0 1)" "keep-hold" "hold already up during deploy"
assert_eq "$(decide 0 0 1 1 1 0 1)" "stop-hold" "drop hold once replacement is healthy"
assert_eq "$(decide 0 0 1 1 0 0 1)" "keep-hold" "keep hold while new app is not healthy"
assert_eq "$(decide 0 0 0 1 0 0 1)" "keep-hold" "keep hold in the zero-container gap"
assert_eq "$(decide 0 0 1 0 1 0 1)" "noop" "steady state"

# --- Coolify deployments parse --------------------------------------------
parse_ok() {
  printf '%s' "$1" | APP_UUID=c11c5hdhuczureb6w2pg20p0 bash "$OVERLAP" --parse-active
}

if parse_ok '{"0":{"application_uuid":"c11c5hdhuczureb6w2pg20p0","status":"in_progress"}}'; then
  echo "ok   parse in_progress object"
else
  echo "FAIL parse in_progress object"
  fail=1
fi

if parse_ok '{"data":[{"application_name":"congress-trade","status":"queued"}]}'; then
  echo "ok   parse queued by name"
else
  echo "FAIL parse queued by name"
  fail=1
fi

if parse_ok '{"0":{"application_uuid":"other","status":"in_progress"}}'; then
  echo "FAIL parse other app should be inactive"
  fail=1
else
  echo "ok   parse ignores other apps"
fi

# --- Traefik render --------------------------------------------------------
plain="$(bash "$REATTACH" --render plain)"
hold="$(bash "$REATTACH" --render hold)"
standby="$(bash "$REATTACH" --render standby)"
both="$(bash "$REATTACH" --render both)"

assert_contains "$plain" 'url: "http://congress-app:5000"' "plain points at congress-app"
assert_not_contains "$plain" "healthCheck:" "plain has no health check"
assert_not_contains "$plain" "failover:" "plain has no failover"
assert_not_contains "$plain" "no available server" "render is not the catch-all"

assert_contains "$hold" "fallback: congress-hold" "hold failover target"
assert_contains "$hold" "url: \"http://congress-hold:5000\"" "hold server url"
assert_contains "$hold" "path: /health" "hold probes /health not /api/health"
assert_not_contains "$hold" "/api/health" "hold must not probe /api/health"
assert_contains "$hold" "service: congress-front" "hold routers use failover service"

assert_contains "$standby" "fallback: congress-standby" "standby failover target"
assert_contains "$standby" "url: \"http://congress-standby:8080\"" "standby server url"

assert_contains "$both" "fallback: congress-hold" "both prefers hold over standby"
assert_not_contains "$both" "fallback: congress-standby" "both does not use standby"

# Catch-all shape that produces the owner-visible error string must never
# be what we write.  Coolify's default_redirect_503.yaml is `servers: { }`.
assert_not_contains "$plain" "servers: { }" "plain is not an empty LB"
assert_not_contains "$hold" "servers: { }" "hold is not an empty LB"
assert_not_contains "$standby" "servers: { }" "standby is not an empty LB"

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED"
  exit 1
fi
echo "PASSED"
exit 0
