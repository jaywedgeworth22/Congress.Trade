#!/bin/bash
# ct-reattach-proxy.sh — keep congress-app reachable from Traefik on the
# `coolify` network under a stable DNS alias, and keep the dynamic route file
# pointed at that alias.
#
# Install (Coolify / Hetzner host):
#   install -m 0755 scripts/ops/ct-reattach-proxy.sh /usr/local/bin/
#   cron: * * * * * root /usr/local/bin/ct-reattach-proxy.sh >/var/log/ct-reattach-proxy.log 2>&1
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

set -euo pipefail

NETWORK="${NETWORK:-coolify}"
ALIAS="${ALIAS:-congress-app}"
DYNAMIC_FILE="${DYNAMIC_FILE:-/data/coolify/proxy/dynamic/congress-trade.yml}"

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

# Keep dynamic route file pointed at the alias (idempotent, no network impact).
cat > "$DYNAMIC_FILE" <<EOF
http:
  middlewares:
    congress-gzip:
      compress: true
  routers:
    congress-http:
      rule: "Host(\`congress.trade\`) || Host(\`www.congress.trade\`) || Host(\`admin.congress.trade\`)"
      entryPoints: [http]
      service: congress-svc
    congress-https:
      rule: "Host(\`congress.trade\`) || Host(\`www.congress.trade\`) || Host(\`admin.congress.trade\`)"
      entryPoints: [https]
      middlewares: [congress-gzip]
      service: congress-svc
      tls: {}
  services:
    congress-svc:
      loadBalancer:
        servers:
          - url: "http://${ALIAS}:5000"
EOF
