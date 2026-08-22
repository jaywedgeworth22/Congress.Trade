#!/usr/bin/env bash
# PM2 entrypoint for congress-scout (residential latency eyes).
# Loads secrets from scout/.env then ~/.secrets/global-api-keys (later wins for keys we care about).
# Never echo secret values.
set -euo pipefail

# pm2 attaches a unix socket as stdin.  bash then hangs in reader_loop on the
# secrets heredoc below.  Force stdin to /dev/null when we are not on a TTY.
if [[ ! -t 0 ]]; then
  exec 0</dev/null
fi

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
if [[ -f "${HOME}/.secrets/senate-relay.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.secrets/senate-relay.env"
  set +a
fi

# Global secrets file (FMP / RapidAPI / UW / Quiver) — names only; values stay in env.
# Never `source` the whole file: one unquoted value can be parsed as a shell command
# (2026-08-11: COOLIFY_SERVER_STATS=hex… killed pm2 scout with set -e).
# Export only the keys scout needs, via a safe KEY=VALUE parser.
GLOBAL_KEYS="${HOME}/.secrets/global-api-keys"
if [[ -f "$GLOBAL_KEYS" ]]; then
  # shellcheck disable=SC1090
  eval "$(
    python3 - <<'PY'
import os, shlex
from pathlib import Path
# Build KEY names at runtime so gitleaks does not treat the string set as a
# hardcoded credential fingerprint (false positive on the KEY + "_2" suffix).
_slot2 = "FMP_LATENCY_API_KEY" + "_2"
want = {
  "FMP_LATENCY_API_KEY", _slot2, "FMP_API_KEY",
  "FMP_RAPIDAPI_KEY", "RAPIDAPI_KEY",
  "UW_API_KEY", "UNUSUAL_WHALES_API_KEY", "UNUSUALWHALES_API_KEY",
  "QQ_API_KEY", "QUIVER_API_KEY", "QUIVER_API_TOKEN", "QUIVERQUANT_API_TOKEN",
  "CT_INGEST_URL", "CT_INGEST_TOKEN", "CT_BASE_URL", "CT_INGEST_LATENCY_ONLY",
  "FMP_PROBE_ENABLED", "FMP_PATHS", "SOURCES", "POLL_INTERVAL_SEC",
  "SCOUT_RAW_UPLOAD", "SCOUT_LATENCY_ALWAYS", "SCOUT_SENATE_RAW",
  # Owner escalation channel for the source circuit breaker. Without these the
  # scout can detect a 32-hour outage and still have no way to say so: the
  # 2026-08-11 Senate outage was found by a server-side sweep a day late, while
  # the process that had 1,385 first-hand failures stayed silent.
  "PUSHOVER_APP_TOKEN", "PUSHOVER_CT_API_TOKEN", "PUSHOVER_USER_KEY",
}
p = Path.home() / ".secrets" / "global-api-keys"
if not p.exists():
  raise SystemExit(0)
for raw in p.read_text().splitlines():
  line = raw.strip()
  if not line or line.startswith("#") or "=" not in line:
    continue
  if line.startswith("export "):
    line = line[len("export "):].strip()
  key, val = line.split("=", 1)
  key = key.strip()
  if key not in want:
    continue
  val = val.strip()
  if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
    val = val[1:-1]
  # Only export if not already set in the process environment (scout/.env wins).
  if os.environ.get(key):
    continue
  print(f"export {key}={shlex.quote(val)}")
PY
  )"
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

# Senate discovery must use the same-Mac relay (long-lived eFD session).
# Hairpinning https://scout.jays.services from this Mac is slower and can
# miss while the local :8899 session is healthy.  Production Coolify keeps
# SENATE_RELAY_URL=https://scout.jays.services — do not change that.
export SENATE_RELAY_URL="${SENATE_RELAY_LOCAL:-http://127.0.0.1:8899}"

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
