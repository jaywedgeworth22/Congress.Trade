#!/usr/bin/env bash
# Consistent SQLite snapshots for fleet apps + optional off-host copy.
# Complements Hetzner daily host backups (RPO ~24h host-level).
# This script aims for app-level RPO of ~hours and clean .backup files.
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEEP_DAYS="${FLEET_BACKUP_KEEP_DAYS:-7}"
ROOT="/data/backups"
LOG="/var/log/fleet-backup/sqlite-${STAMP}.log"
mkdir -p "$ROOT" /var/log/fleet-backup
exec > >(tee -a "$LOG") 2>&1
echo "[fleet-backup] start $STAMP"

backup_one() {
  local name="$1" src="$2" dest_dir="$3"
  mkdir -p "$dest_dir"
  if [ ! -f "$src" ]; then
    echo "[fleet-backup] SKIP $name (missing $src)"
    return 0
  fi
  if [ ! -s "$src" ]; then
    echo "[fleet-backup] SKIP $name (empty $src)"
    return 0
  fi
  local dest="$dest_dir/${name}-${STAMP}.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$src" ".backup '$dest'"
  else
    # online-safe-ish copy if sqlite3 missing
    cp -a "$src" "$dest"
    [ -f "${src}-wal" ] && cp -a "${src}-wal" "${dest}-wal" || true
  fi
  # integrity
  if sqlite3 "$dest" "PRAGMA integrity_check;" | head -1 | grep -qx ok; then
    echo "[fleet-backup] OK $name -> $dest ($(du -h "$dest" | awk '{print $1}'))"
  else
    echo "[fleet-backup] WARN $name integrity not clean: $dest"
  fi
  # checksum
  sha256sum "$dest" > "${dest}.sha256"
}

# Socratic: Coolify docker volume
SOCRATIC_VOL=$(docker volume ls -q | grep 'd83b1aykr03uwr32yhgzaiay.*prod-app-data\|socratic.*prod-app-data' | head -1 || true)
if [ -z "$SOCRATIC_VOL" ]; then
  SOCRATIC_VOL=$(docker volume ls -q | grep prod-app-data | head -1 || true)
fi
if [ -n "$SOCRATIC_VOL" ] && [ -f "/var/lib/docker/volumes/${SOCRATIC_VOL}/_data/app.db" ]; then
  backup_one "socratic-app" "/var/lib/docker/volumes/${SOCRATIC_VOL}/_data/app.db" "$ROOT/socratic"
else
  # try live container path via docker cp
  C=$(docker ps --format '{{.Names}}' | grep -E 'd83b1aykr03uwr32yhgzaiay|socratic' | head -1 || true)
  if [ -n "$C" ]; then
    tmp="/tmp/socratic-app.db"
    docker cp "$C:/app/data/app.db" "$tmp"
    backup_one "socratic-app" "$tmp" "$ROOT/socratic"
    rm -f "$tmp"
  else
    echo "[fleet-backup] SKIP socratic (no volume/container)"
  fi
fi

backup_one "congress-trade" "/data/congress-trade/db.sqlite" "$ROOT/congress"
# Deno KV is not pure sqlite recovery the same way; still copy for best-effort
if [ -f /data/congress-trade/kv.sqlite ]; then
  mkdir -p "$ROOT/congress"
  cp -a /data/congress-trade/kv.sqlite "$ROOT/congress/kv-${STAMP}.sqlite" || true
  echo "[fleet-backup] copied congress kv"
fi

backup_one "usage-monitor" "/data/prod.db" "$ROOT/usage-monitor"
# Coolify also mounts UM volume - find it
UM_VOL=$(docker volume ls -q | grep 'yagelvqux9e8l1kztif7bf2o\|usage-data' | head -1 || true)
if [ -n "$UM_VOL" ] && [ -f "/var/lib/docker/volumes/${UM_VOL}/_data/prod.db" ]; then
  backup_one "usage-monitor-vol" "/var/lib/docker/volumes/${UM_VOL}/_data/prod.db" "$ROOT/usage-monitor"
fi

