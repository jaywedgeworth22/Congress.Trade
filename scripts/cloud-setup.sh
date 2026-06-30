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
# Keep KNOWN_VARS synced from app/.dev.vars.example. A few runtime selectors and
# provider keys are also included so a sandbox can override wrangler.toml [vars]
# defaults or test optional providers before those names appear in the template.
# ---------------------------------------------------------------------------
KNOWN_VARS=(
  PRICE_PROVIDER FMP_MAX_PER_MINUTE
  MISTRAL_API_KEY XAI_API_KEY
  FINNHUB_API_KEY INTRINIO_API_KEY TWELVEDATA_API_KEY MASSIVE_API_KEY
)
if [ -f .dev.vars.example ]; then
  while IFS= read -r name; do
    case " ${KNOWN_VARS[*]} " in
      *" $name "*) ;;
      *) KNOWN_VARS+=("$name") ;;
    esac
  done < <(sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' .dev.vars.example)
fi
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
