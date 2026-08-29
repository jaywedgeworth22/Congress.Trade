#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROXY_PORT="${PROXY_PORT:-3128}"
export PROXY_HOST="${PROXY_HOST:-0.0.0.0}"

exec /usr/bin/env node "${DIR}/residential-proxy.mjs" "${PROXY_PORT}" "${PROXY_HOST}"
