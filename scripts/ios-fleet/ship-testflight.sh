#!/usr/bin/env bash
# ship-testflight.sh - Archive + upload an iOS app to TestFlight without Xcode UI.
#
# Usage:
#   bash /Users/jay/apps/ios-fleet/ship-testflight.sh <socratic|congress|usage|usage-local> [options]
#
# Options:
#   --repo-root PATH   Repo root (default: cwd)
#   --build N          Force CURRENT_PROJECT_VERSION (default: 1.0.<seq>, +1 every rebuild)
#   --version X.Y.Z    Force MARKETING_VERSION (optional)
#   --export-only      Build IPA only; do not upload
#   --upload-only IPA  Skip archive; upload an existing IPA via ASC API key
#   --dry-run          Print plan and exit
#   --skip-xcodegen    Do not regenerate .xcodeproj
#   --allow-dirty      Allow shipping from a dirty git worktree
#   --force-ship       Bypass min-interval + same-HEAD skip (emergency / owner)
#
# Rate limit (uploads only; export-only is free):
#   Default min interval between successful TestFlight ships per app: 2.5h
#   (9000s). Override: IOS_TF_MIN_INTERVAL_SEC=7200 (2h) etc.
#   Also skips when git HEAD matches the last successful ship (no new commits).
#   Skip exits 0 ("nothing to do") so agent loops stay quiet.
#   State: ~/.cache/ios-fleet/last-ship-<app>.txt  (unix_ts + space + git_sha)
#
# Secrets (never printed):
#   ~/.secrets/appstore-connect.env  (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH)
#   or Xcode-signed-in session for destination=upload export
#
# ASCII-only (Apple bash 3.2 safe). Team: CC8UTF7ATG.

set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
APPS_JSON="${FLEET_DIR}/apps.json"
TEAM_ID="CC8UTF7ATG"
SECRETS_ENV="${HOME}/.secrets/appstore-connect.env"
# 2.5 hours — middle of the owner 2–3h band; not Apple compute, local/process hygiene.
DEFAULT_MIN_INTERVAL_SEC=9000
STATE_DIR="${HOME}/.cache/ios-fleet"

APP_KEY=""
REPO_ROOT=""
FORCE_BUILD=""
FORCE_VERSION=""
EXPORT_ONLY=0
UPLOAD_ONLY_IPA=""
DRY_RUN=0
SKIP_XCODEGEN=0
ALLOW_DIRTY=0
FORCE_SHIP=0

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[ios-ship] $*"; }

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

json_get() {
  # json_get <app_key> <field>
  /usr/bin/python3 - "$APPS_JSON" "$1" "$2" <<'PY'
import json, sys
path, app, field = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path))
apps = data["apps"]
if app not in apps:
    print("", end="")
    sys.exit(0)
val = apps[app].get(field)
if val is None:
    print("", end="")
elif isinstance(val, list):
    print(",".join(val), end="")
else:
    print(val, end="")
PY
}

resolve_project() {
  local root="$1" rel="$2" alt="$3"
  if [[ -n "$rel" && -e "${root}/${rel}" ]]; then
    echo "${root}/${rel}"
    return 0
  fi
  if [[ -n "$alt" && -e "${root}/${alt}" ]]; then
    echo "${root}/${alt}"
    return 0
  fi
  return 1
}

# Load ASC credentials into the CURRENT shell (must not run inside $(...) or the
# exported ASC_* vars are discarded with the subshell). Sets AUTH_MODE to
# "api_key" or "none". Never prints secret values.
load_secrets() {
  AUTH_MODE="none"
  if [[ -f "$SECRETS_ENV" ]]; then
    # shellcheck disable=SC1090
    set -a
    # shellcheck source=/dev/null
    source "$SECRETS_ENV"
    set +a
  fi
  if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" && -n "${ASC_KEY_PATH:-}" ]]; then
    if [[ -f "$ASC_KEY_PATH" ]]; then
      AUTH_MODE="api_key"
      return 0
    fi
    log "ASC_KEY_PATH set but file missing (not printing path contents)"
  fi
  return 0
}

