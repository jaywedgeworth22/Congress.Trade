#!/usr/bin/env bash
# PM2 entrypoint for the Senate residential relay tunnel.
#
# WHY THIS EXISTS (2026-08-11 outage post-mortem)
# -----------------------------------------------
# The tunnel was previously started as a bare pm2 command:
#
#     bash -c 'cloudflared tunnel --url http://127.0.0.1:8899'
#
# `cloudflared tunnel --url` is a TryCloudflare *quick* tunnel: Cloudflare
# mints a brand-new random hostname on every start and the previous one dies
# immediately.  The server reaches the relay through `SENATE_RELAY_URL`, which
# is a static Worker binding.  So every restart silently repointed the tunnel
# while the server kept dialling the dead hostname -- a total, silent break of
# the server-side Senate path with nothing anywhere saying so.  It had rotated
# 4 times (3 restarts) by the time the outage was investigated; the previous
# hostname resolved to nothing while the current one served fine.
#
# This wrapper cannot make a quick tunnel's hostname stable -- only a *named*
# tunnel can, and that needs Cloudflare credentials plus a DNS record, i.e. an
# owner-approved infrastructure change.  What it does instead:
#   1. captures the assigned hostname and persists it where operators and the
#      watchdog can read it,
#   2. shouts -- to the log and to the owner's phone -- the moment the hostname
#      rotates, because that is the exact instant SENATE_RELAY_URL goes stale,
#   3. self-heals: probes the relay end-to-end through the tunnel and exits
#      non-zero when it stops answering, so pm2 (the supervisor that already
#      exists) restarts it.  A cloudflared that keeps running with a broken
#      DNS resolver -- exactly what "Failed to refresh DNS local resolver"
#      produced -- looks alive to pm2 forever.
set -uo pipefail

SCOUT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${SENATE_RELAY_PORT:-8899}"
URL_FILE="${SENATE_TUNNEL_URL_FILE:-$SCOUT_DIR/senate-tunnel-url.txt}"
PROBE_INTERVAL_SEC="${SENATE_TUNNEL_PROBE_SEC:-120}"
PROBE_FAIL_LIMIT="${SENATE_TUNNEL_FAIL_LIMIT:-3}"
SECRETS_FILE="${HOME}/.secrets/global-api-keys"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] senate-tunnel: $*" >&2; }

# Read one KEY=VALUE without sourcing the file: a single unquoted value in
# global-api-keys can otherwise be parsed as a shell command (see run-scout.sh's
# note about COOLIFY_SERVER_STATS killing the pm2 scout under `set -e`).
secret_of() {
  [[ -f "$SECRETS_FILE" ]] || return 0
  # \042 = double quote, \047 = single quote — strip either style of wrapping
  # without needing to escape a quote inside a quoted tr argument.
  grep -m1 "^${1}=" "$SECRETS_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\042\047'
}

# Never echoes either value; only ever passed to curl via --data-urlencode.
notify() {
  local title="$1" message="$2" priority="${3:-1}"
  local tok user
  tok="$(secret_of PUSHOVER_APP_TOKEN)"; [[ -z "$tok" ]] && tok="$(secret_of PUSHOVER_CT_API_TOKEN)"
  user="$(secret_of PUSHOVER_USER_KEY)"
  if [[ -z "$tok" || -z "$user" ]]; then
    log "escalation NOT delivered (pushover unconfigured): ${title} -- ${message}"
    return 0
  fi
  curl -sS -o /dev/null --max-time 15 https://api.pushover.net/1/messages.json \
    --data-urlencode "token=${tok}" --data-urlencode "user=${user}" \
    --data-urlencode "title=${title}" --data-urlencode "message=${message}" \
    --data-urlencode "priority=${priority}" 2>/dev/null \
    || log "escalation delivery failed: ${title}"
}

PREVIOUS_URL=""
[[ -f "$URL_FILE" ]] && PREVIOUS_URL="$(cat "$URL_FILE" 2>/dev/null || true)"

CF_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared || true)}"
if [[ -z "$CF_BIN" ]]; then
  log "cloudflared not found on PATH"
  exit 1
fi

FIFO_DIR="$(mktemp -d)"
trap 'rm -rf "$FIFO_DIR"; [[ -n "${CF_PID:-}" ]] && kill "$CF_PID" 2>/dev/null; exit' EXIT INT TERM

log "starting quick tunnel -> http://127.0.0.1:${PORT}"
"$CF_BIN" tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" > "$FIFO_DIR/out" 2>&1 &
CF_PID=$!

# Wait for Cloudflare to assign the hostname (it prints it in a banner).
TUNNEL_URL=""
for _ in $(seq 1 60); do
  TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$FIFO_DIR/out" 2>/dev/null \
    | grep -v '^https://api\.trycloudflare\.com$' | tail -1 || true)"
  [[ -n "$TUNNEL_URL" ]] && break
  kill -0 "$CF_PID" 2>/dev/null || { log "cloudflared exited before assigning a hostname"; wait "$CF_PID"; exit 1; }
  sleep 2
done

if [[ -z "$TUNNEL_URL" ]]; then
  log "no hostname assigned within 120s"
  kill "$CF_PID" 2>/dev/null
  exit 1
fi

printf '%s\n' "$TUNNEL_URL" > "$URL_FILE"
log "assigned ${TUNNEL_URL}"

if [[ -n "$PREVIOUS_URL" && "$PREVIOUS_URL" != "$TUNNEL_URL" ]]; then
  # This is the silent-breakage moment. Say it out loud.
  log "HOSTNAME ROTATED: ${PREVIOUS_URL} -> ${TUNNEL_URL} — SENATE_RELAY_URL is now STALE"
  notify "CT senate tunnel rotated" \
    "Quick-tunnel hostname changed to ${TUNNEL_URL}. The server's SENATE_RELAY_URL still points at ${PREVIOUS_URL} and the Senate relay path is DOWN until it is updated. Fix permanently with a named tunnel." \
    1
fi

# End-to-end probe loop: the relay's own /health, reached the way the server
# reaches it. Exiting non-zero hands recovery to pm2 rather than adding a
# third supervisor.
FAILS=0
while kill -0 "$CF_PID" 2>/dev/null; do
  sleep "$PROBE_INTERVAL_SEC"
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "${TUNNEL_URL}/health" 2>/dev/null || echo 000)"
  if [[ "$CODE" == "200" ]]; then
    FAILS=0
    continue
  fi
  FAILS=$((FAILS + 1))
  log "probe ${TUNNEL_URL}/health -> HTTP ${CODE} (${FAILS}/${PROBE_FAIL_LIMIT})"
  if (( FAILS >= PROBE_FAIL_LIMIT )); then
    log "tunnel unhealthy ${FAILS}x — exiting so pm2 restarts it"
    notify "CT senate tunnel unhealthy" \
      "${TUNNEL_URL}/health returned HTTP ${CODE} ${FAILS} times. Restarting the tunnel; a new hostname will be minted and SENATE_RELAY_URL will need updating." 1
    kill "$CF_PID" 2>/dev/null
    exit 1
  fi
done

wait "$CF_PID"
STATUS=$?
log "cloudflared exited with status ${STATUS}"
exit "${STATUS:-1}"
