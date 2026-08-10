#!/bin/bash
# launchd wrapper — loads secrets from the owner secrets file (never prints them).
set -euo pipefail

SECRETS_FILE="${SECRETS_FILE:-$HOME/.secrets/global-api-keys}"
if [[ ! -f "$SECRETS_FILE" && -f "$HOME/.secrets/global-api-keys.env" ]]; then
  SECRETS_FILE="$HOME/.secrets/global-api-keys.env"
fi

load_secret() {
  local key="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  local line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -1 || true)"
  if [[ -n "$line" ]]; then
    printf '%s' "${line#*=}" | tr -d "\"'"
  fi
}

export CONGRESS_TRADE_API_URL="${CONGRESS_TRADE_API_URL:-https://congress.trade}"
export WORKER_ID="${WORKER_ID:-local_mac_1}"
export POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-45}"
export HEARTBEAT_INTERVAL_SEC="${HEARTBEAT_INTERVAL_SEC:-60}"
export MAX_DOCS_PER_POLL="${MAX_DOCS_PER_POLL:-2}"
export MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
export BACKOFF_BASE_SEC="${BACKOFF_BASE_SEC:-90}"
export EXHAUSTED_ALERT_THRESHOLD="${EXHAUSTED_ALERT_THRESHOLD:-5}"
export STATE_FILE="${STATE_FILE:-$HOME/vision-worker/attempt-state.json}"
# PRIMARY: local Grok CLI on owner xAI subscription. OpenRouter is fallback.
export VISION_ENGINE="${VISION_ENGINE:-auto}"
export GROK_BIN="${GROK_BIN:-$HOME/.grok/bin/grok}"
export GROK_CLI_TIMEOUT_SEC="${GROK_CLI_TIMEOUT_SEC:-900}"
export GROK_CLI_MAX_TURNS="${GROK_CLI_MAX_TURNS:-8}"
export OPENROUTER_MODEL="${OPENROUTER_MODEL:-x-ai/grok-4.5}"
export OPENROUTER_TIMEOUT_SEC="${OPENROUTER_TIMEOUT_SEC:-600}"
export PYTHONUNBUFFERED=1

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  export ADMIN_TOKEN="$(load_secret CT_ADMIN_TOKEN "$SECRETS_FILE")"
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  export OPENROUTER_API_KEY="$(load_secret CT_OPENROUTER_API_KEY "$SECRETS_FILE")"
  if [[ -z "${OPENROUTER_API_KEY}" ]]; then
    export OPENROUTER_API_KEY="$(load_secret OPENROUTER_API_KEY "$SECRETS_FILE")"
  fi
fi
if [[ -z "${PUSHOVER_APP_TOKEN:-}" ]]; then
  export PUSHOVER_APP_TOKEN="$(load_secret PUSHOVER_APP_TOKEN "$SECRETS_FILE")"
fi
if [[ -z "${PUSHOVER_USER_KEY:-}" ]]; then
  export PUSHOVER_USER_KEY="$(load_secret PUSHOVER_USER_KEY "$SECRETS_FILE")"
fi

if [[ -z "${ADMIN_TOKEN}" ]]; then
  echo "vision-worker: ADMIN_TOKEN / CT_ADMIN_TOKEN missing" >&2
  exit 2
fi

# local_cli does not need OpenRouter; openrouter/auto-with-fallback do.
if [[ "${VISION_ENGINE}" == "openrouter" && -z "${OPENROUTER_API_KEY}" ]]; then
  echo "vision-worker: OPENROUTER_API_KEY required for VISION_ENGINE=openrouter" >&2
  exit 2
fi

export PATH="$HOME/.grok/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  PYTHON_BIN="/usr/bin/python3"
fi
exec "$PYTHON_BIN" "$(dirname "$0")/worker.py"
