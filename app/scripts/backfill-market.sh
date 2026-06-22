#!/usr/bin/env bash
#
# Backfill securities reference + price history for every traded ticker by
# looping the /api/admin/backfill-market endpoint until it reports done:true.
#
# A single Worker invocation is bounded by Cloudflare's per-request subrequest /
# CPU limits, so the heavy lifting is done in many small passes driven from here.
# On a paid FMP tier set PER_MIN to your plan's per-minute limit to avoid 429s.
#
# Usage:
#   BASE=https://congress.trade TOKEN=your_admin_token ./scripts/backfill-market.sh [MAX] [PER_MIN]
#
# Env:
#   BASE     base URL of the deployed Worker (default https://congress.trade)
#   TOKEN    ADMIN_TOKEN bearer (required unless the admin API is open in dev)
#   SLEEP    seconds to wait between passes (default 2)
# Args:
#   MAX      tickers per pass for each of enrich + prices (default 40)
#   PER_MIN  throttle: max FMP calls/min (default 250)
#
set -euo pipefail

BASE="${BASE:-https://congress.trade}"
TOKEN="${TOKEN:-}"
MAX="${1:-40}"
PER_MIN="${2:-250}"
SLEEP="${SLEEP:-2}"

auth=()
[ -n "$TOKEN" ] && auth=(-H "authorization: Bearer $TOKEN")

i=0
while :; do
  i=$((i + 1))
  resp=$(curl -fsS -X POST "$BASE/api/admin/backfill-market" \
    "${auth[@]}" -H 'content-type: application/json' \
    -d "{\"max\":$MAX,\"maxPerMinute\":$PER_MIN}")
  echo "[pass $i] $resp"

  # done:true when nothing is left to enrich or price.
  if printf '%s' "$resp" | grep -q '"done":true'; then
    echo "✅ backfill complete after $i passes"
    break
  fi
  sleep "$SLEEP"
done
