#!/usr/bin/env bash
#
# Backfill securities reference + price history for every traded ticker by
# looping the /api/admin/backfill-market endpoint until it reports done:true.
#
# A single Worker invocation is bounded by Cloudflare's per-request subrequest /
# CPU limits, so the heavy lifting is done in many small passes driven from here.
# On a paid FMP tier set PER_MIN to your plan's per-minute limit to avoid 429s.
#
# Safety: even though the server now makes done:true reachable (it negative-caches
# un-priceable tickers), this loop ALSO hard-caps its passes and stops on a
# no-progress plateau, so a future regression in the done-logic can never turn
# this back into the infinite loop that ran up a large D1 write/read bill.
#
# Usage:
#   BASE=https://congress.trade TOKEN=your_admin_token ./scripts/backfill-market.sh [MAX] [PER_MIN]
#
# Env:
#   BASE        base URL of the deployed Worker (default https://congress.trade)
#   TOKEN       ADMIN_TOKEN bearer (required unless the admin API is open in dev)
#   SLEEP       seconds to wait between passes (default 2)
#   MAX_PASSES  hard cap on passes before giving up (default 50)
#   STALL_LIMIT consecutive no-progress passes before giving up (default 3)
# Args:
#   MAX      tickers per pass for each of enrich + prices (default 40)
#   PER_MIN  throttle: max FMP calls/min (default 250)
set -euo pipefail

BASE="${BASE:-https://congress.trade}"
TOKEN="${TOKEN:-}"
MAX="${1:-40}"
PER_MIN="${2:-250}"
SLEEP="${SLEEP:-2}"
MAX_PASSES="${MAX_PASSES:-50}"
STALL_LIMIT="${STALL_LIMIT:-3}"

auth=()
[ -n "$TOKEN" ] && auth=(-H "authorization: Bearer $TOKEN")

# Extract an integer field from within the response's "pending" object only, so we
# don't accidentally read the nested enrich/prices result objects. Prints "" when
# absent. `grep` non-matches are tolerated under `set -e` via the `|| true`s.
pending_field() {
  local resp="$1" field="$2" obj
  obj=$(printf '%s' "$resp" | grep -oE '"pending":\{[^}]*\}' || true)
  printf '%s' "$obj" | grep -oE "\"$field\":[0-9]+" | grep -oE '[0-9]+' || true
}

prev_total=""
stall=0
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

  # No-progress guard: if enrich+prices doesn't DECREASE for STALL_LIMIT passes in
  # a row, stop — the remaining work is stuck (or the done-logic regressed) and
  # more passes would just burn D1 reads/writes for nothing.
  enrich=$(pending_field "$resp" enrich)
  prices=$(pending_field "$resp" prices)
  if [ -n "$enrich" ] && [ -n "$prices" ]; then
    total=$((enrich + prices))
    if [ -n "$prev_total" ] && [ "$total" -ge "$prev_total" ]; then
      stall=$((stall + 1))
      if [ "$stall" -ge "$STALL_LIMIT" ]; then
        echo "⛔ stopping: no progress for $stall consecutive passes (pending enrich=$enrich prices=$prices). Investigate before re-running." >&2
        exit 1
      fi
    else
      stall=0
    fi
    prev_total="$total"
  fi

  # Hard cap: never loop forever regardless of progress signals.
  if [ "$i" -ge "$MAX_PASSES" ]; then
    echo "⛔ stopping: reached MAX_PASSES=$MAX_PASSES without done:true (pending enrich=${enrich:-?} prices=${prices:-?})." >&2
    exit 1
  fi

  sleep "$SLEEP"
done
