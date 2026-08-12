#!/bin/bash
# ct-reattach-proxy.sh — keep congress-app reachable from Traefik on the
# `coolify` network under a stable DNS alias, and keep the dynamic route file
# pointed at that alias.
#
# Install (Coolify / Hetzner host):
#   install -m 0755 scripts/ops/ct-reattach-proxy.sh /usr/local/bin/
#   cron: * * * * * root /usr/local/bin/ct-reattach-proxy.sh >/var/log/ct-reattach-proxy.log 2>&1
#
# THIS FILE IS THE ENTIRE PUBLIC ROUTE FOR congress.trade.
#   The app container carries NO traefik.* labels (verified 2026-08-12) and the
#   proxy runs with `--providers.docker.exposedbydefault=false`, so Traefik's
#   Docker provider produces nothing for this app. The only thing that puts
#   congress.trade on the internet is the file this script writes into
#   /data/coolify/proxy/dynamic/, which Traefik watches with
#   `--providers.file.directory=/traefik/dynamic/ --providers.file.watch=true`.
#
# IMPORTANT (2026-08-10): this script used to disconnect and reconnect the
# container from the `coolify` network on EVERY run, including when it was
# already correctly attached. At one run per minute that produced a brief
# unreachable window every 60s — intermittent 502/503 at the edge, and a
# once-a-minute `health FAIL 1/2 -> ok` oscillation in congress-health-recover.
# Those phantom failures also drained the watchdog's hourly restart budget, so
# when the app genuinely died it refused to remediate.
#
# The reconnect is now conditional: it only touches the network when the
# container is missing from `coolify` or is attached WITHOUT the expected
# alias. A correctly-attached container is left alone.
#
# IMPORTANT (2026-08-12): the route file used to be rewritten with
# `cat > "$DYNAMIC_FILE"` on EVERY run. That opens the watched file with
# O_TRUNC, so the file Traefik is watching is momentarily EMPTY. An empty file
# is valid YAML (null), so a reload landing in that window applies a
# configuration with no congress routers at all — and Coolify's own
# `default_redirect_503.yaml` installs a `catchall` router (priority -1000)
# pointing at a service `noop` whose server list is literally `{}`. Traefik's
# load balancer with zero servers answers:
#
#     HTTP 503   no available server
#
# which is exactly the error the owner hit on 2026-08-12. A merely *dead*
# backend does not produce that string — an unresolvable `congress-app` alias
# gives 502 Bad Gateway. "no available server" means the request fell through
# to the catch-all, i.e. our routers were not in the running config.
#
# Two changes remove that window entirely:
#   1. Steady state writes NOTHING. The rendered config is byte-compared with
#      what is already on disk and the file is left untouched when equal, so
#      Traefik sees no inotify event at all (previously: 1440 events/day, each
#      one a chance to catch the file mid-truncate).
#   2. A genuine change is staged in /data/coolify/proxy (mounted into the
#      proxy, but NOT the watched directory) and moved into place with `mv`,
#      which is an atomic rename on the same filesystem. Traefik therefore only
#      ever sees the complete old file or the complete new one.
#      The staging file must NOT live in dynamic/ — Traefik parses every file
#      in that directory, so a temp copy there would briefly duplicate every
#      router name.
#
# The route file is also now written independently of the container: if
# congress-app is missing (mid-deploy, for example) the routers must still
# exist, otherwise the catch-all takes over and turns a 502 into a bare
# "no available server".

set -euo pipefail

NETWORK="${NETWORK:-coolify}"
ALIAS="${ALIAS:-congress-app}"
DYNAMIC_FILE="${DYNAMIC_FILE:-/data/coolify/proxy/dynamic/congress-trade.yml}"
# Same filesystem as DYNAMIC_FILE, outside the directory Traefik watches.
STAGE_DIR="${STAGE_DIR:-/data/coolify/proxy}"
STANDBY_NAME="${STANDBY_NAME:-congress-standby}"
STANDBY_PORT="${STANDBY_PORT:-8080}"

