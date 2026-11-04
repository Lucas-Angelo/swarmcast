#!/usr/bin/env bash
# Section 4: the desktop window's WebKitGTK and its panel load watchdog (docs/DESKTOP.md, "Panel
# load watchdog"), in the distribution's WebKitGTK 4.1 (Ubuntu 24.04) under Xvfb.
#
#   scripts/test/docker/webkit.sh race [--copies N] [--loads N] [--max-s S] [--pattern P]... [--mode M] [--no-coop]
#   scripts/test/docker/webkit.sh watchdog [--src DIR] [--lose N]
#   (both also take --no-build and --platform linux/amd64)
#
# race      runs webkit_coop.py N times at once (default 12, so the CPU is busy, as the race needs):
#           the app's splash -> panel navigations against a local server with the panel's headers,
#           counting the loads that never commit. --pattern app (one webview, default), app-fresh
#           (a new webview per load, like an app start) or blank (a new webview's first page goes
#           straight to the server, the case that loses loads); several --pattern run side by side.
#           --mode observe (default; a stall is confirmed for 20 s, then the page is opened again)
#           or watchdog (the app's schedule). Exit 1 if a load never committed in the end.
# watchdog  builds the desktop shell (debug) from DIR (default: this checkout) and runs it with the
#           mock server, whose first N (default 1) /auth answers never come: the panel must open
#           anyway, through the watchdog. On a shell without the watchdog the window stays on
#           the splash and the check fails.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=pull.sh
. "$DIR/pull.sh"
# shellcheck source-path=SCRIPTDIR source=build.sh
. "$DIR/build.sh"
CMD="${1:-}"
shift || true
case "$CMD" in race | watchdog) ;; *) sed -n '2,21p' "$0"; exit 2 ;; esac
BUILD=1
PLATFORM=""
SRC="$ROOT"
LOSE=1
COPIES=12
ARGS=()
PATTERNS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --platform) PLATFORM="$2"; shift ;;
    --src) SRC="$(cd "$2" && pwd)"; shift ;;
    --lose) LOSE="$2"; shift ;;
    --copies) COPIES="$2"; shift ;;
    --pattern) PATTERNS+=("$2"); shift ;;
    --loads | --max-s | --mode) ARGS+=("$1" "$2"); shift ;;
    --no-coop) ARGS+=("$1") ;;
    -h | --help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ ${#PATTERNS[@]} -eq 0 ] && PATTERNS=(app)
IMAGE="swarmcast-test-webkit${PLATFORM:+-${PLATFORM##*/}}"
if [ "$BUILD" = 1 ]; then
  pull_image ubuntu:24.04 "$PLATFORM" || exit 2
  build_image "$IMAGE" Dockerfile.webkit ${PLATFORM:+--platform "$PLATFORM"} || exit 2
fi
# --shm-size: WebKit's web processes share memory with the UI process; the 64 MB default is tight.
if [ "$CMD" = race ]; then
  exec docker run --rm --init --shm-size=1g --network none ${PLATFORM:+--platform "$PLATFORM"} \
    -v "$DIR:/tests:ro" "$IMAGE" bash /tests/webkit-race.sh "$COPIES" "${PATTERNS[*]}" ${ARGS[@]+"${ARGS[@]}"}
fi
[ -f "$SRC/apps/desktop/src-tauri/Cargo.toml" ] || { echo "No desktop shell in $SRC (apps/desktop/src-tauri)" >&2; exit 2; }
# The mock server of this checkout (MOCK_LOSE_PANEL_LOADS), also for an older --src.
exec docker run --rm --init --shm-size=1g ${PLATFORM:+--platform "$PLATFORM"} \
  -v "$SRC:/src:ro" -v "$DIR:/tests:ro" -v "$ROOT/apps/desktop/test/mock-server.mjs:/mock-server.mjs:ro" \
  -e "LOSE=$LOSE" "$IMAGE" bash /tests/webkit-watchdog.sh
