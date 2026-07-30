#!/bin/bash
while true; do
  STATUS=$(gh run list --workflow deploy-oracle.yml --limit 1 --json status -q '.[0].status')
  if [ "$STATUS" = "completed" ]; then
    break
  fi
  sleep 10
done
curl -s -o /dev/null -w "%{http_code}" https://congress.trade
