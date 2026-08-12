#!/usr/bin/env bash
# PM2 entrypoint for the Senate residential relay tunnel.
#
# THE HOSTNAME IS STATIC.  https://scout.congress.trade  — forever.
# ------------------------------------------------------------------
# This runs the **named** Cloudflare tunnel `ct-mac-scout`
# (60b9bdbd-df7d-42f9-99b2-91110548df70).  A named tunnel owns one permanent
# hostname, so `SENATE_RELAY_URL` never has to be touched again.  If you are
# here because the Senate path is down, the fix is NOT to go update a URL
# somewhere — that era is over.  See "History" at the bottom.
#
# Ingress lives in Cloudflare, not here.  The tunnel's `config_src` is
# `cloudflare`, so the edge pushes the ingress rules down the control stream a
# beat after the connections register:
#
#     INF Updated to new configuration config="{"ingress":[
#           {"hostname":"scout.congress.trade","service":"http://127.0.0.1:8899"},
#           {"service":"http_status:404"}]}" version=1
#
# Deliberately no local `config.yml`: a second copy of the ingress rules is a
# second thing to drift.  The startup banner's "No ingress rules were defined"
# warning is expected — it describes the local config that intentionally does
# not exist, and is superseded by the pushed config above.
#
# Run mode: `--cred-file <path> <UUID>`.  Not `cloudflared tunnel run
# ct-mac-scout` — resolving a tunnel *name* needs an origin cert, and there is
# no `cert.pem` on this box, so the name form dies with "Cannot determine
# default origin certificate path".  Verified 2026-08-12; the UUID +
# credentials form both connects and receives the pushed ingress.
#
# What this wrapper adds on top of bare cloudflared: it exits non-zero when the
# relay stops answering *through the tunnel*, so pm2 restarts it.  That is not
# theoretical — on 2026-08-11 a cloudflared whose DNS resolver had died
# ("Failed to refresh DNS local resolver") sat there serving nothing while pm2
# reported it "online" indefinitely.  A process that is running but useless is
# the failure a supervisor cannot see on its own.  Restarts are now cheap:
# with a named tunnel a restart reconnects to the *same* hostname.
set -uo pipefail

SCOUT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${SENATE_RELAY_PORT:-8899}"
TUNNEL_ID="${SENATE_TUNNEL_ID:-60b9bdbd-df7d-42f9-99b2-91110548df70}"
TUNNEL_HOSTNAME="${SENATE_TUNNEL_HOSTNAME:-scout.congress.trade}"
CRED_FILE="${SENATE_TUNNEL_CRED_FILE:-${HOME}/.cloudflared/${TUNNEL_ID}.json}"
PROBE_PATH="${SENATE_TUNNEL_PROBE_PATH:-/health}"
PROBE_INTERVAL_SEC="${SENATE_TUNNEL_PROBE_SEC:-120}"
PROBE_FAIL_LIMIT="${SENATE_TUNNEL_FAIL_LIMIT:-3}"
CONNECT_TIMEOUT_SEC="${SENATE_TUNNEL_CONNECT_SEC:-120}"
SECRETS_FILE="${HOME}/.secrets/global-api-keys"

PUBLIC_URL="https://${TUNNEL_HOSTNAME}"

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

# HTTP status only; 000 means "no response at all" (DNS, TCP, TLS, timeout).
probe_code() {
  local max_time="$1" url="$2"
  curl -sS -o /dev/null -w '%{http_code}' --max-time "$max_time" "$url" 2>/dev/null || echo 000
}

CF_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared || true)}"
if [[ -z "$CF_BIN" ]]; then
  log "cloudflared not found on PATH"
  exit 1
fi

# Fail loudly at the point of the actual problem. Without this, a missing or
# unreadable credentials file surfaces as a generic connection error minutes
# later, in a log nobody is reading.
if [[ ! -r "$CRED_FILE" ]]; then
  log "credentials file not readable: ${CRED_FILE}"
  log "expected the named tunnel's credentials (tunnel ${TUNNEL_ID}); refusing to start"
  notify "CT senate tunnel cannot start" \
    "Credentials for named tunnel ${TUNNEL_ID} are missing or unreadable at ${CRED_FILE}. The Senate relay is unreachable until this is restored." 1
  exit 1
fi

RUN_DIR="$(mktemp -d)"
RUN_LOG="$RUN_DIR/cloudflared.log"
: > "$RUN_LOG"

cleanup() {
  [[ -n "${MIRROR_PID:-}" ]] && kill "$MIRROR_PID" 2>/dev/null
  [[ -n "${CF_PID:-}" ]] && kill "$CF_PID" 2>/dev/null
  rm -rf "$RUN_DIR"
}
trap 'cleanup; exit' EXIT INT TERM

log "starting named tunnel ${TUNNEL_ID} (${PUBLIC_URL}) -> http://127.0.0.1:${PORT}"
"$CF_BIN" tunnel --no-autoupdate run --cred-file "$CRED_FILE" "$TUNNEL_ID" > "$RUN_LOG" 2>&1 &
CF_PID=$!

# Keep cloudflared's own output in pm2's log. Reading it from a file (rather
# than piping) is what lets $! stay cloudflared's PID instead of a pipeline's.
tail -n +1 -f "$RUN_LOG" >&2 &
MIRROR_PID=$!

