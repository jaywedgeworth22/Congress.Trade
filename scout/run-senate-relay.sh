#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8899}"
exec /Users/jay/.deno/bin/deno run --allow-net --allow-env scout/senate-relay.ts "$PORT"
