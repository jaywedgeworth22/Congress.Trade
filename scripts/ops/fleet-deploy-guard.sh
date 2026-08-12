#!/usr/bin/env bash
# fleet-deploy-guard.sh — coalesce, rate-limit and serialize Coolify deploys
# for ONE app. Instantiated per app via fleet-deploy-guard@<app>.timer.
#
# Usage: fleet-deploy-guard.sh <app-key>
#   reads /etc/fleet-deploy-guard.d/<app-key>.env for APP_UUID / APP_NAME / HEALTH_URL
#   reads /etc/congress-health-recover.env for COOLIFY_TOKEN + PUSHOVER_* (shared)
#
# WHY THIS EXISTS (2026-08-10 .. 2026-08-12, all measured in production):
#   * Every push fires a Coolify webhook deploy. In one busy window that produced
#     NINE deploys in 47 minutes, several overlapping.
#   * Two overlapping deploys of one app can leave it with ZERO containers when
#     compose finishes its remove-phase and the start-phase never runs. That is
#     the 6h45m congress.trade outage on 2026-08-10.
#   * Serializing the server (concurrent_builds=1) fixed the overlap but made a
#     slow build block every OTHER app: on 2026-08-12 one congress-trade build
#     waited 65 minutes for its turn while 3 more CT deploys and 2 usage-monitor
#     deploys queued behind it.
#
# So each app needs its own guard. Previously only congress-trade had one, which
# is why the CT queue collapsed to zero while socratic-app and usage-monitor kept
# piling up.
#
# BEHAVIOUR, once per minute per app:
#   1. Read the GLOBAL in-flight deployment list and keep only this app's rows.
#      (The per-app history endpoint returns full logs inline and TIMES OUT once
#      an app accumulates a few hundred deployments — measured take=15 -> timeout
#      vs /api/v1/deployments -> 3.4s. It is also newest-first, so a smaller
#      take= would hide the RUNNING row and let the guard stack a second build on
#      a live one.)
#   2. Cancel every QUEUED deploy and remember that main is ahead. Coolify always
#      deploys branch HEAD, so one later deploy delivers the newest commit and N
#      queued merges collapse into ONE build. Safe while a build runs: a queued
#      deploy has not started and owns no containers.
#   3. Trigger that single deploy at most once per MIN_DEPLOY_INTERVAL_SEC, and
#      never while a build for this app is in flight.
#   4. EXCEPT when the app is actually down — recovery ignores the rate limit.
#
# Secrets are read from files and passed via a 0600 header file; never logged.

set -uo pipefail

APP_KEY="${1:?usage: fleet-deploy-guard.sh <app-key>}"

CONF="/etc/fleet-deploy-guard.d/${APP_KEY}.env"
SHARED_ENV="${SHARED_ENV:-/etc/congress-health-recover.env}"
# shellcheck disable=SC1090
[[ -r "$SHARED_ENV" ]] && { set -a; . "$SHARED_ENV"; set +a; }
# shellcheck disable=SC1090
if [[ -r "$CONF" ]]; then set -a; . "$CONF"; set +a; else
  echo "fleet-deploy-guard: missing config $CONF" >&2; exit 1
fi

: "${APP_UUID:?APP_UUID required in $CONF}"
: "${APP_NAME:?APP_NAME required in $CONF}"
HEALTH_URL="${HEALTH_URL:-}"
COOLIFY_BASE_URL="${COOLIFY_BASE_URL:-https://host.jays.services}"
MIN_DEPLOY_INTERVAL_SEC="${MIN_DEPLOY_INTERVAL_SEC:-1800}"
SELF_GRACE_SEC="${SELF_GRACE_SEC:-600}"
STATE_DIR="${STATE_DIR:-/var/lib/fleet-deploy-guard/${APP_KEY}}"
LOCK_FILE="${LOCK_FILE:-/var/lock/fleet-deploy-guard-${APP_KEY}.lock}"
LOG_TAG="${LOG_TAG:-fleet-deploy-guard-${APP_KEY}}"

mkdir -p "$STATE_DIR"
PENDING_FILE="$STATE_DIR/pending_since"
LAST_DEPLOY_FILE="$STATE_DIR/last_deploy"
LAST_DEPLOY_UUID_FILE="$STATE_DIR/last_deploy_uuid"
NOTIFY_FILE="$STATE_DIR/last_notify"

