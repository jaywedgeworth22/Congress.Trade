#!/usr/bin/env bash
# Thin wrapper: ship this app's native iOS binary to TestFlight (no Xcode UI).
# Canonical implementation: /Users/jay/apps/ios-fleet/ship-testflight.sh
#
# STABLE XCODE IS MANDATORY (owner, reaffirmed 2026-08-11).
# Xcode-beta's SDK breaks TestFlight / App Store Connect compatibility: a binary
# built against a beta SDK is accepted into TestFlight but rejected at
# submission as INVALID_BINARY. Version 1.0 has now hit INVALID_BINARY twice.
#
# The fleet script carries its own beta guard, but it lives outside this repo
# and is unversioned — exactly the fragility that left ct-reattach-proxy.sh
# host-only until 2026-08-11. This wrapper therefore enforces the rule itself,
# so the guarantee survives the fleet script being changed, moved, or missing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

STABLE_XCODE="${STABLE_XCODE:-/Applications/Xcode.app}"
STABLE_DEV_DIR="${STABLE_XCODE}/Contents/Developer"

# What would we build with if we did nothing?
resolved="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"

is_beta() {
  local dir="$1"
  [[ "$dir" == *Xcode-beta* ]] && return 0
  # Also catch a stable-looking path whose Xcode self-reports as a beta.
  local plist="${dir%/Contents/Developer}/Contents/Info.plist"
  if [[ -r "$plist" ]]; then
    local ver
    ver=$(defaults read "$plist" CFBundleShortVersionString 2>/dev/null || echo "")
    [[ "$ver" == *[Bb]eta* ]] && return 0
  fi
  return 1
}

if [[ -z "$resolved" ]] || is_beta "$resolved"; then
  if [[ ! -d "$STABLE_DEV_DIR" ]]; then
    echo "ERROR: stable Xcode not found at ${STABLE_XCODE}." >&2
    echo "       Refusing to build for App Store Connect with Xcode-beta —" >&2
    echo "       beta-SDK binaries are rejected as INVALID_BINARY at submission." >&2
    echo "       Install Xcode from the Mac App Store, or set STABLE_XCODE." >&2
    exit 1
  fi
  [[ -n "$resolved" ]] && echo "[ios-ship] refusing beta toolchain at ${resolved}"
  export DEVELOPER_DIR="$STABLE_DEV_DIR"
else
  export DEVELOPER_DIR="$resolved"
fi

# Fail loudly rather than silently shipping a beta-built binary.
if is_beta "$DEVELOPER_DIR"; then
  echo "ERROR: DEVELOPER_DIR still resolves to a beta Xcode (${DEVELOPER_DIR})." >&2
  exit 1
fi

echo "[ios-ship] DEVELOPER_DIR=${DEVELOPER_DIR}"
xcodebuild -version | sed 's/^/[ios-ship] /'

exec bash /Users/jay/apps/ios-fleet/ship-testflight.sh congress --repo-root "$ROOT" "$@"
