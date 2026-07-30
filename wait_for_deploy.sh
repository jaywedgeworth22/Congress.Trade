#!/bin/bash
while true; do
  STATUS=$(gh run list --workflow=deploy-oracle.yml -L 1 --json status -q '.[0].status')
  if [ "$STATUS" = "completed" ]; then
    break
  fi
  sleep 15
done
