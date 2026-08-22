#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f "${HOME}/.secrets/senate-relay.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.secrets/senate-relay.env"
  set +a
fi
PORT="${1:-8899}"
exec /Users/jay/.deno/bin/deno run --allow-net --allow-env scout/senate-relay.ts "$PORT"
