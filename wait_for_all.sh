#!/bin/bash
while true; do
  STATE=$(gh pr view 1120 --json state -q '.state')
  if [ "$STATE" = "MERGED" ]; then
    break
  fi
  sleep 10
done

# Wait for a deploy triggered *after* the PR was merged to show up and complete
while true; do
  RUN=$(gh run list --workflow=deploy-oracle.yml -L 1 --json status,headBranch -q '.[0]')
  STATUS=$(echo "$RUN" | jq -r '.status')
  if [ "$STATUS" = "completed" ]; then
    break
  fi
  sleep 10
done
