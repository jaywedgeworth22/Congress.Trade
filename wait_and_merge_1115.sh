#!/bin/bash
while true; do
  gh pr merge 1115 --merge --admin && break
  sleep 15
done
