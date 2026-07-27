#!/bin/bash
set -e
source /Users/jay/.secrets/global-api-keys.env
export CLOUDFLARE_API_TOKEN=$CLOUDFLARE_CT_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_CT_ACCOUNT_ID

BUCKET="congress-trade-bucket"
PREFIX="historical-dumps/2026-07-24"
DIR="/Users/jay/.gemini/antigravity/brain/46787371-bd2d-4703-a05d-cf01380534f5/scratch"

for file in "$DIR"/*.json; do
  if [ -f "$file" ]; then
    filename=$(basename "$file")
    echo "Uploading $filename..."
    npx wrangler r2 object put "$BUCKET/$PREFIX/$filename" --file="$file" --remote
  fi
done

for file in "$DIR"/*.yaml; do
  if [ -f "$file" ]; then
    filename=$(basename "$file")
    echo "Uploading $filename..."
    npx wrangler r2 object put "$BUCKET/$PREFIX/$filename" --file="$file" --remote
  fi
done
echo "Done!"
