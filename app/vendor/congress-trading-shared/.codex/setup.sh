#!/usr/bin/env bash
# Codex Cloud setup: verify coordination helpers for remote Codex sessions.
# Project policy lives in AGENTS.md; this script only checks repo-local tooling.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Codex Cloud coordination setup"

if [ -f docs/EFFORT-LOG.md ]; then
  echo "Effort-log mirror: OK (docs/EFFORT-LOG.md)"
else
  echo "Effort-log mirror: MISSING docs/EFFORT-LOG.md" >&2
  exit 1
fi

if [ -f scripts/slack-sync.sh ]; then
  chmod +x scripts/slack-sync.sh
  echo "Slack helper: OK (scripts/slack-sync.sh)"
else
  echo "Slack helper: MISSING scripts/slack-sync.sh" >&2
  exit 1
fi

echo "Slack channel: ${SLACK_CHANNEL_ID:-C0BEZDJDNKV}"
echo "Slack project: ${SLACK_PROJECT:-${SLACK_TOPIC:-unset}}"
echo "Slack agent: ${SLACK_AGENT_NAME:-${AGENT_NAME:-unset}}"

if [ -n "${SLACK_SYNC_WEBSOCKET:-}" ]; then
  echo "Note: SLACK_SYNC_WEBSOCKET is present but repo helpers do not open direct Socket Mode clients."
  echo "      The Mac PM2 relay remains the single Slack Socket Mode connection."
fi

if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  bash scripts/slack-sync.sh test >/dev/null
  echo "Slack bot token: OK"
else
  echo "Slack bot token: not set. Slack sync will no-op until SLACK_BOT_TOKEN is a runtime env var."
fi

echo "Agent-phase internet must allow slack.com for scripts/slack-sync.sh read/post."
echo "==> Codex Cloud coordination setup complete"
