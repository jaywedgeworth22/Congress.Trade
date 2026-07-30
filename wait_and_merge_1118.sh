#!/bin/bash
while true; do
  gh pr merge 1118 --merge --admin && break
  sleep 15
done
