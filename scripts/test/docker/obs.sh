#!/usr/bin/env bash
# Real OBS Studio (Ubuntu 24.04 package) streaming to the staged SwarmCast server (the
# executable the desktop app runs as its sidecar), both inside one container, OBS headless under
# Xvfb with Mesa llvmpipe.
#
#   scripts/test/docker/obs.sh [--staging DIR] [--no-build] [--platform linux/amd64] [--simple]
#
#   --staging DIR  release/staging/linux-<arch> (package.mjs) for the container's architecture
#                  (default: release/staging/<this machine's linux target>)
#   --simple  keep OBS Simple output mode defaults (no 2 s keyframe setting) instead of
#             Advanced output with x264 keyint 2 s (what the SwarmCast panel asks for)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=images.sh
. "$DIR/images.sh"
STAGING=""
BUILD=1
PLATFORM=""
MODE=advanced
while [ $# -gt 0 ]; do
  case "$1" in
    --staging) STAGING="$2"; shift ;;
    --no-build) BUILD=0 ;;
    --platform) PLATFORM="$2"; shift ;;
    --simple) MODE=simple ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$STAGING" ]; then
  case "$(uname -m)" in aarch64 | arm64) STAGING="$ROOT/release/staging/linux-arm64" ;; *) STAGING="$ROOT/release/staging/linux-x64" ;; esac
fi
[ -x "$STAGING/swarmcast" ] || { echo "No staged server in $STAGING (node scripts/build/package.mjs --target linux-<arch>). Use --staging DIR." >&2; exit 2; }
# The image: saved (SC_TEST_IMAGES) or built (images.sh); --no-build takes the one already here.
spec obs "$PLATFORM" || exit 2
if [ "$BUILD" = 1 ]; then
  test_image obs "$PLATFORM" || exit 2
fi
# --shm-size: OBS and Mesa use shared memory; the 64 MB default is tight.
docker run --rm --init --pull never --shm-size=512m ${PLATFORM:+--platform "$PLATFORM"} \
  -v "$(cd "$STAGING" && pwd):/server:ro" -v "$DIR:/tests:ro" \
  -e "OUTPUT_MODE=$MODE" \
  "$TI_IMAGE" bash /tests/obs-test.sh
