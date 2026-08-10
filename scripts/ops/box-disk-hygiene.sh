#!/usr/bin/env bash
# box-disk-hygiene.sh — scheduled disk checks + safe Docker prune on the Coolify host
#
# Context (Monet 2026-08-10): overnight builds filled the 150G root (15MB free),
# deploy mid-pull failed. Manual `docker builder prune -af` + `docker image prune -af`
# recovered ~51GB. Automate checks + bounded cleanup so SQLite/WAL and deploys stay safe.
#
# Safe defaults:
#   - never restarts docker / never host reboot
#   - never prunes named volumes (opt-in only via PRUNE_VOLUMES=1)
#   - skips prune while Coolify/nixpacks/buildkit is actively building
#   - rate-limits aggressive prunes
#   - always logs df + docker system df + CT SQLite/WAL sizes
#
# Install (Coolify host as root):
#   install -m 0755 scripts/ops/box-disk-hygiene.sh /usr/local/bin/
#   install -m 0644 scripts/ops/box-disk-hygiene.service /etc/systemd/system/
#   install -m 0644 scripts/ops/box-disk-hygiene.timer /etc/systemd/system/
#   systemctl daemon-reload
#   systemctl enable --now box-disk-hygiene.timer
#   systemctl start box-disk-hygiene.service   # one-shot now
#
# Env overrides (optional /etc/box-disk-hygiene.env):
#   ROOT_PATH                 default /
#   WARN_USED_PCT             default 80
#   CRIT_USED_PCT             default 90
#   WARN_FREE_GB              default 15
#   CRIT_FREE_GB              default 8
#   LIGHT_BUILDER_UNTIL       default 12h   (unused build cache older than this)
#   AGGRESSIVE_COOLDOWN_SEC   default 1800
#   PRUNE_VOLUMES             default 0     (1 = docker volume prune -f unused only)
#   CT_DATA_DIR               default /data/congress-trade
#   STATE_DIR                 default /var/lib/box-disk-hygiene
#   LOG_TAG                   default box-disk-hygiene
#   ALERT_WEBHOOK_URL         optional POST JSON on critical (Slack/ntfy/etc.)
#   DRY_RUN                   default 0

set -euo pipefail

ROOT_PATH="${ROOT_PATH:-/}"
WARN_USED_PCT="${WARN_USED_PCT:-80}"
CRIT_USED_PCT="${CRIT_USED_PCT:-90}"
WARN_FREE_GB="${WARN_FREE_GB:-15}"
CRIT_FREE_GB="${CRIT_FREE_GB:-8}"
LIGHT_BUILDER_UNTIL="${LIGHT_BUILDER_UNTIL:-12h}"
AGGRESSIVE_COOLDOWN_SEC="${AGGRESSIVE_COOLDOWN_SEC:-1800}"
PRUNE_VOLUMES="${PRUNE_VOLUMES:-0}"
CT_DATA_DIR="${CT_DATA_DIR:-/data/congress-trade}"
STATE_DIR="${STATE_DIR:-/var/lib/box-disk-hygiene}"
LOG_TAG="${LOG_TAG:-box-disk-hygiene}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
DRY_RUN="${DRY_RUN:-0}"

mkdir -p "$STATE_DIR"

log() {
  local msg="$*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg"
  if command -v logger >/dev/null 2>&1; then
    logger -t "$LOG_TAG" -- "$msg" || true
  fi
}

now() { date +%s; }

is_deploy_active() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -Eqi 'nixpacks|coolify-builder|buildkit'; then
    return 0
  fi
  return 1
}

# Returns: used_pct free_gb total_gb via globals
read_disk() {
  # Portable: df -P for POSIX columns
  local line
  line=$(df -P "$ROOT_PATH" 2>/dev/null | awk 'NR==2 {print $2, $3, $4, $5}')
  if [[ -z "$line" ]]; then
    log "error: df failed for $ROOT_PATH"
    exit 1
  fi
  # sizes in 1K-blocks
  local total_k used_k avail_k used_pct_str
  read -r total_k used_k avail_k used_pct_str <<<"$line"
  USED_PCT=${used_pct_str%%%}
  FREE_GB=$(awk -v a="$avail_k" 'BEGIN { printf "%.1f", a/1024/1024 }')
  TOTAL_GB=$(awk -v t="$total_k" 'BEGIN { printf "%.1f", t/1024/1024 }')
  USED_GB=$(awk -v u="$used_k" 'BEGIN { printf "%.1f", u/1024/1024 }')
}

report_sqlite() {
  local dir="$CT_DATA_DIR"
  if [[ ! -d "$dir" ]]; then
    log "sqlite: $dir absent"
    return 0
  fi
  local db wal shm kv
  db=$(stat -c%s "$dir/db.sqlite" 2>/dev/null || echo 0)
  wal=$(stat -c%s "$dir/db.sqlite-wal" 2>/dev/null || echo 0)
  shm=$(stat -c%s "$dir/db.sqlite-shm" 2>/dev/null || echo 0)
  kv=$(stat -c%s "$dir/kv.sqlite" 2>/dev/null || echo 0)
  log "sqlite: db=$(awk -v n="$db" 'BEGIN{printf "%.1fMiB", n/1024/1024}') wal=$(awk -v n="$wal" 'BEGIN{printf "%.1fMiB", n/1024/1024}') shm=$(awk -v n="$shm" 'BEGIN{printf "%.0fKiB", n/1024}') kv=$(awk -v n="$kv" 'BEGIN{printf "%.1fMiB", n/1024/1024}')"
}