link_private_key() {
  # altool / iTMSTransporter look for AuthKey_<id>.p8 in standard dirs.
  local key_path="$1" key_id="$2"
  local dest_dir="${HOME}/.appstoreconnect/private_keys"
  mkdir -p "$dest_dir"
  chmod 700 "$dest_dir"
  local dest="${dest_dir}/AuthKey_${key_id}.p8"
  if [[ ! -e "$dest" ]]; then
    ln -sf "$key_path" "$dest"
  fi
  chmod 600 "$key_path" 2>/dev/null || true
}

# Owner directive 2026-08-12: version naming is 1.0.# where EVERY rebuild —
# including a tiny tweak — adds exactly 1 to the last number. No divergent
# "(build)" counter: CFBundleVersion is set to the SAME dotted string as the
# marketing version (Apple accepts up to three period-separated integers), so
# TestFlight/ASC render "1.0.7 (1.0.7)" and the two can never drift apart.
# Each version string is its own train with exactly one build, which also
# sidesteps Apple's must-be-higher-than-previous rule against the old huge
# timestamp builds (e.g. 202608101310) stuck in the 1.0.0 train.
# Sequence state: ${STATE_DIR}/build-seq-<app>.txt (flock-guarded).
# NOTE: flock(1) does not exist on macOS — under `set -e` a flock call would
# kill the subshell and yield an EMPTY sequence ("1.0."), so the mutex is an
# atomic mkdir instead (portable to Apple bash 3.2, per the header contract).
next_build_seq() {
  local seq_file="${STATE_DIR}/build-seq-${APP_KEY}.txt"
  local lock_dir="${seq_file}.lockdir"
  mkdir -p "$STATE_DIR"
  local tries=0
  until mkdir "$lock_dir" 2>/dev/null; do
    tries=$((tries + 1))
    if [[ "$tries" -gt 50 ]]; then
      echo "next_build_seq: lock timeout on ${lock_dir}" >&2
      return 1
    fi
    sleep 0.1
  done
  local n
  n=$(cat "$seq_file" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  n=$((n + 1))
  printf '%s' "$n" > "$seq_file"
  rmdir "$lock_dir" 2>/dev/null || true
  printf '%s' "$n"
}

marketing_prefix() {
  # "1.0" from marketingVersionDefault (1.0 or 1.0.x both yield 1.0).
  local d="${DEFAULT_MARKETING:-1.0}"
  printf '%s' "$d" | awk -F. '{ if (NF >= 2) print $1"."$2; else print $1".0" }'
}

ship_state_path() {
  echo "${STATE_DIR}/last-ship-${APP_KEY}.txt"
}

repo_head_sha() {
  git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown"
}

# Exit 0 (skip) when rate-limited or no new commits since last successful ship.
# Does not apply to --export-only (local IPA only) or --force-ship.
maybe_skip_ship() {
  if [[ "$FORCE_SHIP" -eq 1 ]]; then
    log "force-ship: bypassing min-interval / same-HEAD gate"
    return 0
  fi
  if [[ "$EXPORT_ONLY" -eq 1 ]]; then
    return 0
  fi

  local min_sec path last_ts last_sha now elapsed head_sha
  min_sec="${IOS_TF_MIN_INTERVAL_SEC:-$DEFAULT_MIN_INTERVAL_SEC}"
  # Non-numeric / empty → default
  if ! [[ "$min_sec" =~ ^[0-9]+$ ]]; then
    min_sec="$DEFAULT_MIN_INTERVAL_SEC"
  fi
  path="$(ship_state_path)"
  head_sha="$(repo_head_sha)"
  now="$(date +%s)"

  if [[ ! -f "$path" ]]; then
    log "ship-gate: no prior ship for ${APP_KEY}; proceeding"
    return 0
  fi

  # Format: "<unix_ts> <git_sha>"
  read -r last_ts last_sha <"$path" || true
  if ! [[ "${last_ts:-}" =~ ^[0-9]+$ ]]; then
    log "ship-gate: bad state file; proceeding"
    return 0
  fi

  if [[ -n "${last_sha:-}" && "$last_sha" != "unknown" && "$head_sha" == "$last_sha" ]]; then
    log "ship-gate: skip — HEAD ${head_sha:0:10} already shipped for ${APP_KEY} (no new commits)"
    log "ship-gate: use --force-ship to upload the same HEAD again"
    exit 0
  fi

  elapsed=$((now - last_ts))
  if [[ "$elapsed" -lt "$min_sec" ]]; then
    local remain=$((min_sec - elapsed))
    local remain_m=$(( (remain + 59) / 60 ))
    log "ship-gate: skip — last ${APP_KEY} ship ${elapsed}s ago; min interval ${min_sec}s (~${remain_m}m left)"
    log "ship-gate: set IOS_TF_MIN_INTERVAL_SEC or pass --force-ship to override"
    exit 0
  fi

  log "ship-gate: ok — ${elapsed}s since last ship (min ${min_sec}s); HEAD ${head_sha:0:10}"
}

record_successful_ship() {
  local path head_sha now
  path="$(ship_state_path)"
  head_sha="$(repo_head_sha)"
  now="$(date +%s)"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  printf '%s %s\n' "$now" "$head_sha" >"$path"
  chmod 600 "$path" 2>/dev/null || true
  log "ship-gate: recorded success ts=${now} sha=${head_sha:0:10} -> ${path}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    socratic|congress|usage|usage-local) APP_KEY="$1"; shift ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --build) FORCE_BUILD="$2"; shift 2 ;;
    --version) FORCE_VERSION="$2"; shift 2 ;;
    --export-only) EXPORT_ONLY=1; shift ;;
    --upload-only) UPLOAD_ONLY_IPA="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-xcodegen) SKIP_XCODEGEN=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --force-ship) FORCE_SHIP=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown arg: $1 (try --help)" ;;
  esac
