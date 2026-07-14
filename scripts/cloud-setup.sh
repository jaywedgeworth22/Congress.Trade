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
# Local runtime configuration comes from Infisical. This setup maps the
# app/shared machine-identity bootstrap credentials plus a narrow documented set
# of env-only/local selectors into app/.dev.vars. Provider and app secrets remain
# in Infisical and are resolved by the Worker at runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The buildable app lives in app/, not the repo root.
cd "$SCRIPT_DIR/../app"

echo "==> Node: $(node --version 2>/dev/null || echo 'not found')  npm: $(npm --version 2>/dev/null || echo 'not found')"

# Parse the optional machine-level key file as inert data (never source it),
# validate complete identity pairs, map canonical CT names to the runtime names,
# preserve non-empty managed app/.dev.vars values, and retain only the documented
# early-init/local selectors from the explicit environment. This runs before the
# expensive install so malformed bootstrap state fails closed immediately.
unset CT_LOCAL_BOOTSTRAP_TEST_MODE
unset CT_LOCAL_BOOTSTRAP_TEST_APP_DIR
unset CT_LOCAL_BOOTSTRAP_TEST_DEV_VARS_FILE
unset CT_LOCAL_BOOTSTRAP_TEST_GLOBAL_KEYS_FILE
node "$SCRIPT_DIR/merge-local-dev-vars.mjs"

# ---------------------------------------------------------------------------
# @jaywedgeworth22/congress-trading-shared is published to GitHub Packages
# (see app/.npmrc), which requires an authenticated npm request even for a
# public read — an anonymous `npm ci` fails with 401. Mirror what CI does
# (.github/workflows/ci.yml): write a token to a user-level .npmrc so the
# scope resolves, without touching the committed app/.npmrc.
# Set one of these as a cloud-environment variable — a classic PAT with
# `read:packages` scope on the jaywedgeworth22 org is enough; a fine-grained
# token needs read access to the congress-trading-shared package.
NODE_AUTH_TOKEN="${NODE_AUTH_TOKEN:-${GH_PACKAGES_TOKEN:-${GH_PAT:-${GITHUB_TOKEN:-}}}}"
if [ -n "$NODE_AUTH_TOKEN" ]; then
  printf '//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" >> "$HOME/.npmrc"
  echo "==> GitHub Packages: authenticated for @jaywedgeworth22 scope"
else
  echo "==> WARNING: no NODE_AUTH_TOKEN / GH_PACKAGES_TOKEN / GH_PAT / GITHUB_TOKEN set." >&2
  echo "    npm ci will fail to fetch @jaywedgeworth22/congress-trading-shared (private GitHub Packages)." >&2
  echo "    Set NODE_AUTH_TOKEN to a GitHub PAT with read:packages scope in the cloud environment's variables." >&2
fi

# Deterministic install from the committed lockfile (app/package-lock.json).
# --include=dev forces devDependencies (wrangler, typescript, vitest) even when the
# cloud env sets NODE_ENV=production — npm would otherwise omit them, breaking the
# very dev / typecheck / test commands this bootstrap is meant to prepare.
echo "==> Installing dependencies (npm ci --include=dev)"
npm ci --include=dev

# Build the local D1 dev database so `wrangler dev` has a working schema.
# `--local` operates on a local SQLite file (no Cloudflare login). CI=true keeps
# wrangler non-interactive so it cannot hang on a confirmation prompt; the
# fallback keeps a migrate hiccup from failing the whole setup.
echo "==> Applying local D1 migrations (wrangler d1 ... --local)"
CI=true npm run migrate || echo "==> migrate skipped — run 'cd app && npm run migrate' manually if needed"

echo "==> Setup complete."
echo "    Dev:    cd app && npm run dev        (wrangler on http://localhost:8787)"
echo "    Verify: cd app && npm run typecheck && npm test"