report_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "docker: not installed"
    return 0
  fi
  # One-line summary; full table to state file
  docker system df 2>/dev/null | tee "$STATE_DIR/last-docker-df.txt" | while IFS= read -r line; do
    log "docker-df: $line"
  done || log "docker: system df failed"
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: $*"
    return 0
  fi
  log "run: $*"
  # shellcheck disable=SC2086
  "$@" 2>&1 | while IFS= read -r line; do
    log "  $line"
  done || {
    log "warn: command failed: $*"
    return 1
  }
  return 0
}

cooldown_ok() {
  local f="$STATE_DIR/last_aggressive"
  local last now_ts
  now_ts=$(now)
  if [[ ! -f "$f" ]]; then
    return 0
  fi
  last=$(cat "$f" 2>/dev/null || echo 0)
  [[ $((now_ts - last)) -ge $AGGRESSIVE_COOLDOWN_SEC ]]
}

mark_aggressive() {
  echo "$(now)" >"$STATE_DIR/last_aggressive"
}

alert_critical() {
  local body="$1"
  log "ALERT critical: $body"
  if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
    return 0
  fi
  # Minimal JSON; works for Slack incoming webhooks and ntfy-style posts.
  local payload
  payload=$(printf '{"text":"[%s] %s"}' "$LOG_TAG" "$body")
  curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
    -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 \
    || log "warn: alert webhook failed"
}

light_prune() {
  # Disposable only: dangling images + older unused build cache.
  run_cmd docker image prune -f || true
  # builder prune --filter until= is supported on standard docker builder
  run_cmd docker builder prune -f --filter "until=${LIGHT_BUILDER_UNTIL}" || true
}

soft_prune() {
  # Monet's recovery path (unused images + full builder cache).
  run_cmd docker builder prune -af || true
  run_cmd docker image prune -af || true
  if [[ "$PRUNE_VOLUMES" == "1" ]]; then
    run_cmd docker volume prune -f || true
  fi
}

aggressive_prune() {
  # Still avoids volumes unless PRUNE_VOLUMES=1.
  run_cmd docker builder prune -af || true
  run_cmd docker image prune -af || true
  run_cmd docker container prune -f || true
  if [[ "$PRUNE_VOLUMES" == "1" ]]; then
    run_cmd docker volume prune -f || true
  fi
  # system prune without --volumes keeps named volumes
  run_cmd docker system prune -af || true
}

level_for() {
  # echo: ok | warn | crit
  local used_pct free_gb
  used_pct="$1"
  free_gb="$2"
  # awk compares floats
  if awk -v u="$used_pct" -v c="$CRIT_USED_PCT" -v f="$free_gb" -v cf="$CRIT_FREE_GB" \
    'BEGIN { exit !((u+0) >= (c+0) || (f+0) < (cf+0)) }'; then
    echo crit
    return
  fi
  if awk -v u="$used_pct" -v w="$WARN_USED_PCT" -v f="$free_gb" -v wf="$WARN_FREE_GB" \
    'BEGIN { exit !((u+0) >= (w+0) || (f+0) < (wf+0)) }'; then
    echo warn
    return
  fi
  echo ok
}

main() {
  log "start root=$ROOT_PATH warn=${WARN_USED_PCT}%/${WARN_FREE_GB}G crit=${CRIT_USED_PCT}%/${CRIT_FREE_GB}G dry_run=$DRY_RUN"

  read_disk
  log "disk: path=$ROOT_PATH used=${USED_PCT}% (${USED_GB}G/${TOTAL_GB}G) free=${FREE_GB}G"
  report_sqlite
  report_docker

  local level
  level=$(level_for "$USED_PCT" "$FREE_GB")
  log "level=$level"

  if is_deploy_active; then
    log "prune: skipped (Coolify build/deploy active)"
    echo "$level" >"$STATE_DIR/last_level"
    printf '%s used=%s free=%sG level=%s deploy_active=1\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$USED_PCT" "$FREE_GB" "$level" \
      >"$STATE_DIR/last-status"
    exit 0
  fi

  case "$level" in
    ok)
      # Keep headroom: light dangling cleanup even when healthy.
      light_prune
      ;;
    warn)
      if cooldown_ok; then
        soft_prune
        mark_aggressive
      else
        log "soft prune: skipped (cooldown ${AGGRESSIVE_COOLDOWN_SEC}s)"
        light_prune
      fi
      ;;
    crit)
      alert_critical "disk critical used=${USED_PCT}% free=${FREE_GB}G on $(hostname) — pruning"
      if cooldown_ok; then
        aggressive_prune
        mark_aggressive
      else
        log "aggressive prune: skipped (cooldown ${AGGRESSIVE_COOLDOWN_SEC}s); soft path"
        soft_prune
      fi
      ;;
  esac

  # Re-measure after cleanup
  read_disk
  log "disk-after: used=${USED_PCT}% free=${FREE_GB}G"
  report_docker

  local level_after
  level_after=$(level_for "$USED_PCT" "$FREE_GB")
  if [[ "$level_after" == "crit" ]]; then
    alert_critical "disk STILL critical after prune used=${USED_PCT}% free=${FREE_GB}G on $(hostname) — manual intervention needed (check /data/backups, large logs)"
  fi

  echo "$level_after" >"$STATE_DIR/last_level"
  printf '%s used=%s free=%sG level_before=%s level_after=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$USED_PCT" "$FREE_GB" "$level" "$level_after" \
    >"$STATE_DIR/last-status"

  log "done level_before=$level level_after=$level_after"
}

main "$@"
