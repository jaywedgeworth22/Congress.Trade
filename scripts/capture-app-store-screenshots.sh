#!/usr/bin/env bash
#
# Capture App Store screenshots from the live iOS app, at every size App Store
# Connect asks for, without touching the host mouse, keyboard, or foreground.
#
# The shots come from the CongressTradeUITests/AppStoreScreenshotTests XCUITest,
# which drives the app through the accessibility API and attaches a full-screen
# capture of each scene.  This script boots the simulators, freezes the status
# bar at 9:41, runs that test once per device size, and harvests the attachments
# out of the .xcresult bundle into a timestamped run directory.
#
# Why XCUITest and not `simctl io screenshot` on a timer: the test decides when
# a scene has actually finished loading (see waitForSceneContent) and takes the
# shot on that exact frame.  A shell script screenshotting on a sleep races the
# network and eventually ships a spinner to the App Store.
#
# Runs ACCUMULATE under docs/brand/app-store-screenshots/runs/<timestamp>/ so you
# can shoot whenever the live data looks good and choose a set later.  Runs are
# ~19MB each, so they are gitignored and pruned to the newest --keep (default 5).
#
# The machine is left as it was found: any simulator this script booted is shut
# down again, any simulator it created is deleted, and the status-bar override is
# cleared.  Simulators that were already booted are left running.
#
# Usage:
#   scripts/capture-app-store-screenshots.sh [options]
#
#   --sizes 69,67,61     Which App Store slots to shoot (default: all three).
#   --keep N             Keep the newest N run directories (default: 5).
#   --api-base URL       Point the app at a different /api/client/v1 base.
#   --no-prune           Keep every run directory.
#   --keep-simulators    Leave booted simulators running (for debugging).
#   -h, --help           This message.
#
set -euo pipefail

# --- Never let this script drift onto the Xcode beta. -------------------------
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/clients/ios"
PROJECT="$IOS_DIR/CongressTrade.xcodeproj"
SCHEME="CongressTradeUITests"
TEST_ID="CongressTradeUITests/AppStoreScreenshotTests/testCaptureAppStoreScenes"
SHOTS_ROOT="$REPO_ROOT/docs/brand/app-store-screenshots"
RUNS_ROOT="$SHOTS_ROOT/runs"
RUNTIME_PREFIX="com.apple.CoreSimulator.SimRuntime.iOS-"

# App Store Connect display slots.  Each entry is:
#   <slot>|<simulator device type>|<expected width>|<expected height>
# The device types are chosen so every capture is at the slot's EXACT native
# resolution — nothing is ever resampled, which is what ASC wants and what the
# old sips-resize flow in this directory's README could not give us.
SLOTS=(
  "iphone_69|iPhone 16 Pro Max|1320|2868"
  "iphone_67|iPhone 15 Pro Max|1290|2796"
  "iphone_61|iPhone 15 Pro|1179|2556"
)

WANTED_SIZES="69,67,61"
KEEP_RUNS=5
PRUNE=1
API_BASE=""
KEEP_SIMULATORS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sizes)          WANTED_SIZES="$2"; shift 2 ;;
    --keep)           KEEP_RUNS="$2"; shift 2 ;;
    --api-base)       API_BASE="$2"; shift 2 ;;
    --no-prune)       PRUNE=0; shift ;;
    --keep-simulators) KEEP_SIMULATORS=1; shift ;;
    -h|--help)        sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown option '$1' (try --help)" >&2; exit 2 ;;
  esac
done

if ! [[ "$KEEP_RUNS" =~ ^[0-9]+$ ]] || [[ "$KEEP_RUNS" -lt 1 ]]; then
  echo "error: --keep needs a positive integer, got '$KEEP_RUNS'" >&2
  exit 2
fi

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

# --- Teardown: restore the machine to how we found it. ------------------------
# Populated as we go so the trap only undoes what we actually did.
BOOTED_BY_US=()
CREATED_BY_US=()
OVERRIDDEN=()

