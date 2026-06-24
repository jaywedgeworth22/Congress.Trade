#!/usr/bin/env bash
# provision-preview.sh — create isolated Cloudflare resources for preview review.
#
# This does NOT edit wrangler.toml and does NOT touch congress.trade resources.
# It writes app/wrangler.preview.toml, which is ignored by git.
#
#   cd app && bash scripts/provision-preview.sh
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="${WRANGLER:-npx wrangler}"
CONFIG="wrangler.preview.toml"
EXAMPLE="wrangler.preview.example.toml"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
need_id() {
  local label="$1" value="$2"
  if [ -z "$value" ]; then
    echo "Could not detect $label id from Wrangler output. Copy it manually into $CONFIG."
    exit 1
  fi
}

if [ ! -f "$CONFIG" ]; then
  cp "$EXAMPLE" "$CONFIG"
  echo "Created $CONFIG from $EXAMPLE"
fi

say "D1 preview database"
D1_OUT=$($WRANGLER d1 create congress-feed-preview-db 2>&1 || true)
echo "$D1_OUT"
D1_ID=$(echo "$D1_OUT" | grep -oE 'database_id = "[^"]+"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
if [ -z "$D1_ID" ]; then
  D1_ID=$($WRANGLER d1 list 2>/dev/null | awk '/congress-feed-preview-db/ { print $2; exit }' || true)
fi
need_id "D1" "$D1_ID"

say "KV preview namespace"
KV_OUT=$($WRANGLER kv namespace create congress-feed-preview-config --binding CONFIG_KV_PREVIEW 2>&1 || true)
echo "$KV_OUT"
KV_ID=$(echo "$KV_OUT" | grep -oE 'id = "[^"]+"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
if [ -z "$KV_ID" ]; then
  KV_ID=$($WRANGLER kv namespace list 2>/dev/null | awk '
    /"id":/ { gsub(/[",]/, "", $2); id=$2 }
    /"title": "congress-feed-preview-config"/ || /"title": "CONFIG_KV_PREVIEW"/ { print id; exit }
  ' || true)
fi
need_id "KV" "$KV_ID"

python3 - "$CONFIG" "$D1_ID" "$KV_ID" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
text = text.replace("PREVIEW_D1_DATABASE_ID", sys.argv[2])
text = text.replace("PREVIEW_KV_NAMESPACE_ID", sys.argv[3])
path.write_text(text)
PY

say "R2 preview bucket"
$WRANGLER r2 bucket create congress-feed-preview-raw 2>&1 | sed 's/^/   /' || true

say "Preview queues"
for q in \
  congress-feed-preview-ingest \
  congress-feed-preview-delivery \
  congress-feed-preview-ingest-dlq \
  congress-feed-preview-delivery-dlq
do
  $WRANGLER queues create "$q" 2>&1 | sed 's/^/   /' || true
done

say "Apply preview D1 migrations"
$WRANGLER d1 migrations apply DB --remote --config "$CONFIG"

say "Seed preview fixture rows"
$WRANGLER d1 execute DB --remote --config "$CONFIG" --file scripts/seed-preview-fixtures.sql

say "Preview resources ready"
echo "Next: bash scripts/deploy-preview.sh"