done

[[ -n "$APP_KEY" ]] || die "app key required: socratic | congress | usage | usage-local"
[[ -f "$APPS_JSON" ]] || die "missing apps registry: $APPS_JSON"

# Prefer stable Xcode.app over Xcode-beta for TestFlight / ASC compatibility.
# Beta toolchains + beta macOS stamp BuildMachineOSBuild that App Store review
# rejects as INVALID_BINARY even when TestFlight accepts the same IPA.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  elif [[ -d /Applications/Xcode-beta.app/Contents/Developer ]]; then
    echo "[ios-ship] warning: only Xcode-beta present; ASC Invalid Binary risk" >&2
    export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
  fi
fi
if [[ -n "${DEVELOPER_DIR:-}" ]]; then
  echo "[ios-ship] DEVELOPER_DIR=${DEVELOPER_DIR}"
fi

need_cmd xcodebuild
need_cmd /usr/bin/python3

# Owner 2026-08-11: always use stable Xcode.app for archive/export/upload.
# Xcode-beta breaks TestFlight / App Store Connect tooling compatibility.
# Override only if DEVELOPER_DIR is already set to a non-beta path.
if [[ -z "${DEVELOPER_DIR:-}" || "$DEVELOPER_DIR" == *Xcode-beta* ]]; then
  if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
if [[ -n "${DEVELOPER_DIR:-}" ]]; then
  log "using DEVELOPER_DIR=${DEVELOPER_DIR}"
  xcodebuild -version || die "xcodebuild broken under DEVELOPER_DIR=${DEVELOPER_DIR}"
fi


if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(pwd)"
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

DISPLAY_NAME="$(json_get "$APP_KEY" displayName)"
BUNDLE_ID="$(json_get "$APP_KEY" bundleId)"
SCHEME="$(json_get "$APP_KEY" scheme)"
PROJECT_REL="$(json_get "$APP_KEY" projectRel)"
PROJECT_REL_ALT="$(json_get "$APP_KEY" projectRelAlt)"
XCODEGEN_DIR="$(json_get "$APP_KEY" xcodegenDir)"
DEFAULT_MARKETING="$(json_get "$APP_KEY" marketingVersionDefault)"

[[ -n "$BUNDLE_ID" && -n "$SCHEME" && -n "$PROJECT_REL" ]] || die "unknown app key or incomplete registry: $APP_KEY"

if [[ -z "$UPLOAD_ONLY_IPA" && "$DRY_RUN" -eq 0 ]]; then
  if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
    if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      die "not a git repo: $REPO_ROOT (pass --allow-dirty to override)"
    fi
    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
      die "dirty worktree at $REPO_ROOT (commit first, or pass --allow-dirty)"
    fi
  fi