cleanup() {
  local status=$?
  set +e
  for udid in ${OVERRIDDEN[@]+"${OVERRIDDEN[@]}"}; do
    xcrun simctl status_bar "$udid" clear >/dev/null 2>&1
  done
  if [[ "$KEEP_SIMULATORS" -eq 0 ]]; then
    for udid in ${BOOTED_BY_US[@]+"${BOOTED_BY_US[@]}"}; do
      xcrun simctl shutdown "$udid" >/dev/null 2>&1
    done
    for udid in ${CREATED_BY_US[@]+"${CREATED_BY_US[@]}"}; do
      xcrun simctl delete "$udid" >/dev/null 2>&1
    done
  elif [[ ${#BOOTED_BY_US[@]} -gt 0 ]]; then
    warn "--keep-simulators: leaving ${#BOOTED_BY_US[@]} simulator(s) booted."
  fi
  exit $status
}
trap cleanup EXIT INT TERM

# --- Preflight ----------------------------------------------------------------
[[ -d "$PROJECT" ]] || die "no Xcode project at $PROJECT (was it renamed again?)"
command -v xcodebuild >/dev/null || die "xcodebuild not found"

RUNTIME_ID="$(xcrun simctl list runtimes --json 2>/dev/null \
  | /usr/bin/python3 -c '
import json,sys
rts=[r for r in json.load(sys.stdin)["runtimes"]
     if r.get("isAvailable") and r.get("identifier","").startswith("'"$RUNTIME_PREFIX"'")]
rts.sort(key=lambda r: [int(p) for p in r["version"].split(".")])
print(rts[-1]["identifier"] if rts else "")')"
[[ -n "$RUNTIME_ID" ]] || die "no available iOS simulator runtime"
log "Using runtime ${RUNTIME_ID##*.}  •  Xcode $(xcodebuild -version | head -1 | cut -d' ' -f2)"

# --- Resolve one simulator per requested slot ---------------------------------
# Prefer a simulator that already exists for the device type; only create (and
# later delete) one when the machine does not have it.
sim_for_device_type() {
  local device_name="$1"
  xcrun simctl list devices --json 2>/dev/null | /usr/bin/python3 -c '
import json,sys
want_name=sys.argv[1]; want_rt=sys.argv[2]
data=json.load(sys.stdin)["devices"]
for udid,state in ((d["udid"],d["state"]) for d in data.get(want_rt,[])
                   if d.get("isAvailable") and d.get("name")==want_name):
    print(udid, state); break
' "$device_name" "$RUNTIME_ID"
}

declare -a RUN_SLOTS=() RUN_UDIDS=() RUN_W=() RUN_H=()

for entry in "${SLOTS[@]}"; do
  IFS='|' read -r slot device_name width height <<<"$entry"
  size="${slot#iphone_}"
  [[ ",$WANTED_SIZES," == *",$size,"* ]] || continue

  read -r udid state <<<"$(sim_for_device_type "$device_name")" || true
  if [[ -z "${udid:-}" ]]; then
    log "Creating simulator for $device_name"
    udid="$(xcrun simctl create "ct-shot-$slot" "$device_name" "$RUNTIME_ID")" \
      || die "could not create a '$device_name' simulator"
    CREATED_BY_US+=("$udid")
    state="Shutdown"
  fi

  if [[ "$state" != "Booted" ]]; then
    log "Booting $device_name ($slot)"
    xcrun simctl boot "$udid" >/dev/null 2>&1 || die "could not boot $device_name"
    BOOTED_BY_US+=("$udid")
  else
    log "Reusing already-booted $device_name ($slot)"
  fi

  RUN_SLOTS+=("$slot"); RUN_UDIDS+=("$udid"); RUN_W+=("$width"); RUN_H+=("$height")
done

[[ ${#RUN_SLOTS[@]} -gt 0 ]] || die "--sizes '$WANTED_SIZES' matched no known slot"

log "Waiting for simulators to finish booting"
for udid in "${RUN_UDIDS[@]}"; do
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || warn "bootstatus complained for $udid; continuing"
done

# --- Freeze the status bar (9:41, full bars, full battery, no carrier noise) ---
for udid in "${RUN_UDIDS[@]}"; do
  if xcrun simctl status_bar "$udid" override \
    --time "9:41" \
    --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 \
    --batteryState charged --batteryLevel 100 >/dev/null 2>&1; then
    OVERRIDDEN+=("$udid")
  else
    warn "status-bar override failed for $udid; the clock will not read 9:41"
  fi
done

# --- Build once, run everywhere ----------------------------------------------
DERIVED="$(mktemp -d "${TMPDIR:-/tmp}/ct-shots-dd.XXXXXX")"
log "Building the UI test bundle"
xcodebuild build-for-testing \
  -project "$PROJECT" -scheme "$SCHEME" \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  -quiet || die "build-for-testing failed"

XCTESTRUN="$(find "$DERIVED/Build/Products" -maxdepth 1 -name '*.xctestrun' | sort | head -1)"
[[ -n "$XCTESTRUN" ]] || die "build-for-testing produced no .xctestrun"

# Attachments default to deleteOnSuccess in the generated xctestrun; the test
# marks each one .keepAlways, but say it here too so a green run cannot come
# back with an empty bundle.
/usr/bin/plutil -replace "$SCHEME.UserAttachmentLifetime" -string "keepAlways" "$XCTESTRUN" 2>/dev/null || true
if [[ -n "$API_BASE" ]]; then
  log "Pointing the app at $API_BASE"
  /usr/bin/plutil -replace "$SCHEME.UITargetAppEnvironmentVariables.CONGRESS_TRADE_API_BASE_URL" \
    -string "$API_BASE" "$XCTESTRUN" || die "could not set the API base in the xctestrun"
fi

# --- Capture ------------------------------------------------------------------
RUN_STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$RUNS_ROOT/$RUN_STAMP"
mkdir -p "$RUN_DIR"
log "Run directory: ${RUN_DIR#"$REPO_ROOT"/}"

FAILED_SLOTS=()

for i in "${!RUN_SLOTS[@]}"; do
  slot="${RUN_SLOTS[$i]}"; udid="${RUN_UDIDS[$i]}"
  width="${RUN_W[$i]}"; height="${RUN_H[$i]}"
  out_dir="$RUN_DIR/$slot"
  # Must end in .xcresult: xcodebuild appends the extension otherwise and then
  # leaves a symlink beside it, which the cleanup below would miss.
  xcresult="$RUN_DIR/.$slot.xcresult"
  mkdir -p "$out_dir"

  log "Capturing $slot (${width}x${height})"
  rm -rf "$xcresult"
  if ! xcodebuild test-without-building \
        -xctestrun "$XCTESTRUN" \
        -destination "id=$udid" \
        -only-testing:"$TEST_ID" \
        -resultBundlePath "$xcresult" \
        -quiet > "$RUN_DIR/$slot.log" 2>&1; then
    warn "$slot: the screenshot test FAILED."
    # -quiet swallows the assertion text, so read the real reason out of the
    # result bundle. The bundle and log are deliberately kept for this slot.
    xcrun xcresulttool get test-results tests --path "$xcresult" 2>/dev/null \
      | /usr/bin/python3 -c '
import json,sys
def walk(n):
    if n.get("nodeType")=="Failure Message": print("       ", n.get("name","").strip())
    for c in n.get("children",[]) or []: walk(c)
try:
    for n in json.load(sys.stdin).get("testNodes",[]): walk(n)
except Exception:
    pass' >&2 || true
    warn "  full log: ${RUN_DIR#"$REPO_ROOT"/}/$slot.log"
    warn "  bundle:   ${RUN_DIR#"$REPO_ROOT"/}/$(basename "$xcresult")"
    FAILED_SLOTS+=("$slot")
    continue
  fi

  # Harvest the XCTAttachments and rename them to their in-test names.
  raw_dir="$RUN_DIR/.attachments-$slot"
  rm -rf "$raw_dir"
  xcrun xcresulttool export attachments \
    --path "$xcresult" --output-path "$raw_dir" >/dev/null \
    || { warn "$slot: could not export attachments"; FAILED_SLOTS+=("$slot"); continue; }

  /usr/bin/python3 - "$raw_dir" "$out_dir" "$slot" <<'PY'
import json, os, re, shutil, sys
raw, out, slot = sys.argv[1:4]
manifest = os.path.join(raw, "manifest.json")
if not os.path.exists(manifest):
    sys.exit(f"no manifest.json in {raw}")

# The bundle also holds system attachments XCTest adds on its own — screen
# recordings, "UI Snapshot", "Synthesized Event", debug-description dumps. Only
# our own captures are wanted, and XCTest decorates their names with a
# repetition index and a UUID: "02_trades_0_1AB95008-...-80E173571499.png".
SCENE = re.compile(
    r"^(?P<scene>\d{2}_[a-z0-9_]+?)"
    r"(?:_\d+_[0-9A-Fa-f-]{36})?"
    r"\.png$"
)

kept = 0
for test in json.load(open(manifest)):
    for att in test.get("attachments", []):
        name = att.get("suggestedHumanReadableName") or ""
        match = SCENE.match(name)
        if not match:
            continue
        src = os.path.join(raw, att.get("exportedFileName", ""))
        if not os.path.exists(src):
            continue
        # "02_trades" -> "iphone_69_02_trades.png"
        shutil.copyfile(src, os.path.join(out, f"{slot}_{match.group('scene')}.png"))
        kept += 1

if kept == 0:
    sys.exit("no scene screenshots in the result bundle (all attachments were system ones)")
print(f"    harvested {kept} screenshot(s)")
PY

  # Every shot must be EXACTLY the slot's native size — App Store Connect
  # rejects anything else, and finding out at upload time wastes a review slot.
  #
  # XCUIScreen.main.screenshot() can come back a pixel short of the device's
  # true resolution (1178x2556 on a 1179x2556 iPhone 15 Pro), so a mismatch of a
  # pixel or two is corrected here. Anything larger is a real problem — the
  # wrong device, or a changed layout — and fails the slot instead of being
  # quietly stretched into shape.
  bad=0
  shopt -s nullglob
  for png in "$out_dir"/*.png; do
    got_w="$(sips -g pixelWidth "$png" 2>/dev/null | awk '/pixelWidth/{print $2}')"
    got_h="$(sips -g pixelHeight "$png" 2>/dev/null | awk '/pixelHeight/{print $2}')"
    if [[ "$got_w" == "$width" && "$got_h" == "$height" ]]; then
      continue
    fi
    dw=$(( got_w > width ? got_w - width : width - got_w ))
    dh=$(( got_h > height ? got_h - height : height - got_h ))
    if [[ "$dw" -le 2 && "$dh" -le 2 ]]; then
      sips -z "$height" "$width" "$png" >/dev/null 2>&1 \
        || { warn "  could not normalise $(basename "$png")"; bad=1; }
    else
      warn "  $(basename "$png") is ${got_w}x${got_h}, expected ${width}x${height}"
      bad=1
    fi
  done
  shopt -u nullglob
  [[ "$bad" -eq 0 ]] || FAILED_SLOTS+=("$slot")

  rm -rf "$raw_dir" "$xcresult"
  rm -f "$RUN_DIR/$slot.log"
done

# --- Run metadata -------------------------------------------------------------
{
  echo "# Capture run $RUN_STAMP"
  echo
  echo "- Xcode: $(xcodebuild -version | head -1)"
  echo "- Runtime: ${RUNTIME_ID##*.}"
  echo "- API base: ${API_BASE:-production (app default)}"
  echo "- Commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "- Slots: ${RUN_SLOTS[*]}"
  [[ ${#FAILED_SLOTS[@]} -gt 0 ]] && echo "- FAILED: ${FAILED_SLOTS[*]}"
  echo
  echo "Captured by scripts/capture-app-store-screenshots.sh from the live app."
} > "$RUN_DIR/RUN.md"

# --- Prune old runs -----------------------------------------------------------
if [[ "$PRUNE" -eq 1 ]]; then
  # Newest first, then drop everything past --keep. Run directories are named
  # with a sortable timestamp, so a reverse lexical sort is a reverse date sort.
  # (Deliberately no `mapfile`: this must also run under macOS's /bin/bash 3.2.)
  seen=0
  while IFS= read -r stale; do
    seen=$((seen + 1))
    if [[ "$seen" -gt "$KEEP_RUNS" ]]; then
      log "Pruning old run $(basename "$stale")"
      rm -rf "$stale"
    fi
  done < <(find "$RUNS_ROOT" -mindepth 1 -maxdepth 1 -type d | sort -r)
fi

# --- Report -------------------------------------------------------------------
echo
if [[ ${#FAILED_SLOTS[@]} -gt 0 ]]; then
  die "capture incomplete — failed slots: ${FAILED_SLOTS[*]}"
fi
log "Done. ${RUN_DIR#"$REPO_ROOT"/}"
find "$RUN_DIR" -name '*.png' | sort | sed "s|$RUN_DIR/|    |"
