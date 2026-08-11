#!/usr/bin/env bash
# ct-deploy-guard.sh — coalesce, rate-limit and serialize Coolify deploys of
# congress-trade.
#
# WHY (2026-08-10 incident):
#   Every push to main fires a Coolify webhook deploy. During a busy merge
#   window that produced NINE deploys in 47 minutes, several overlapping
#   (server allowed concurrent_builds=2). Each deploy tears down and recreates
#   containers, so every one is a brief outage; overlapping deploys can strand
#   the app with ZERO containers when compose finishes its remove-phase and the
#   start-phase never runs (seen 2026-08-10 ~02:30 by MONET and again ~10:37,
#   the latter a 6h45m outage).
#
# WHAT THIS DOES, once a minute:
#   1. If a deploy is actually running, do nothing (never stack on top).
#   2. If deploys are QUEUED, cancel them all and remember that main is ahead.
#      Coolify always deploys branch HEAD, so one later deploy delivers the
#      newest commit -- N queued merges collapse into ONE deploy.
#   3. Trigger that single deploy only once per MIN_DEPLOY_INTERVAL_SEC.
#   4. EXCEPT when the site is actually down: recovery ignores the rate limit.
#
# Serialization has two layers: this script's flock (only one guard at a time)
# and the Coolify server setting concurrent_builds=1 (set 2026-08-11; keep it
# at 1 -- at 2 the same app can deploy twice at once, which is what stranded
# the containers).
#
# Install:
#   install -m 0755 scripts/ops/ct-deploy-guard.sh /usr/local/bin/
#   install -m 0644 scripts/ops/ct-deploy-guard.service /etc/systemd/system/
#   install -m 0644 scripts/ops/ct-deploy-guard.timer   /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now ct-deploy-guard.timer
#
# Credentials come from /etc/congress-health-recover.env (COOLIFY_TOKEN,
# PUSHOVER_*). Values are never logged.

set -uo pipefail

