#!/bin/bash
PR=$(gh pr list --head fix-docker-kv-crash --json number -q '.[0].number')
while true; do
  gh pr merge $PR --merge --admin && break
  sleep 15
done
