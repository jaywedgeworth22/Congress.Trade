#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# senate-tunnel — HEALTH WATCHER.  It does NOT run cloudflared.
#
# THE HOSTNAME IS STATIC:  https://scout.jays.services  — permanently.
#
# The Senate relay is exposed by **Jay's Tunnel**
# (6fa2a97c-b4f8-420d-94ae-bd9858aff4b6, account Usage.Jays.Services), which is
# already installed as a macOS SYSTEM SERVICE under
# /Library/Application Support/com.cloudflare.cloudflared/ and supervised by
# launchd.  Its ingress is managed remotely (config_src=cloudflare) and already
# carries five other hostnames on this machine:
#
#     agent-sync.jays.services · ssh · remote · acp · jays.services · scout
#
# So there is nothing for pm2 to run.  A second cloudflared process for the same
# origin would be a duplicate tunnel — the exact shape that produced the original
# outage, where a TryCloudflare *quick* tunnel minted a new random hostname on
# every start (4 hostnames across 3 restarts) while the server dialled a static
# SENATE_RELAY_URL.  This entry therefore only WATCHES and ALERTS.
#
# WHY A WATCHER STILL EARNS ITS KEEP:  launchd restarts a *crashed* cloudflared,
# but a cloudflared whose DNS resolver has died stays "online" forever while
# serving nothing — an observed failure on this box
# ("Failed to refresh DNS local resolver ... i/o timeout").  Only an end-to-end
# probe through the public hostname catches that.
#
# WHAT IT DELIBERATELY DOES NOT DO:  it never restarts anything.  launchd owns
# the tunnel and the `senate-relay` pm2 entry owns the relay.  A watcher that
# also restarts is how one outage becomes an alert storm.
# ---------------------------------------------------------------------------
set -uo pipefail

PORT="${SENATE_RELAY_PORT:-8899}"
TUNNEL_HOSTNAME="${SENATE_TUNNEL_HOSTNAME:-scout.jays.services}"
PROBE_PATH="${SENATE_TUNNEL_PROBE_PATH:-/health}"
PROBE_INTERVAL_SEC="${SENATE_TUNNEL_PROBE_SEC:-120}"
PROBE_FAIL_LIMIT="${SENATE_TUNNEL_FAIL_LIMIT:-3}"
SECRETS_FILE="${HOME}/.secrets/global-api-keys"

PUBLIC_URL="https://${TUNNEL_HOSTNAME}"
LOCAL_URL="http://127.0.0.1:${PORT}"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] senate-tunnel: $*" >&2; }

# Read one KEY=VALUE without sourcing the file: a single unquoted value in
# global-api-keys can otherwise be parsed as a shell command (see run-scout.sh's
# note about COOLIFY_SERVER_STATS killing the pm2 scout under `set -e`).
secret_of() {
  [[ -f "$SECRETS_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$SECRETS_FILE" | head -n1 | sed -e 's/^\o042//' -e 's/\o042$//' -e "s/^\o047//" -e "s/\o047$//"
}

# Escalation is throttled so a long outage does not become a page storm on the
# same Pushover app token the scout breaker and the liveness sweeps share.
NOTIFY_MIN_INTERVAL_SEC="${SENATE_TUNNEL_NOTIFY_SEC:-3600}"
LAST_NOTIFY_AT=0

notify() {
  local title="$1" msg="$2" priority="${3:-1}" now
  now=$(date +%s)
  if (( now - LAST_NOTIFY_AT < NOTIFY_MIN_INTERVAL_SEC )); then
    log "escalation suppressed (last page $((now - LAST_NOTIFY_AT))s ago): $title"
    return 0
  fi
  local token user
  token="$(secret_of PUSHOVER_APP_TOKEN)"; [[ -n "$token" ]] || token="$(secret_of PUSHOVER_CT_API_TOKEN)"
  user="$(secret_of PUSHOVER_USER_KEY)"
  if [[ -z "$token" || -z "$user" ]]; then
    log "WARNING cannot escalate — Pushover token/user not found in $SECRETS_FILE"
    return 0
  fi
  # Only record the page as sent if delivery actually succeeded, so a failed
  # send does not silently consume the throttle window.
  if curl -sf -m 15 -o /dev/null \
      --form-string "token=$token" --form-string "user=$user" \
      --form-string "title=$title" --form-string "message=$msg" \
      --form-string "priority=$priority" \
      https://api.pushover.net/1/messages.json; then
    LAST_NOTIFY_AT=$now
    log "escalated: $title"
  else
    log "WARNING escalation delivery FAILED: $title"
  fi
}

probe() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$1$PROBE_PATH" 2>/dev/null || echo 000; }

log "watching $PUBLIC_URL (tunnel is run by launchd, not by this process)"

FAILS=0
while true; do
  LOCAL_CODE="$(probe "$LOCAL_URL")"
  PUBLIC_CODE="$(probe "$PUBLIC_URL")"

  if [[ "$LOCAL_CODE" == "000" ]]; then
    # RELAY-side outage, not tunnel-side.  The `senate-relay` pm2 entry owns
    # this recovery.  Counting it toward the tunnel's failure budget would tear
    # down a perfectly healthy tunnel every few minutes for the whole outage,
    # and page on every cycle — so it is reported once and NOT counted.
    log "relay not answering on 127.0.0.1:${PORT} — relay-side, senate-relay owns this; not counting against the tunnel"
    notify "CT senate-relay down" "Relay not answering on 127.0.0.1:${PORT}. Tunnel not implicated; check the senate-relay pm2 entry." 1
    FAILS=0
  elif [[ "$PUBLIC_CODE" == "000" || "$PUBLIC_CODE" != "$LOCAL_CODE" ]]; then
    FAILS=$((FAILS + 1))
    log "tunnel path unhealthy ($PUBLIC_URL -> $PUBLIC_CODE, local -> $LOCAL_CODE) [$FAILS/$PROBE_FAIL_LIMIT]"
    if (( FAILS >= PROBE_FAIL_LIMIT )); then
      # This is the case launchd cannot see: the relay is fine and cloudflared
      # is "running", but the public path is dead.
      notify "CT Senate tunnel path down" \
        "$PUBLIC_URL -> $PUBLIC_CODE while $LOCAL_URL -> $LOCAL_CODE, ${FAILS}x. Relay is healthy, so this is tunnel/edge side. Jay's Tunnel is a launchd system service: sudo launchctl kickstart -k system/com.cloudflare.cloudflared" 1
      FAILS=0
    fi
  else
    (( FAILS > 0 )) && log "tunnel path recovered ($PUBLIC_CODE)"
    FAILS=0
  fi

  sleep "$PROBE_INTERVAL_SEC"
done
