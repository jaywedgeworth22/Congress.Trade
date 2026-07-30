#!/bin/bash
while true; do
  gh pr merge 1119 --merge --admin && break
  sleep 15
done
