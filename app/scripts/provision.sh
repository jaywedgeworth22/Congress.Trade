#!/usr/bin/env bash
# provision.sh — one-shot Cloudflare resource provisioning for congress-feed.
#
# Prereqs: `npx wrangler login` (or CLOUDFLARE_API_TOKEN set) and run from app/.
# Creates D1 + KV + R2 + queues, patches wrangler.toml with the real IDs, and
# applies migrations. Safe to re-run: existing resources are skipped.
#
#   cd app && bash scripts/provision.sh
set -uo pipefail
cd "$(dirname "$0")/.."

WRANGLER="npx wrangler"
TOML="wrangler.toml"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

patch_toml() { # $1=placeholder  $2=value
  if grep -q "$1" "$TOML"; then
    sed -i.bak "s|$1|$2|" "$TOML" && rm -f "$TOML.bak"
    echo "   patched $1 -> $2"
  else
    echo "   ($1 already replaced; leaving as-is)"
  fi
}

say "D1 database (congress-feed-db)"
D1_OUT=$($WRANGLER d1 create congress-feed-db 2>&1) || echo "$D1_OUT" | grep -qi "already exists" || { echo "$D1_OUT"; }
echo "$D1_OUT"
D1_ID=$(echo "$D1_OUT" | grep -oE 'database_id = "[^"]+"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
[ -n "${D1_ID:-}" ] && patch_toml "PLACEHOLDER_D1_DATABASE_ID" "$D1_ID" || \
  echo "   !! couldn't auto-detect database_id — if the DB already exists, run '$WRANGLER d1 list' and paste it into $TOML"

say "KV namespace (CONFIG_KV)"
KV_OUT=$($WRANGLER kv namespace create CONFIG_KV 2>&1)
echo "$KV_OUT"
KV_ID=$(echo "$KV_OUT" | grep -oE 'id = "[^"]+"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
[ -n "${KV_ID:-}" ] && patch_toml "PLACEHOLDER_KV_NAMESPACE_ID" "$KV_ID" || \
  echo "   !! couldn't auto-detect KV id — run '$WRANGLER kv namespace list' and paste it into $TOML"

say "R2 bucket (congress-feed-raw)"
$WRANGLER r2 bucket create congress-feed-raw 2>&1 | sed 's/^/   /' || true

say "Queues + dead-letter queues"
for q in congress-feed-ingest congress-feed-delivery congress-feed-ingest-dlq congress-feed-delivery-dlq; do
  $WRANGLER queues create "$q" 2>&1 | sed 's/^/   /' || true
done

say "Apply D1 migrations (remote)"
$WRANGLER d1 migrations apply DB --remote 2>&1 | sed 's/^/   /'

say "Done. Remaining manual steps:"
cat <<'EOF'
   1. Secrets:
        npx wrangler secret put GEMINI_API_KEY       # scanned-PDF OCR
        npx wrangler secret put WEBHOOK_SIGNING_KEY   # outbound webhook HMAC
        npx wrangler secret put ADMIN_TOKEN           # locks the /api/admin routes
   2. (optional) Seed ticker resolution:
        node scripts/seed_securities.mjs && \
          npx wrangler d1 execute DB --remote --file=scripts/securities_master.sql
   3. Deploy:
        npm run deploy
   4. Backfill history (dry run first):
        curl -X POST https://<host>/api/admin/backfill -H 'authorization: Bearer <ADMIN_TOKEN>' \
             -H 'content-type: application/json' -d '{"dryRun":true}'
EOF
