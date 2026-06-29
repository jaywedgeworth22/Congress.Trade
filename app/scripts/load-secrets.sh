#!/usr/bin/env bash
# Materialize Congress.Trade secrets from the shared + congress-trade Infisical
# projects (Worker can't read Infisical at runtime, so we sync into its stores).
#
# Single-identity model (free-tier friendly): one machine identity holds Viewer on
# all three projects, OR — for local dev — an interactive `infisical login` session.
#
# Auth precedence:
#   1. INFISICAL_TOKEN already in the env  -> used as-is
#   2. ~/.config/infisical/shared.env      -> machine-identity universal auth
#   3. neither                             -> interactive `infisical login` session
#
#   dev  -> writes app/.dev.vars        (then: npm run dev)
#   prod -> pushes Cloudflare secrets   (PRODUCTION-affecting)
#   bash app/scripts/load-secrets.sh [dev|prod]
set -euo pipefail

MODE="${1:-dev}"
SHARED_PROJECT=18f563a3-9c88-454c-96eb-28fc9678f3ba
CT_PROJECT=f61a79de-8d77-4f0b-9361-4b7208598290

cd "$(dirname "$0")/.."            # -> app/
[ -f wrangler.toml ] || { echo "run inside the Congress.Trade app/ dir"; exit 1; }
command -v infisical >/dev/null || { echo "infisical CLI not found"; exit 127; }
command -v jq >/dev/null || { echo "jq not found"; exit 127; }

AUTH_FILE="${INFISICAL_AUTH_FILE:-$HOME/.config/infisical/shared.env}"
if [ -n "${INFISICAL_TOKEN:-}" ]; then
  echo "==> Auth: INFISICAL_TOKEN from environment"
elif [ -f "$AUTH_FILE" ]; then
  echo "==> Auth: machine identity ($AUTH_FILE)"
  set -a; . "$AUTH_FILE"; set +a
  : "${INFISICAL_CLIENT_ID:?$AUTH_FILE is missing INFISICAL_CLIENT_ID}"
  : "${INFISICAL_CLIENT_SECRET:?$AUTH_FILE is missing INFISICAL_CLIENT_SECRET}"
  export INFISICAL_TOKEN="$(infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" --client-secret="$INFISICAL_CLIENT_SECRET" --plain --silent)"
else
  echo "==> Auth: interactive session (run 'infisical login' first if this fails)"
fi

case "$MODE" in
  dev)
    # shared first, app second (app wins any name collision)
    infisical export --projectId "$SHARED_PROJECT" --env dev --format dotenv >  .dev.vars
    infisical export --projectId "$CT_PROJECT"     --env dev --format dotenv >> .dev.vars
    echo "Wrote app/.dev.vars (shared + congress-trade @ dev). Next: npm run dev"
    ;;
  prod)
    echo "!! PROD: writing secrets to the LIVE Cloudflare Worker."
    TMP="$(mktemp -t cf-secrets.XXXXXX)"; trap 'rm -f "$TMP"' EXIT
    jq -s 'add | map({(.key): .value}) | add' \
      <(infisical export --projectId "$SHARED_PROJECT" --env prod --format json) \
      <(infisical export --projectId "$CT_PROJECT"     --env prod --format json) > "$TMP"
    echo "Pushing $(jq 'length' "$TMP") secrets via wrangler secret bulk..."
    npx wrangler secret bulk "$TMP"
    ;;
  *) echo "usage: $0 [dev|prod]"; exit 2 ;;
esac