fi

if [[ -n "$FORCE_BUILD" || -n "$FORCE_VERSION" ]]; then
  # Explicit operator override: honour exactly what was asked.
  BUILD_NUM="${FORCE_BUILD:-$FORCE_VERSION}"
  MARKETING="${FORCE_VERSION:-$DEFAULT_MARKETING}"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  # Dry-run must not consume a sequence number — peek at what the next real
  # rebuild would get.
  PEEK=$(( $(cat "${STATE_DIR}/build-seq-${APP_KEY}.txt" 2>/dev/null || echo 0) + 1 ))
  MARKETING="$(marketing_prefix).${PEEK}"
  BUILD_NUM="$MARKETING"
else
  SEQ="$(next_build_seq)"
  MARKETING="$(marketing_prefix).${SEQ}"
  BUILD_NUM="$MARKETING"
fi
AUTH_MODE="none"
load_secrets

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_ROOT="${TMPDIR:-/tmp}/ios-ship-${APP_KEY}-${STAMP}"
ARCHIVE_PATH="${OUT_ROOT}/${SCHEME}.xcarchive"
EXPORT_DIR="${OUT_ROOT}/export"
LOG_DIR="${OUT_ROOT}/logs"
mkdir -p "$LOG_DIR"

log "app=${DISPLAY_NAME} key=${APP_KEY}"
log "bundleId=${BUNDLE_ID}"
log "scheme=${SCHEME}"
log "repo=${REPO_ROOT}"
log "marketing=${MARKETING} build=${BUILD_NUM}"
log "auth=${AUTH_MODE} export_only=${EXPORT_ONLY} force_ship=${FORCE_SHIP}"
log "out=${OUT_ROOT}"

# Gate before expensive archive / upload (dry-run still reports gate outcome).
if [[ "$DRY_RUN" -eq 1 ]]; then
  maybe_skip_ship
  log "dry-run: would archive + ship; exiting"
  exit 0
fi

maybe_skip_ship

if [[ -n "$UPLOAD_ONLY_IPA" ]]; then
  [[ -f "$UPLOAD_ONLY_IPA" ]] || die "IPA not found: $UPLOAD_ONLY_IPA"
  [[ "$AUTH_MODE" == "api_key" ]] || die "upload-only requires ~/.secrets/appstore-connect.env with ASC_KEY_*"
  link_private_key "$ASC_KEY_PATH" "$ASC_KEY_ID"
  log "uploading existing IPA via altool (api key)"
  set +e
  xcrun altool --upload-app --type ios \
    --file "$UPLOAD_ONLY_IPA" \
    --apiKey "$ASC_KEY_ID" \
    --apiIssuer "$ASC_ISSUER_ID" \
    2>&1 | tee "${LOG_DIR}/upload.log"
  UPLOAD_RC=${PIPESTATUS[0]}
  set -e
  [[ $UPLOAD_RC -eq 0 ]] || die "altool upload failed (rc=$UPLOAD_RC); see ${LOG_DIR}/upload.log"
  record_successful_ship
  log "upload submitted; watch TestFlight processing in App Store Connect"
  exit 0
fi

# Optional XcodeGen regenerate
if [[ -n "$XCODEGEN_DIR" && "$XCODEGEN_DIR" != "null" && "$SKIP_XCODEGEN" -eq 0 ]]; then
  if command -v xcodegen >/dev/null 2>&1; then
    log "xcodegen generate in ${REPO_ROOT}/${XCODEGEN_DIR}"
    (cd "${REPO_ROOT}/${XCODEGEN_DIR}" && xcodegen generate) 2>&1 | tee "${LOG_DIR}/xcodegen.log"
  else
    log "xcodegen not installed; using checked-in .xcodeproj"
  fi
fi

PROJECT_PATH="$(resolve_project "$REPO_ROOT" "$PROJECT_REL" "$PROJECT_REL_ALT")" \
  || die "project not found under $REPO_ROOT ($PROJECT_REL / $PROJECT_REL_ALT)"

log "project=${PROJECT_PATH}"