log() {
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APP_KEY" "$*"
  command -v logger >/dev/null 2>&1 && logger -t "$LOG_TAG" -- "$*" || true
}
now() { date +%s; }

notify() {
  [[ -z "${PUSHOVER_APP_TOKEN:-}" || -z "${PUSHOVER_USER_KEY:-}" ]] && return 0
  local last=0
  [[ -f "$NOTIFY_FILE" ]] && last=$(cat "$NOTIFY_FILE" 2>/dev/null || echo 0)
  [[ $(( $(now) - last )) -lt 3600 ]] && return 0
  now > "$NOTIFY_FILE"
  curl -sS -m 15 -o /dev/null \
    --form-string "token=${PUSHOVER_APP_TOKEN}" \
    --form-string "user=${PUSHOVER_USER_KEY}" \
    --form-string "title=${APP_NAME} deploy guard" \
    --form-string "message=$1" \
    --form-string "priority=1" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 || true
}

exec 9>"$LOCK_FILE" || { log "cannot open lock"; exit 1; }
flock -n 9 || { log "another guard run in progress; exiting"; exit 0; }

if [[ -z "${COOLIFY_TOKEN:-}" ]]; then
  log "COOLIFY_TOKEN missing (${SHARED_ENV}) — cannot manage deploys"
  notify "Deploy guard cannot run: COOLIFY_TOKEN missing on the host."
  exit 1
fi

HDR_FILE=$(mktemp) || exit 1
trap 'rm -f "$HDR_FILE"' EXIT
chmod 600 "$HDR_FILE"
printf 'Authorization: Bearer %s\n' "$COOLIFY_TOKEN" > "$HDR_FILE"

api() {
  local method="$1" path="$2"
  curl -sS -m 45 -X "$method" -H @"$HDR_FILE" -H 'Accept: application/json' \
    "${COOLIFY_BASE_URL%/}${path}" 2>/dev/null
}

app_is_down() {
  [[ -z "$HEALTH_URL" ]] && return 1   # no health probe configured: never claim down
  local code
  code=$(curl -sS -m 12 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)
  [[ "$code" != "200" ]]
}

DEPLOYS_JSON=$(api GET "/api/v1/deployments")
if [[ -z "$DEPLOYS_JSON" ]]; then
  log "could not read deployments (API unreachable)"
  exit 1
fi

read -r RUNNING QUEUED_UUIDS QUEUED_FORCE <<<"$(printf '%s' "$DEPLOYS_JSON" \
  | APP_UUID="$APP_UUID" APP_NAME="$APP_NAME" python3 -c '
import json,os,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print("ERR - 0"); raise SystemExit
rows = d if isinstance(d,list) else d.get("data", d.get("deployments", []))
if not isinstance(rows,list):
    print("ERR - 0"); raise SystemExit
uuid=os.environ.get("APP_UUID",""); name=os.environ.get("APP_NAME","")
def mine(x):
    return (x.get("application_id")==uuid or x.get("application_uuid")==uuid
            or x.get("application_name")==name)
ds=[x for x in rows if mine(x)]
running=[x for x in ds if x.get("status") in ("in_progress","building","running")]
queued=[x for x in ds if x.get("status")=="queued"]
queued.sort(key=lambda x: x.get("created_at",""))
force=1 if any(x.get("force_rebuild") for x in queued) else 0
print(len(running), ",".join(x["deployment_uuid"] for x in queued) or "-", force)
')"

if [[ "$RUNNING" == "ERR" ]]; then
  log "could not parse deployments payload"
  exit 1
fi

RUNNING_NOW=0
if [[ "${RUNNING:-0}" -gt 0 ]]; then
  RUNNING_NOW=1
  log "deploy in progress (${RUNNING}); will coalesce the queue but not trigger"
fi

