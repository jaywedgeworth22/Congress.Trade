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

# Map global names → scout / server dual free-tier latency keys.
# Two distinct free FMP accounts → ~2× daily capacity on stable (no known per-IP limit).
export FMP_LATENCY_API_KEY="${FMP_LATENCY_API_KEY:-}"
export FMP_API_KEY="${FMP_API_KEY:-}"
# Prefer explicit _2; else use the other free key if distinct from primary.
if [[ -z "${FMP_LATENCY_API_KEY_2:-}" ]]; then
  if [[ -n "${FMP_API_KEY:-}" && "${FMP_API_KEY}" != "${FMP_LATENCY_API_KEY:-}" ]]; then
    export FMP_LATENCY_API_KEY_2="${FMP_API_KEY}"
  elif [[ -n "${FMP_LATENCY_API_KEY:-}" && -n "${FMP_API_KEY:-}" && "${FMP_API_KEY}" == "${FMP_LATENCY_API_KEY}" ]]; then
    : # same key — leave _2 empty
  fi
fi
# If only FMP_API_KEY is set, promote it to primary latency key.
if [[ -z "${FMP_LATENCY_API_KEY:-}" && -n "${FMP_API_KEY:-}" ]]; then
  export FMP_LATENCY_API_KEY="${FMP_API_KEY}"
fi
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
# Stable only: RapidAPI FMP product does not expose house/senate-latest (404).
export FMP_PATHS="${FMP_PATHS:-stable}"
export STATE_FILE="${STATE_FILE:-$SCOUT_DIR/scout-state.json}"
export LEADS_FILE="${LEADS_FILE:-$SCOUT_DIR/scout-leads.jsonl}"
export SOURCES="${SOURCES:-house,senate}"
# Server-first handoff: scout covers quiet/failed latency sources + raw R2 upload
export SCOUT_RAW_UPLOAD="${SCOUT_RAW_UPLOAD:-1}"
export SCOUT_LATENCY_ALWAYS="${SCOUT_LATENCY_ALWAYS:-0}"
# When CT_INGEST_URL is set, derive base for scout-plan / latency-payload / raw
if [[ -n "${CT_INGEST_URL:-}" && -z "${CT_BASE_URL:-}" ]]; then
  export CT_BASE_URL="$(python3 - <<'PY'
import os
from urllib.parse import urlparse
u=urlparse(os.environ.get("CT_INGEST_URL",""))
print(f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else "")
PY
)"
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "run-scout: node not found on PATH" >&2
  exit 1
fi

# Log free-key count only (never values)
_fk=0
[[ -n "${FMP_LATENCY_API_KEY:-}" ]] && _fk=$((_fk + 1))
if [[ -n "${FMP_LATENCY_API_KEY_2:-}" && "${FMP_LATENCY_API_KEY_2}" != "${FMP_LATENCY_API_KEY:-}" ]]; then
  _fk=$((_fk + 1))
fi
echo "run-scout: starting congress-scout FMP_PATHS=${FMP_PATHS} freeKeys=${_fk}" >&2

exec "$NODE_BIN" "$SCOUT_DIR/congress-scout.mjs"
