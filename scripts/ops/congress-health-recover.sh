#!/usr/bin/env bash
# congress-health-recover.sh — autonomous recovery for congress.trade
#
# Polls public /api/health. After consecutive failures:
#   1) restart the Coolify-managed congress-app container (docker)
#   2) re-attach stable Traefik alias via ct-reattach-proxy.sh (if present)
#   3) optionally POST Coolify application restart when COOLIFY_TOKEN is set
#
# Safe defaults:
#   - no host reboot
#   - no docker daemon restart
#   - skip remediation while Coolify is actively building/deploying
#   - cooldown between restarts; max restarts per hour
#
# Install (Coolify / Hetzner host):
#   install -m 0755 scripts/ops/congress-health-recover.sh /usr/local/bin/
#   install -m 0644 scripts/ops/congress-health-recover.service /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now congress-health-recover
#
# Env overrides (optional):
#   HEALTH_URL          default https://congress.trade/api/health
#   CHECK_INTERVAL_SEC  default 30
#   FAIL_THRESHOLD      default 2
#   RESTART_COOLDOWN_SEC default 300
#   MAX_RESTARTS_PER_HOUR default 4
#   APP_UUID            default c11c5hdhuczureb6w2pg20p0
#   COOLIFY_BASE_URL    default https://host.jays.services
#   COOLIFY_TOKEN       optional Bearer for Coolify API restart
#   STATE_DIR           default /var/lib/congress-health-recover
#   LOG_TAG             default congress-health-recover

set -euo pipefail

HEALTH_URL="${HEALTH_URL:-https://congress.trade/api/health}"
CHECK_INTERVAL_SEC="${CHECK_INTERVAL_SEC:-30}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
RESTART_COOLDOWN_SEC="${RESTART_COOLDOWN_SEC:-300}"
MAX_RESTARTS_PER_HOUR="${MAX_RESTARTS_PER_HOUR:-4}"
APP_UUID="${APP_UUID:-c11c5hdhuczureb6w2pg20p0}"
COOLIFY_BASE_URL="${COOLIFY_BASE_URL:-https://host.jays.services}"
STATE_DIR="${STATE_DIR:-/var/lib/congress-health-recover}"
LOG_TAG="${LOG_TAG:-congress-health-recover}"
STARTUP_GRACE_SEC="${STARTUP_GRACE_SEC:-90}"

mkdir -p "$STATE_DIR"
FAILS=0
STARTED_AT=$(date +%s)

log() {
  local msg="$*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg"
  if command -v logger >/dev/null 2>&1; then
    logger -t "$LOG_TAG" -- "$msg" || true
  fi
}

now() { date +%s; }

is_deploy_active() {
  # Coolify builder / nixpacks containers indicate a live deploy.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -Eqi 'nixpacks|coolify-builder|buildkit'; then
    return 0
  fi
  return 1
}

check_health() {
  # Alive if HTTP 2xx/3xx/4xx and (when JSON) ok+db are not explicitly false.
  # Network errors / 5xx count as down. A 200 HTML challenge page is down.
  local body code
  body=$(curl -fsS -m 12 -w '\n%{http_code}' "$HEALTH_URL" 2>/dev/null) || return 1
  code=$(printf '%s\n' "$body" | tail -n1)
  body=$(printf '%s\n' "$body" | sed '$d')
  case "$code" in
    2??|3??) ;;
    *) return 1 ;;
  esac
  if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*false'; then
    return 1
  fi
  if printf '%s' "$body" | grep -q '"db"[[:space:]]*:[[:space:]]*false'; then
    return 1
  fi
  # Prefer structured health; plain non-JSON 200 without ok is treated as down.
  if ! printf '%s' "$body" | grep -q '"ok"'; then
    return 1
  fi
  return 0
}

restart_timestamps_file() { printf '%s/restarts.log' "$STATE_DIR"; }
last_restart_file() { printf '%s/last_restart' "$STATE_DIR"; }

restarts_last_hour() {
  local cutoff now_ts
  now_ts=$(now)
  cutoff=$((now_ts - 3600))
  if [[ ! -f "$(restart_timestamps_file)" ]]; then
    echo 0
    return
  fi
  awk -v c="$cutoff" '$1 >= c { n++ } END { print n+0 }' "$(restart_timestamps_file)"
}

cooldown_ok() {
  local last now_ts
  now_ts=$(now)
  if [[ ! -f "$(last_restart_file)" ]]; then
    return 0
  fi
  last=$(cat "$(last_restart_file)" 2>/dev/null || echo 0)
  [[ $((now_ts - last)) -ge $RESTART_COOLDOWN_SEC ]]
}

