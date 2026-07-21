#!/usr/bin/env bash
# Codex Cloud maintenance: quick coordination checks on cached-container resume.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Codex Cloud coordination maintenance"

if [ -f docs/EFFORT-LOG.md ]; then
  echo "Effort-log mirror: OK"
else
  echo "Effort-log mirror: MISSING"
fi

if [ -f scripts/slack-sync.sh ]; then
  chmod +x scripts/slack-sync.sh
  echo "Slack helper: OK"
else
  echo "Slack helper: MISSING"
fi

if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -f scripts/slack-sync.sh ]; then
  bash scripts/slack-sync.sh test >/dev/null 2>&1 && echo "Slack bot token: OK" || echo "Slack bot token: check failed"
else
  echo "Slack bot token: not set"
fi

echo "==> Maintenance complete"