# Startup gate: a registered connection proves credentials + edge reachability.
# Deliberately does NOT wait on the relay — the relay has its own pm2 entry, and
# gating tunnel startup on relay health would turn one dead process into two.
CONNECTED=0
for _ in $(seq 1 "$(( CONNECT_TIMEOUT_SEC / 2 ))"); do
  if grep -q 'Registered tunnel connection' "$RUN_LOG" 2>/dev/null; then
    CONNECTED=1
    break
  fi
  kill -0 "$CF_PID" 2>/dev/null || { log "cloudflared exited before registering a connection"; wait "$CF_PID"; exit 1; }
  sleep 2
done

if (( CONNECTED == 0 )); then
  log "no tunnel connection registered within ${CONNECT_TIMEOUT_SEC}s"
  kill "$CF_PID" 2>/dev/null
  exit 1
fi

log "connected — serving ${PUBLIC_URL}"

# The ingress the edge actually pushed. The hostname can no longer rotate, but
# the API-side ingress can be edited out from under this box, and that is now
# the only way the public URL and SENATE_RELAY_URL can disagree. Cheap to check,
# and it puts the live config in the log where an operator can read it.
PUSHED_CONFIG="$(grep -m1 'Updated to new configuration' "$RUN_LOG" 2>/dev/null || true)"
if [[ -n "$PUSHED_CONFIG" ]]; then
  if [[ "$PUSHED_CONFIG" != *"$TUNNEL_HOSTNAME"* ]]; then
    log "WARNING: pushed ingress does not mention ${TUNNEL_HOSTNAME} — check the tunnel's Cloudflare-side config"
    log "pushed: ${PUSHED_CONFIG}"
  else
    log "ingress from Cloudflare confirmed for ${TUNNEL_HOSTNAME}"
  fi
fi

# Steady-state health: compare what the public hostname returns against what the
# relay returns locally. Equal statuses mean the whole chain (edge -> cloudflared
# -> relay) is intact, whatever that status happens to be — which keeps this
# probe honest even when the relay has no /health route yet, and stops a route
# change from being misread as a tunnel outage. Exiting non-zero hands recovery
# to pm2 rather than adding a third supervisor.
FAILS=0
while kill -0 "$CF_PID" 2>/dev/null; do
  sleep "$PROBE_INTERVAL_SEC"
  PUBLIC_CODE="$(probe_code 20 "${PUBLIC_URL}${PROBE_PATH}")"
  LOCAL_CODE="$(probe_code 10 "http://127.0.0.1:${PORT}${PROBE_PATH}")"

  if [[ "$PUBLIC_CODE" != "000" && "$PUBLIC_CODE" == "$LOCAL_CODE" ]]; then
    FAILS=0
    continue
  fi

  FAILS=$((FAILS + 1))
  if [[ "$LOCAL_CODE" == "000" ]]; then
    DIAG="relay is not answering on 127.0.0.1:${PORT} either — this is relay-side, not tunnel-side"
  else
    DIAG="relay answers locally (${LOCAL_CODE}) but the tunnel path returns ${PUBLIC_CODE} — this is tunnel-side"
  fi
  log "probe ${PUBLIC_URL}${PROBE_PATH} -> ${PUBLIC_CODE}, local -> ${LOCAL_CODE} (${FAILS}/${PROBE_FAIL_LIMIT}); ${DIAG}"

  if (( FAILS >= PROBE_FAIL_LIMIT )); then
    log "unhealthy ${FAILS}x — exiting so pm2 restarts it"
    notify "CT senate tunnel unhealthy" \
      "${PUBLIC_URL}${PROBE_PATH} returned HTTP ${PUBLIC_CODE} (local ${LOCAL_CODE}) ${FAILS} times. ${DIAG}. Restarting the tunnel; the hostname ${TUNNEL_HOSTNAME} is permanent, so SENATE_RELAY_URL does not need changing." 1
    kill "$CF_PID" 2>/dev/null
    exit 1
  fi
done

wait "$CF_PID"
STATUS=$?
log "cloudflared exited with status ${STATUS}"
exit "${STATUS:-1}"

# History — why the hostname used to move, and why it cannot now
# ---------------------------------------------------------------
# Until 2026-08-12 this ran `cloudflared tunnel --url http://127.0.0.1:8899`, a
# TryCloudflare *quick* tunnel. Cloudflare mints a brand-new random
# `*.trycloudflare.com` hostname on every start and kills the previous one, while
# the server reaches the relay through `SENATE_RELAY_URL`, a static binding. So
# every restart silently repointed the tunnel while the server kept dialling a
# dead host. It rotated 4 hostnames across 3 restarts on 2026-08-11 before anyone
# noticed; the old hostname resolved to nothing while the new one served fine.
# ecosystem.config.js documented "update SENATE_RELAY_URL when it changes" as a
# MANUAL step — that step is precisely what failed, and a manual step in a
# machine's restart path is a defect, not a procedure.
#
# The interim wrapper recorded the assigned hostname and paged the owner the
# moment it rotated. All of that machinery existed only because quick tunnels
# rotate; the named tunnel removed the reason for it, so it was removed too
# rather than left behind to imply a permanent hostname might still move.