find_app_container() {
  # Prefer live Coolify-labeled congress-app only.
  # Monet incident 2026-08-10: `docker ps -aq --filter name=congress-app-` matched
  # abandoned manual relics (congress-app-live-*) and `docker start` resurrected a
  # 3-day-old build on a health blip. Never start name-matched stopped containers.
  local id
  id=$(docker ps -q \
    --filter "label=coolify.resourceName=congress-trade" \
    --filter "label=com.docker.compose.service=congress-app" 2>/dev/null | head -1 || true)
  if [[ -n "$id" ]]; then
    printf '%s\n' "$id"
    return 0
  fi
  # Stopped-but-labeled Coolify container: restart is OK (same resource).
  id=$(docker ps -aq \
    --filter "label=coolify.resourceName=congress-trade" \
    --filter "label=com.docker.compose.service=congress-app" \
    --filter "status=exited" 2>/dev/null | head -1 || true)
  if [[ -n "$id" ]]; then
    printf '%s\n' "$id"
    return 0
  fi
  # Name fallback: RUNNING only. Manual/relic stopped containers must not start.
  id=$(docker ps -q --filter "name=congress-app-" 2>/dev/null | head -1 || true)
  if [[ -n "$id" ]]; then
    log "warn: using running name=congress-app- fallback id=${id:0:12} (prefer Coolify labels)"
    printf '%s\n' "$id"
    return 0
  fi
  return 1
}

restart_via_docker() {
  local id name
  id=$(find_app_container) || {
    log "remediate: no congress-app container found"
    return 1
  }
  name=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')
  local status
  status=$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)
  log "remediate: docker $status -> restart id=${id:0:12} name=$name"
  if [[ "$status" == "running" ]]; then
    docker restart "$id" >/dev/null
  else
    docker start "$id" >/dev/null || docker restart "$id" >/dev/null
  fi
  if [[ -x /usr/local/bin/ct-reattach-proxy.sh ]]; then
    /usr/local/bin/ct-reattach-proxy.sh || log "warn: ct-reattach-proxy.sh failed"
  fi
  return 0
}

restart_via_coolify_api() {
  if [[ -z "${COOLIFY_TOKEN:-}" ]]; then
    return 1
  fi
  local url="${COOLIFY_BASE_URL%/}/api/v1/applications/${APP_UUID}/restart"
  log "remediate: Coolify API restart $url"
  local code
  code=$(curl -sS -m 30 -o /tmp/ct-coolify-restart.out -w '%{http_code}' \
    -X GET \
    -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
    -H "Accept: application/json" \
    "$url" 2>/dev/null || echo 000)
  # Some Coolify builds use POST; retry once on 405/404.
  if [[ "$code" == "405" || "$code" == "404" ]]; then
    code=$(curl -sS -m 30 -o /tmp/ct-coolify-restart.out -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
      -H "Accept: application/json" \
      "$url" 2>/dev/null || echo 000)
  fi
  log "remediate: Coolify API HTTP $code"
  [[ "$code" == "2"* ]]
}

remediate() {
  if is_deploy_active; then
    log "remediate: skipped (Coolify build/deploy active)"
    return 0
  fi
  if ! cooldown_ok; then
    log "remediate: skipped (cooldown ${RESTART_COOLDOWN_SEC}s)"
    return 0
  fi
  local n
  n=$(restarts_last_hour)
  if [[ "$n" -ge "$MAX_RESTARTS_PER_HOUR" ]]; then
    log "remediate: skipped (already $n restarts in last hour; max $MAX_RESTARTS_PER_HOUR)"
    return 0
  fi

  local ok=1
  if ! restart_via_docker; then
    ok=0
  fi
  # Best-effort Coolify API (docker path is primary on the host).
  restart_via_coolify_api || true

  local ts
  ts=$(now)
  echo "$ts" >> "$(restart_timestamps_file)"
  echo "$ts" > "$(last_restart_file)"
  log "remediate: recorded restart ts=$ts docker_ok=$ok"

  # Wait for recovery window before counting more failures.
  sleep 45
  if check_health; then
    log "remediate: health restored after restart"
    FAILS=0
  else
    log "remediate: health still down after restart"
  fi
}

log "start health_url=$HEALTH_URL interval=${CHECK_INTERVAL_SEC}s fail_threshold=$FAIL_THRESHOLD"

while true; do
  if [[ $(( $(now) - STARTED_AT )) -lt $STARTUP_GRACE_SEC ]]; then
    sleep "$CHECK_INTERVAL_SEC"
    continue
  fi

  if check_health; then
    if [[ "$FAILS" -gt 0 ]]; then
      log "health ok (recovered after $FAILS fail(s))"
    fi
    FAILS=0
  else
    FAILS=$((FAILS + 1))
    log "health FAIL count=$FAILS/$FAIL_THRESHOLD"
    if [[ "$FAILS" -ge "$FAIL_THRESHOLD" ]]; then
      remediate || log "remediate: failed"
    fi
  fi
  sleep "$CHECK_INTERVAL_SEC"
done
