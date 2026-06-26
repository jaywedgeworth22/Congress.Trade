#!/usr/bin/env bash
# Canonical setup for a fresh, isolated checkout of Congress.Trade (Claude Code
# cloud/remote sandbox, GitHub Codespaces, devcontainer, or any throwaway clone).
# Idempotent — safe to re-run.
#
# Point your environment's "setup script" field at this file:
#   bash scripts/cloud-setup.sh
#
# The runnable app lives in app/ (a Cloudflare Worker), NOT the repo root — so a
# plain `npm ci` from the root fails. This script cd's into app/ for you.
#
# Local dev is keyless: `wrangler dev` simulates D1/R2/KV/Queues locally, so no
# Cloudflare login or API keys are required to boot, typecheck, or test. Inject
# keys (FMP_API_KEY, GEMINI_API_KEY, ADMIN_OPEN_IN_DEV=true, …) only to exercise
# those features. NEVER put production secrets (sk_live_*, the prod ADMIN_TOKEN /
# INGEST_TOKEN, the real WEBHOOK_SIGNING_KEY) in a throwaway environment.
set -euo pipefail

# The buildable app lives in app/, not the repo root.
cd "$(dirname "$0")/../app"

echo "==> Node: $(node --version 2>/dev/null || echo 'not found')  npm: $(npm --version 2>/dev/null || echo 'not found')"

# Deterministic install from the committed lockfile (app/package-lock.json).
# --include=dev forces devDependencies (wrangler, typescript, vitest) even when the
# cloud env sets NODE_ENV=production — npm would otherwise omit them, breaking the
# very dev / typecheck / test commands this bootstrap is meant to prepare.
echo "==> Installing dependencies (npm ci --include=dev)"
npm ci --include=dev

# ---------------------------------------------------------------------------
# Merge env-provided values into app/.dev.vars.
#
# `wrangler dev` reads secrets from .dev.vars (and [vars] in wrangler.toml) — NOT
# from the OS environment. So a value set in the cloud "environment variables"
# field does not reach the Worker as env.X unless it is written here.
#
# Non-destructive MERGE (not a one-shot create): existing keys — hand-edited or
# from a prior run — are never overwritten, and vars you add to the cloud
# environment LATER are appended on the next run. No file is created when nothing
# is set, so an empty .dev.vars can never lock out a later top-up.
#
# Keep KNOWN_VARS in sync with app/.dev.vars.example. PRICE_PROVIDER (and other
# runtime selectors) are included so a sandbox can override the wrangler.toml
# [vars] default — otherwise the Worker silently keeps the committed default even
# though the provider keys were written.
# ---------------------------------------------------------------------------
KNOWN_VARS=(
  GEMINI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY MISTRAL_API_KEY XAI_API_KEY
  ARBITRATION_API_KEY ARBITRATION_ENABLED ARBITRATION_MODEL
  PRICE_PROVIDER FMP_API_KEY FMP_DAILY_CALL_CAP
  WEBHOOK_SIGNING_KEY
  ADMIN_TOKEN ADMIN_OPEN_IN_DEV INGEST_TOKEN
  ADMIN_EMAILS ACCESS_AUD ACCESS_TEAM_DOMAIN
  APP_B_IMPORT_URL APP_B_INGEST_TOKEN
  SEED_HOUSE_URL SEED_SENATE_URL HOUSE_LIVE_SEARCH_ENABLED
  GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET RESEND_API_KEY EMAIL_FROM APP_BASE_URL ALERT_EMAIL
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_MONTHLY STRIPE_PRICE_ANNUAL STRIPE_TRIAL_DAYS
  IMPORT_MAX_BYTES IMPORT_MAX_REFS IMPORT_MAX_SPX IMPORT_MAX_PRICES IMPORT_MAX_CLOSES_PER_TICKER IMPORT_MAX_INSIDER IMPORT_MAX_SHORT_VOLUME
  FINNHUB_API_KEY INTRINIO_API_KEY TWELVEDATA_API_KEY MASSIVE_API_KEY
)
merged=0
for name in "${KNOWN_VARS[@]}"; do
  value="${!name:-}"
  [ -n "$value" ] || continue                                   # skip unset / empty
  [ -f .dev.vars ] && grep -q "^${name}=" .dev.vars && continue # already present — never overwrite
  value="${value//\\/\\\\}"                                     # escape backslashes
  value="${value//\"/\\\"}"                                     # escape double quotes
  printf '%s="%s"\n' "$name" "$value" >> .dev.vars              # creates the file only when we write
  merged=$((merged + 1))
done
if [ "$merged" -gt 0 ]; then
  echo "==> app/.dev.vars: merged $merged var(s) from the environment"
else
  echo "==> app/.dev.vars: nothing to merge (keyless run)"
fi

# Build the local D1 dev database so `wrangler dev` has a working schema.
# `--local` operates on a local SQLite file (no Cloudflare login). CI=true keeps
# wrangler non-interactive so it cannot hang on a confirmation prompt; the
# fallback keeps a migrate hiccup from failing the whole setup.
echo "==> Applying local D1 migrations (wrangler d1 ... --local)"
CI=true npm run migrate || echo "==> migrate skipped — run 'cd app && npm run migrate' manually if needed"

echo "==> Setup complete."
echo "    Dev:    cd app && npm run dev        (wrangler on http://localhost:8787)"
echo "    Verify: cd app && npm run typecheck && npm test"
