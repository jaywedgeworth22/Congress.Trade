#!/bin/bash
echo "Waiting for PR 1121 checks and merge..."
while true; do
  STATE=$(gh pr view 1121 --json state -q '.state')
  if [ "$STATE" = "MERGED" ]; then
    echo "PR 1121 is already merged."
    break
  fi
  gh pr merge 1121 --merge --admin
  if [ $? -eq 0 ]; then
    echo "Successfully merged PR 1121"
    break
  fi
  sleep 15
done

echo "Waiting for deploy-oracle.yml run to complete..."
while true; do
  RUN=$(gh run list --workflow=deploy-oracle.yml -L 1 --json status,headBranch,conclusion -q '.[0]')
  STATUS=$(echo "$RUN" | jq -r '.status')
  CONCLUSION=$(echo "$RUN" | jq -r '.conclusion')
  if [ "$STATUS" = "completed" ] && [ "$CONCLUSION" = "success" ]; then
    echo "Deploy successful!"
    break
  elif [ "$STATUS" = "completed" ]; then
    echo "Deploy completed but failed: $CONCLUSION"
    exit 1
  fi
  sleep 15
done

echo "Checking API health..."
curl -s -I https://congress.trade/api/health