ENV_FILE="${ENV_FILE:-/etc/congress-health-recover.env}"
# shellcheck disable=SC1090
[[ -r "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }

APP_UUID="${APP_UUID:-c11c5hdhuczureb6w2pg20p0}"
COOLIFY_BASE_URL="${COOLIFY_BASE_URL:-https://host.jays.services}"
HEALTH_URL="${HEALTH_URL:-https://congress.trade/api/health}"
MIN_DEPLOY_INTERVAL_SEC="${MIN_DEPLOY_INTERVAL_SEC:-1800}"
STATE_DIR="${STATE_DIR:-/var/lib/ct-deploy-guard}"
LOCK_FILE="${LOCK_FILE:-/var/lock/ct-deploy-guard.lock}"
LOG_TAG="${LOG_TAG:-ct-deploy-guard}"
STUCK_ALERT_MULTIPLIER="${STUCK_ALERT_MULTIPLIER:-3}"

mkdir -p "$STATE_DIR"
PENDING_FILE="$STATE_DIR/pending_since"
LAST_DEPLOY_FILE="$STATE_DIR/last_deploy"
LAST_DEPLOY_UUID_FILE="$STATE_DIR/last_deploy_uuid"
NOTIFY_FILE="$STATE_DIR/last_notify"
# A deploy we just triggered sits "queued" for a moment before Coolify starts
# it. Without this grace the next tick would cancel our OWN deploy and then
# hold for a full interval, so nothing would ever ship.
SELF_GRACE_SEC="${SELF_GRACE_SEC:-600}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
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
    --form-string "title=congress.trade deploy guard" \
    --form-string "message=$1" \
    --form-string "priority=1" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 || true
}

# --- single instance -------------------------------------------------------
exec 9>"$LOCK_FILE" || { log "cannot open lock"; exit 1; }
flock -n 9 || { log "another guard run in progress; exiting"; exit 0; }

if [[ -z "${COOLIFY_TOKEN:-}" ]]; then
  log "COOLIFY_TOKEN missing (${ENV_FILE}) — cannot manage deploys"
  notify "Deploy guard cannot run: COOLIFY_TOKEN missing on the host."
  exit 1
fi

HDR_FILE=$(mktemp) || exit 1
trap 'rm -f "$HDR_FILE"' EXIT
chmod 600 "$HDR_FILE"
printf 'Authorization: Bearer %s\n' "$COOLIFY_TOKEN" > "$HDR_FILE"

api() {  # api <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -m 30 -X "$method" -H @"$HDR_FILE" -H 'Content-Type: application/json' \
      -H 'Accept: application/json' -d "$body" "${COOLIFY_BASE_URL%/}${path}" 2>/dev/null
  else
    curl -sS -m 30 -X "$method" -H @"$HDR_FILE" -H 'Accept: application/json' \
      "${COOLIFY_BASE_URL%/}${path}" 2>/dev/null
  fi
}

site_is_down() {
  local code
  code=$(curl -sS -m 12 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)
  [[ "$code" != "200" ]]
}

# --- read deployment state -------------------------------------------------
DEPLOYS_JSON=$(api GET "/api/v1/deployments/applications/${APP_UUID}?take=15")
if [[ -z "$DEPLOYS_JSON" ]]; then
  log "could not read deployments (API unreachable)"
  exit 1
fi

read -r RUNNING QUEUED_UUIDS <<<"$(printf '%s' "$DEPLOYS_JSON" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print("ERR ''"); raise SystemExit
ds=d.get("deployments",[]) if isinstance(d,dict) else []
running=[x for x in ds if x.get("status") in ("in_progress","building","running")]
queued=[x for x in ds if x.get("status")=="queued"]
queued.sort(key=lambda x: x.get("created_at",""))
print(len(running), ",".join(x["deployment_uuid"] for x in queued) or "-")
')"

if [[ "$RUNNING" == "ERR" ]]; then
  log "could not parse deployments payload"
  exit 1
fi

if [[ "${RUNNING:-0}" -gt 0 ]]; then
  log "deploy in progress (${RUNNING}); standing down"
  exit 0
fi

# --- coalesce queued deploys ----------------------------------------------
if [[ "$QUEUED_UUIDS" != "-" && -n "$QUEUED_UUIDS" ]]; then
  IFS=',' read -r -a QU_ALL <<<"$QUEUED_UUIDS"

  # Never cancel the deploy this guard just triggered.
  OWN_UUID=""
  [[ -f "$LAST_DEPLOY_UUID_FILE" ]] && OWN_UUID=$(cat "$LAST_DEPLOY_UUID_FILE" 2>/dev/null || echo "")
  OWN_TS=0
  [[ -f "$LAST_DEPLOY_FILE" ]] && OWN_TS=$(cat "$LAST_DEPLOY_FILE" 2>/dev/null || echo 0)

  if [[ -n "$OWN_UUID" && $(( $(now) - OWN_TS )) -lt "$SELF_GRACE_SEC" ]]; then
    QU=()
    for u in "${QU_ALL[@]}"; do
      [[ "$u" == "$OWN_UUID" ]] && continue
      QU+=("$u")
    done
    if [[ "${#QU[@]}" -lt "${#QU_ALL[@]}" ]]; then
      log "leaving our own queued deploy ${OWN_UUID:0:8} alone (within ${SELF_GRACE_SEC}s grace)"
    fi
  else
    QU=("${QU_ALL[@]}")
  fi

  if [[ "${#QU[@]}" -eq 0 ]]; then
    log "only our own deploy is queued; nothing to coalesce"
    exit 0
  fi

  log "coalescing ${#QU[@]} queued deploy(s) into one"
  cancel_failed=0
  for u in "${QU[@]}"; do
    out=$(api POST "/api/v1/deployments/${u}/cancel")
    if [[ -z "$out" ]]; then
      out=$(api DELETE "/api/v1/deployments/${u}")
    fi
    if [[ -z "$out" ]]; then
      log "warn: could not cancel queued deploy ${u:0:8}"
      cancel_failed=1
    fi
  done
  if [[ "$cancel_failed" -eq 1 ]]; then
    # Safe degradation: let Coolify run them serially rather than risk
    # cancelling some and ALSO adding our own on top.
    log "cancellation incomplete; letting Coolify drain the queue serially"
    exit 0
  fi
  [[ -f "$PENDING_FILE" ]] || now > "$PENDING_FILE"
fi

# --- nothing to do? --------------------------------------------------------
if [[ ! -f "$PENDING_FILE" ]]; then
  exit 0
fi

PENDING_SINCE=$(cat "$PENDING_FILE" 2>/dev/null || echo 0)
LAST_DEPLOY=0
[[ -f "$LAST_DEPLOY_FILE" ]] && LAST_DEPLOY=$(cat "$LAST_DEPLOY_FILE" 2>/dev/null || echo 0)
AGE=$(( $(now) - LAST_DEPLOY ))

REASON=""
if site_is_down; then
  REASON="site down — bypassing rate limit"
elif [[ "$AGE" -ge "$MIN_DEPLOY_INTERVAL_SEC" ]]; then
  REASON="rate-limit window elapsed (${AGE}s >= ${MIN_DEPLOY_INTERVAL_SEC}s)"
else
  WAIT=$(( MIN_DEPLOY_INTERVAL_SEC - AGE ))
  log "main is ahead; holding ${WAIT}s more (pending $(( $(now) - PENDING_SINCE ))s)"
  if [[ $(( $(now) - PENDING_SINCE )) -gt $(( MIN_DEPLOY_INTERVAL_SEC * STUCK_ALERT_MULTIPLIER )) ]]; then
    notify "Deploy has been pending $(( ($(now) - PENDING_SINCE) / 60 ))min without shipping. Guard may be stuck."
  fi
  exit 0
fi

# --- deploy latest ---------------------------------------------------------
log "deploying latest main: $REASON"
RESP=$(api GET "/api/v1/deploy?uuid=${APP_UUID}&force=false")
if printf '%s' "$RESP" | grep -q 'deployment_uuid'; then
  now > "$LAST_DEPLOY_FILE"
  # Remember which deploy is ours so the next tick does not cancel it.
  printf '%s' "$RESP" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit
ds=d.get("deployments") if isinstance(d,dict) else None
if isinstance(ds,list) and ds:
    print(ds[0].get("deployment_uuid",""), end="")
elif isinstance(d,dict):
    print(d.get("deployment_uuid",""), end="")
' > "$LAST_DEPLOY_UUID_FILE" 2>/dev/null || : > "$LAST_DEPLOY_UUID_FILE"
  rm -f "$PENDING_FILE"
  log "deploy queued OK (uuid $(cut -c1-8 < "$LAST_DEPLOY_UUID_FILE" 2>/dev/null))"
else
  log "deploy trigger FAILED"
  notify "Deploy guard could not trigger a deploy via the Coolify API."
  exit 1
fi