# --- render the desired route file ----------------------------------------
#
# Two shapes:
#   * plain      — one server, no Traefik health check. A health check here
#                  would be actively harmful: if it ever failed, congress-svc
#                  would have zero healthy servers and Traefik would answer
#                  "no available server" for every request. Without one,
#                  Traefik just proxies and a dead backend gives 502.
#   * failover   — used only when the standby container (installed by
#                  ct-standby.service, deliberately OUTSIDE the Coolify
#                  project so a deploy cannot remove it) is actually running.
#                  Traefik's `failover` service requires a health check on the
#                  primary; that check is what flips traffic to the holding
#                  page during the deploy window and back again afterwards.
#                  It probes `/health` — the trivial `{"ok":true}` liveness
#                  route — NOT `/api/health`, which returns 503 on database or
#                  schema trouble and would divert live traffic to a holding
#                  page while the app was still serving.
render_config() {
  local standby_running="$1"
  local svc="congress-svc"
  [[ -n "$standby_running" ]] && svc="congress-front"

  cat <<EOF
# Generated by ct-reattach-proxy.sh — do not edit by hand.
http:
  middlewares:
    congress-gzip:
      compress: true
  routers:
    congress-http:
      rule: "Host(\`congress.trade\`) || Host(\`www.congress.trade\`) || Host(\`admin.congress.trade\`)"
      entryPoints: [http]
      service: ${svc}
    congress-https:
      rule: "Host(\`congress.trade\`) || Host(\`www.congress.trade\`) || Host(\`admin.congress.trade\`)"
      entryPoints: [https]
      middlewares: [congress-gzip]
      service: ${svc}
      tls: {}
  services:
EOF

  if [[ -n "$standby_running" ]]; then
    cat <<EOF
    congress-front:
      failover:
        service: congress-svc
        fallback: congress-standby
    congress-svc:
      loadBalancer:
        servers:
          - url: "http://${ALIAS}:5000"
        healthCheck:
          path: /health
          interval: 3s
          timeout: 2s
    congress-standby:
      loadBalancer:
        servers:
          - url: "http://${STANDBY_NAME}:${STANDBY_PORT}"
EOF
  else
    cat <<EOF
    congress-svc:
      loadBalancer:
        servers:
          - url: "http://${ALIAS}:5000"
EOF
  fi
}

STANDBY_RUNNING=""
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$STANDBY_NAME"; then
  STANDBY_RUNNING=1
fi

DESIRED=$(render_config "$STANDBY_RUNNING")

if [[ -f "$DYNAMIC_FILE" ]] && [[ "$(cat "$DYNAMIC_FILE")" == "$DESIRED" ]]; then
  : # steady state: identical, so do not touch the watched file at all
else
  TMP=$(mktemp "${STAGE_DIR}/.ct-reattach-proxy.XXXXXX")
  printf '%s\n' "$DESIRED" > "$TMP"
  chmod 0644 "$TMP"
  mv -f "$TMP" "$DYNAMIC_FILE"   # atomic rename; Traefik never sees a partial file
  echo "route file updated (standby=${STANDBY_RUNNING:-0})"
fi

# --- keep the container aliased on the proxy network ----------------------
APP=$(docker ps --format "{{.Names}}" | grep -E "congress-app-" | head -1 || true)
if [[ -z "${APP}" ]]; then
  echo "no congress-app container"; exit 0
fi

# Aliases the container currently advertises on $NETWORK (empty if not attached).
current_aliases=$(docker inspect "$APP" \
  --format "{{range \$net, \$conf := .NetworkSettings.Networks}}{{if eq \$net \"${NETWORK}\"}}{{range \$conf.Aliases}}{{.}} {{end}}{{end}}{{end}}" \
  2>/dev/null || true)

if [[ -z "$current_aliases" ]]; then
  # Not on the network at all — attach.
  docker network connect --alias "$ALIAS" "$NETWORK" "$APP" || true
  echo "attached $APP to $NETWORK as $ALIAS"
elif ! printf '%s' "$current_aliases" | tr ' ' '\n' | grep -qx "$ALIAS"; then
  # On the network but missing the alias — this is the only case that needs a
  # disconnect/reconnect, since aliases cannot be added to a live endpoint.
  docker network disconnect "$NETWORK" "$APP" 2>/dev/null || true
  docker network connect --alias "$ALIAS" "$NETWORK" "$APP" || true
  echo "re-aliased $APP on $NETWORK as $ALIAS (was: $current_aliases)"
else
  echo "ok: $APP already on $NETWORK as $ALIAS"
fi