# --- coalesce queued deploys ----------------------------------------------
if [[ "$QUEUED_UUIDS" != "-" && -n "$QUEUED_UUIDS" ]]; then
  IFS=',' read -r -a QU_ALL <<<"$QUEUED_UUIDS"

  OWN_UUID=""
  [[ -f "$LAST_DEPLOY_UUID_FILE" ]] && OWN_UUID=$(cat "$LAST_DEPLOY_UUID_FILE" 2>/dev/null || echo "")
  OWN_TS=0
  [[ -f "$LAST_DEPLOY_FILE" ]] && OWN_TS=$(cat "$LAST_DEPLOY_FILE" 2>/dev/null || echo 0)

  if [[ -n "$OWN_UUID" && $(( $(now) - OWN_TS )) -lt "$SELF_GRACE_SEC" ]]; then
    QU=()
    for u in "${QU_ALL[@]}"; do [[ "$u" == "$OWN_UUID" ]] && continue; QU+=("$u"); done
    [[ "${#QU[@]}" -lt "${#QU_ALL[@]}" ]] && \
      log "leaving our own queued deploy ${OWN_UUID:0:8} alone (within ${SELF_GRACE_SEC}s grace)"
  else
    QU=("${QU_ALL[@]}")
  fi

  if [[ "${#QU[@]}" -eq 0 ]]; then
    log "only our own deploy is queued; nothing to coalesce"
  else
    log "coalescing ${#QU[@]} queued deploy(s) into one"
    cancel_failed=0
    for u in "${QU[@]}"; do
      out=$(api POST "/api/v1/deployments/${u}/cancel")
      [[ -z "$out" ]] && out=$(api DELETE "/api/v1/deployments/${u}")
      if [[ -z "$out" ]]; then log "warn: could not cancel queued deploy ${u:0:8}"; cancel_failed=1; fi
    done
    if [[ "$cancel_failed" -eq 1 ]]; then
      log "cancellation incomplete; letting Coolify drain the queue serially"
      exit 0
    fi
    [[ -f "$PENDING_FILE" ]] || now > "$PENDING_FILE"
    [[ "${QUEUED_FORCE:-0}" == "1" ]] && now > "$STATE_DIR/pending_force"
  fi
fi

[[ -f "$PENDING_FILE" ]] || exit 0

if [[ "$RUNNING_NOW" -eq 1 ]]; then
  log "main is ahead; holding trigger until the in-flight build finishes"
  exit 0
fi

PENDING_SINCE=$(cat "$PENDING_FILE" 2>/dev/null || echo 0)
LAST_DEPLOY=0
[[ -f "$LAST_DEPLOY_FILE" ]] && LAST_DEPLOY=$(cat "$LAST_DEPLOY_FILE" 2>/dev/null || echo 0)
AGE=$(( $(now) - LAST_DEPLOY ))

if app_is_down; then
  REASON="app down — bypassing rate limit"
elif [[ "$AGE" -ge "$MIN_DEPLOY_INTERVAL_SEC" ]]; then
  REASON="rate-limit window elapsed (${AGE}s >= ${MIN_DEPLOY_INTERVAL_SEC}s)"
else
  WAIT=$(( MIN_DEPLOY_INTERVAL_SEC - AGE ))
  log "main is ahead; holding ${WAIT}s more (pending $(( $(now) - PENDING_SINCE ))s)"
  if [[ $(( $(now) - PENDING_SINCE )) -gt $(( MIN_DEPLOY_INTERVAL_SEC * 3 )) ]]; then
    notify "Deploy pending $(( ($(now) - PENDING_SINCE) / 60 ))min without shipping. Guard may be stuck."
  fi
  exit 0
fi

FORCE_FLAG=false
[[ -f "$STATE_DIR/pending_force" ]] && { FORCE_FLAG=true; log "honouring a force-rebuild request from a coalesced deploy"; }

log "deploying latest main (force=${FORCE_FLAG}): $REASON"
RESP=$(api GET "/api/v1/deploy?uuid=${APP_UUID}&force=${FORCE_FLAG}")
if printf '%s' "$RESP" | grep -q 'deployment_uuid'; then
  now > "$LAST_DEPLOY_FILE"
  printf '%s' "$RESP" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
ds=d.get("deployments") if isinstance(d,dict) else None
if isinstance(ds,list) and ds: print(ds[0].get("deployment_uuid",""), end="")
elif isinstance(d,dict): print(d.get("deployment_uuid",""), end="")
' > "$LAST_DEPLOY_UUID_FILE" 2>/dev/null || : > "$LAST_DEPLOY_UUID_FILE"
  rm -f "$PENDING_FILE" "$STATE_DIR/pending_force"
  log "deploy queued OK (uuid $(cut -c1-8 < "$LAST_DEPLOY_UUID_FILE" 2>/dev/null))"
else
  log "deploy trigger FAILED"
  notify "Deploy guard could not trigger a deploy via the Coolify API."
  exit 1
fi