# Archive (device, not simulator). -allowProvisioningUpdates lets Xcode
# download/create App Store distribution profiles for team CC8UTF7ATG.
# Xcode's saved account session can be rejected (observed 2026-08-09:
# "Unable to log in with account ... login details were rejected"), which fails
# automatic signing even when an ASC API key is available. Passing the key
# straight to xcodebuild removes the dependency on the Xcode UI session.
ASC_AUTH_FLAGS=()
if [[ -n "${ASC_KEY_PATH:-}" && -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  _asc_key_expanded="${ASC_KEY_PATH/#\~/$HOME}"
  if [[ -f "$_asc_key_expanded" ]]; then
    ASC_AUTH_FLAGS=(-authenticationKeyPath "$_asc_key_expanded" \
      -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
    log "signing auth: ASC API key"
  fi
fi

# One Mac hosts three Actions runners. Serialize archive/export so two
# xcodebuild archives cannot thrash DerivedData / codesign at once.
ARCHIVE_LOCK_DIR="${STATE_DIR}/archive.lockdir"
acquire_archive_lock() {
  mkdir -p "$STATE_DIR"
  local tries=0
  until mkdir "$ARCHIVE_LOCK_DIR" 2>/dev/null; do
    tries=$((tries + 1))
    if [[ "$tries" -gt 180 ]]; then
      die "archive lock timeout (${ARCHIVE_LOCK_DIR})"
    fi
    log "archive lock busy; waiting (${tries})"
    sleep 10
  done
  # shellcheck disable=SC2064
  trap "rmdir '$ARCHIVE_LOCK_DIR' 2>/dev/null || true" EXIT
}
release_archive_lock() {
  rmdir "$ARCHIVE_LOCK_DIR" 2>/dev/null || true
}

# After a successful upload, declare export compliance if the IPA omitted
# ITSAppUsesNonExemptEncryption. Otherwise TestFlight stays
# MISSING_EXPORT_COMPLIANCE and the phone never sees the build (ST 1.0.1/2
# on 2026-08-12).
ensure_tf_ready() {
  log "verifying TestFlight ready-to-install for ${BUNDLE_ID}"
  set +e
  node "${FLEET_DIR}/asc-api.mjs" ensure-tf-ready "$BUNDLE_ID" \
    >"${LOG_DIR}/ensure-tf-ready.json" 2>"${LOG_DIR}/ensure-tf-ready.err"
  local rc=$?
  set -e
  if [[ -s "${LOG_DIR}/ensure-tf-ready.err" ]]; then
    while IFS= read -r line; do log "tf-ready: $line"; done <"${LOG_DIR}/ensure-tf-ready.err"
  fi
  if [[ $rc -eq 0 ]]; then
    log "TestFlight internal testers can install this build"
    return 0
  fi
  if [[ $rc -eq 3 ]]; then
    log "warning: upload succeeded but ASC has not reached IN_BETA_TESTING yet; watch TestFlight"
    return 0
  fi
  log "warning: ensure-tf-ready failed (rc=$rc); build may be stuck on export compliance"
  return 0
}

acquire_archive_lock
log "archiving..."
set +e
xcodebuild archive \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION="$MARKETING" \
  CURRENT_PROJECT_VERSION="$BUILD_NUM" \
  2>&1 | tee "${LOG_DIR}/archive.log"
ARCHIVE_RC=${PIPESTATUS[0]}
set -e
[[ $ARCHIVE_RC -eq 0 ]] || die "archive failed (rc=$ARCHIVE_RC); see ${LOG_DIR}/archive.log"

EXPORT_PLIST_UPLOAD="${FLEET_DIR}/ExportOptions-appstore.plist"
EXPORT_PLIST_IPA="${FLEET_DIR}/ExportOptions-export-ipa.plist"

if [[ "$EXPORT_ONLY" -eq 1 ]]; then
  log "exporting IPA only..."
  mkdir -p "$EXPORT_DIR"
  set +e
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_PLIST_IPA" \
    -allowProvisioningUpdates \
    ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
    2>&1 | tee "${LOG_DIR}/export.log"
  EXPORT_RC=${PIPESTATUS[0]}
  set -e
  [[ $EXPORT_RC -eq 0 ]] || die "export failed (rc=$EXPORT_RC); see ${LOG_DIR}/export.log"
  IPA="$(ls -1 "$EXPORT_DIR"/*.ipa 2>/dev/null | head -1 || true)"
  [[ -n "$IPA" ]] || die "no IPA produced in $EXPORT_DIR"
  log "IPA ready: $IPA"
  log "Upload later: bash $0 $APP_KEY --upload-only \"$IPA\""
  exit 0
fi

# Prefer: export with destination=upload (uses Xcode session OR ASC if configured in Xcode)
log "exporting + uploading to App Store Connect..."
mkdir -p "$EXPORT_DIR"
set +e
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST_UPLOAD" \
  -allowProvisioningUpdates \
  ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
  2>&1 | tee "${LOG_DIR}/export-upload.log"
EXPORT_RC=${PIPESTATUS[0]}
set -e

if [[ $EXPORT_RC -eq 0 ]]; then
  log "upload path succeeded via xcodebuild export (destination=upload)"
  log "build ${MARKETING} (${BUILD_NUM}) submitted for ${BUNDLE_ID}"
  release_archive_lock
  ensure_tf_ready
  record_successful_ship
  log "logs: ${LOG_DIR}"
  exit 0
fi

log "xcodebuild upload export failed (rc=$EXPORT_RC); trying IPA export + altool"

mkdir -p "$EXPORT_DIR"
set +e
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST_IPA" \
  -allowProvisioningUpdates \
  ${ASC_AUTH_FLAGS[@]:+"${ASC_AUTH_FLAGS[@]}"} \
  2>&1 | tee "${LOG_DIR}/export-ipa.log"
EXPORT_RC=${PIPESTATUS[0]}
set -e
[[ $EXPORT_RC -eq 0 ]] || die "IPA export failed (rc=$EXPORT_RC); see ${LOG_DIR}/export-ipa.log and ${LOG_DIR}/export-upload.log"

IPA="$(ls -1 "$EXPORT_DIR"/*.ipa 2>/dev/null | head -1 || true)"
[[ -n "$IPA" ]] || die "no IPA produced in $EXPORT_DIR"

# Re-load secrets before altool: long xcodebuild sessions can leave ASC_*
# unset under `set -u` even when AUTH_MODE was api_key at plan time.
load_secrets
if [[ "$AUTH_MODE" != "api_key" ]]; then
  log "IPA ready at: $IPA"
  log "Upload blocked: no App Store Connect API key."
  log "Owner handoff:"
  log "  1) Create ASC API key (App Manager+) in App Store Connect"
  log "  2) Save .p8 as ~/.secrets/AuthKey_<KEY_ID>.p8 (chmod 600)"
  log "  3) Copy ${FLEET_DIR}/appstore-connect.env.example -> ~/.secrets/appstore-connect.env"
  log "  4) Fill ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH; chmod 600 the env file"
  log "  5) Re-run: bash $0 $APP_KEY --upload-only \"$IPA\""
  log "Also ensure App Store Connect has an app record for ${BUNDLE_ID}."
  exit 3
fi

link_private_key "${ASC_KEY_PATH}" "${ASC_KEY_ID}"
log "uploading IPA via altool (api key)"
set +e
xcrun altool --upload-app --type ios \
  --file "$IPA" \
  --apiKey "${ASC_KEY_ID}" \
  --apiIssuer "${ASC_ISSUER_ID}" \
  2>&1 | tee "${LOG_DIR}/upload.log"
UPLOAD_RC=${PIPESTATUS[0]}
set -e
if [[ $UPLOAD_RC -ne 0 ]]; then
  log "altool failed (rc=$UPLOAD_RC). Common cause: no App Store Connect app for ${BUNDLE_ID}."
  log "Create the iOS app in ASC (My Apps → +) with this exact bundle id, then:"
  log "  bash $0 $APP_KEY --upload-only \"$IPA\""
  die "altool upload failed (rc=$UPLOAD_RC); see ${LOG_DIR}/upload.log"
fi

release_archive_lock
ensure_tf_ready
record_successful_ship
log "upload submitted; watch TestFlight processing for ${BUNDLE_ID} build ${BUILD_NUM}"
log "logs: ${LOG_DIR}"
exit 0