# retention: age-based (default 7d) AND keep-count (default 3 newest .db per app dir)
KEEP_COUNT="${FLEET_BACKUP_KEEP_COUNT:-3}"
find "$ROOT" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sha256' \) -mtime +"$KEEP_DAYS" -print -delete || true
for dir in "$ROOT"/*; do
  [ -d "$dir" ] || continue
  ls -1t "$dir"/*.db 2>/dev/null | tail -n +"$((KEEP_COUNT + 1))" | while read -r f; do
    echo "[fleet-backup] prune-count $f"
    rm -f "$f" "${f}.sha256"
  done || true
done
echo "[fleet-backup] done $STAMP"
df -h /data / | tail -5

# ---- Off-host replication (MONET 2026-08-09) --------------------------------
# B2 = primary offsite (every run, scoped key in /root/.config/rclone).
# R2 = weekly cold copy (Sundays), ONLY if an [r2] rclone remote is configured
#      — one copy/week keeps R2 definitively inside its free tier.
declare -A B2_BUCKET=( [congress]="jays-congress-trade-eu" [socratic]="jays-socratic-trade-eu" [usage-monitor]="jays-usage-monitor-eu" )
# R2 destination bucket is a DIFFERENT namespace than B2 -- only apps present in
# this map have a real R2 bucket provisioned. Do not reuse B2_BUCKET names here
# (fixed 2026-08-12: previous code pushed to "r2:<b2-bucket-name>/weekly/", a
# bucket name that only exists on B2, so the R2 weekly leg silently failed).
declare -A R2_BUCKET=( [congress]="congress-trade-bucket" )
for app in congress socratic usage-monitor; do
  dir="$ROOT/$app"; [ -d "$dir" ] || continue
  files=$(ls -1 "$dir" 2>/dev/null | grep "$STAMP" || true)
  [ -n "$files" ] || continue
  if rclone copy "$dir" "b2:${B2_BUCKET[$app]}/hetzner/" --include "*${STAMP}*" --transfers 2 -q; then
    echo "[fleet-backup] B2 offsite OK: $app ($STAMP)"
  else
    echo "[fleet-backup] B2 offsite FAIL: $app"
  fi
  # Weekly R2 leg: Sundays, or FLEET_BACKUP_FORCE_WEEKLY=1 for manual/out-of-cycle proof runs.
  if [ "$(date -u +%u)" = "7" ] || [ "${FLEET_BACKUP_FORCE_WEEKLY:-0}" = "1" ]; then
    r2bucket="${R2_BUCKET[$app]:-}"
    if [ -z "$r2bucket" ]; then
      echo "[fleet-backup] R2 weekly skipped: no R2 bucket mapped for $app"
    elif rclone listremotes 2>/dev/null | grep -q "^r2:"; then
      if rclone copy "$dir" "r2:${r2bucket}/weekly/" --include "*${STAMP}*" --transfers 2 -q; then
        echo "[fleet-backup] R2 weekly OK: $app"
        # Receipt so congress.trade /api/health can say R2 weekly is fine
        # without listing the bucket (no secrets on the health path).
        if [ "$app" = "congress" ]; then
          status_path="/data/congress-trade/.r2-archive-status.json"
          newest="$(ls -1t "$dir"/*"${STAMP}"*.db 2>/dev/null | head -1 || true)"
          key="weekly/$(basename "${newest:-congress-trade-${STAMP}.db}")"
          printf '{"ok":true,"key":"%s","completedAt":"%s"}\n' "$key" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$status_path"
          # R2 is weekly-archive-only.  One CT db is ~1.9 GB; extra copies
          # trip the 10 GB free tier.  Keep the newest weekly set only.
          keep="$(basename "${newest:-}")"
          stamp_keep="${keep#congress-trade-}"
          stamp_keep="${stamp_keep%.db}"
          rclone lsf "r2:${r2bucket}/weekly/" 2>/dev/null | while read -r name; do
            [ -n "$name" ] || continue
            case "$name" in
              *"${stamp_keep}"*) ;;
              *) rclone deletefile "r2:${r2bucket}/weekly/${name}" && echo "[fleet-backup] R2 weekly pruned: $name" || true ;;
            esac
          done
        fi
      else
        echo "[fleet-backup] R2 weekly FAIL: $app"
        if [ "$app" = "congress" ]; then
          printf '{"ok":false,"reason":"rclone_failed","checkedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            > /data/congress-trade/.r2-archive-status.json || true
        fi
      fi
    else
      echo "[fleet-backup] R2 weekly skipped: no r2 remote configured yet"
    fi
  fi
done
