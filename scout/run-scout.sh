#!/usr/bin/env bash
# PM2 entrypoint for congress-scout (residential latency eyes).
# Loads secrets from scout/.env then ~/.secrets/global-api-keys (later wins for keys we care about).
# Never echo secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCOUT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Optional local overrides (CT_INGEST_*, paths, flags)
if [[ -f "$SCOUT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCOUT_DIR/.env"
  set +a
fi

# Global secrets file (FMP / RapidAPI / UW / Quiver) — names only; values stay in env
GLOBAL_KEYS="${HOME}/.secrets/global-api-keys"
if [[ -f "$GLOBAL_KEYS" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$GLOBAL_KEYS"
  set +a
fi

# Map global names → scout env expectations
export FMP_LATENCY_API_KEY="${FMP_LATENCY_API_KEY:-${FMP_API_KEY:-}}"
export FMP_API_KEY="${FMP_API_KEY:-${FMP_LATENCY_API_KEY:-}}"
export RAPIDAPI_KEY="${RAPIDAPI_KEY:-}"
export FMP_RAPIDAPI_KEY="${FMP_RAPIDAPI_KEY:-${RAPIDAPI_KEY:-}}"
export UNUSUAL_WHALES_API_KEY="${UNUSUAL_WHALES_API_KEY:-${UNUSUALWHALES_API_KEY:-}}"
export UNUSUALWHALES_API_KEY="${UNUSUALWHALES_API_KEY:-${UNUSUAL_WHALES_API_KEY:-}}"
export UW_API_KEY="${UW_API_KEY:-${UNUSUAL_WHALES_API_KEY:-${UNUSUALWHALES_API_KEY:-}}}"
export QUIVER_API_TOKEN="${QUIVER_API_TOKEN:-${QUIVERQUANT_API_TOKEN:-}}"
export QUIVER_API_KEY="${QUIVER_API_KEY:-${QUIVER_API_TOKEN:-}}"
export QQ_API_KEY="${QQ_API_KEY:-${QUIVER_API_KEY:-${QUIVER_API_TOKEN:-}}}"

# Defaults for CT latency race on the Mac
export FMP_PROBE_ENABLED="${FMP_PROBE_ENABLED:-1}"
export FMP_PATHS="${FMP_PATHS:-stable,rapidapi}"
export STATE_FILE="${STATE_FILE:-$SCOUT_DIR/scout-state.json}"
export LEADS_FILE="${LEADS_FILE:-$SCOUT_DIR/scout-leads.jsonl}"
export SOURCES="${SOURCES:-house,senate}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "run-scout: node not found on PATH" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCOUT_DIR/congress-scout.mjs"
