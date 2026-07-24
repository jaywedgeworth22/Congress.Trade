#!/usr/bin/env bash
# run-5yr-backfill.sh
# Triggers the backend APIs to fetch House, Senate, and Executive filings for the past 5 years.
#
# Usage:
#   cd app
#   ADMIN_TOKEN="..." bash scripts/run-5yr-backfill.sh [API_BASE_URL]
#
# Example:
#   ADMIN_TOKEN="..." bash scripts/run-5yr-backfill.sh https://congress.trade

set -euo pipefail

API_BASE="${1:-http://localhost:8787}"

# Must have ADMIN_TOKEN set
if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  # check if we are hitting local, we might get away with it if ADMIN_OPEN_IN_DEV=true
  if [[ "$API_BASE" != *"localhost"* ]]; then
    echo "Error: ADMIN_TOKEN environment variable is required for production."
    exit 1
  fi
fi

AUTH_HEADER="Authorization: Bearer ${ADMIN_TOKEN:-}"

CURRENT_YEAR=$(date +%Y)
START_YEAR=$((CURRENT_YEAR - 5))

echo "Running 5-Year Backfill from ${START_YEAR} to ${CURRENT_YEAR} on ${API_BASE}..."

# 1. House Backfill (by year)
echo -e "\n--- House Backfill ---"
for (( YEAR=START_YEAR; YEAR<=CURRENT_YEAR; YEAR++ )); do
  echo "Triggering House Backfill for ${YEAR}..."
  curl -s -X POST "${API_BASE}/api/admin/house-backfill" \
    -H "Content-Type: application/json" \
    -H "${AUTH_HEADER}" \
    -d "{\"fromYear\": ${YEAR}, \"toYear\": ${YEAR}, \"maxFilings\": 5000}" | jq .
  
  # small delay
  sleep 2
done

# 2. Senate Backfill (by year, to avoid massive single requests)
echo -e "\n--- Senate Backfill ---"
for (( YEAR=START_YEAR; YEAR<=CURRENT_YEAR; YEAR++ )); do
  echo "Triggering Senate Backfill for ${YEAR}..."
  curl -s -X POST "${API_BASE}/api/admin/senate-backfill" \
    -H "Content-Type: application/json" \
    -H "${AUTH_HEADER}" \
    -d "{\"fromDate\": \"${YEAR}-01-01\", \"toDate\": \"${YEAR}-12-31\", \"maxFilings\": 5000, \"maxSourceQueries\": 50}" | jq .
  
  sleep 2
done

# 3. Executive Backfill (bulk)
# oge-backfill doesn't take dates, but it gets the available list (which spans multiple years)
echo -e "\n--- Executive Backfill ---"
echo "Triggering Executive Backfill..."
curl -s -X POST "${API_BASE}/api/admin/oge-backfill" \
  -H "Content-Type: application/json" \
  -H "${AUTH_HEADER}" \
  -d "{\"maxFilings\": 2000}" | jq .

echo -e "\nAll backfill jobs submitted!"
