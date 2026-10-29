#!/usr/bin/env bash
# Section 2: real OBS Studio (Ubuntu 24.04 package) streaming to the real SwarmCast package,
# both inside one container, OBS headless under Xvfb with Mesa llvmpipe.
#
#   scripts/test/docker/obs.sh [--release DIR] [--no-build] [--platform linux/amd64] [--simple]
#
#   --simple  keep OBS Simple output mode defaults (no 2 s keyframe setting) instead of
#             Advanced output with x264 keyint 2 s (what the SwarmCast panel asks for)
set -u
# TEMPORARY (reverted in the next commit): shows ci-ok going red when a Docker job fails.
echo "Deliberate failure to check that ci-ok gates on the docker stage" >&2
exit 1
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=pull.sh
. "$DIR/pull.sh"
RELEASE="${RELEASE_DIR:-}"
BUILD=1
PLATFORM=""
MODE=advanced
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift ;;
    --no-build) BUILD=0 ;;
    --platform) PLATFORM="$2"; shift ;;
    --simple) MODE=simple ;;
    -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$RELEASE" ]; then
  common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  for c in "$ROOT/release" "${common%/.git}/release"; do
    [ -f "$c/SHA256SUMS.txt" ] && { RELEASE="$c"; break; }
  done
fi
[ -f "$RELEASE/SHA256SUMS.txt" ] || { echo "Release folder not found. Use --release DIR." >&2; exit 2; }
IMAGE="swarmcast-test-obs${PLATFORM:+-${PLATFORM##*/}}"
if [ "$BUILD" = 1 ]; then
  pull_image ubuntu:24.04 "$PLATFORM" || exit 2
  docker build -q ${PLATFORM:+--platform "$PLATFORM"} -f "$DIR/Dockerfile.obs" -t "$IMAGE" "$DIR" >/dev/null || exit 2
fi
# --shm-size: OBS and Mesa use shared memory; the 64 MB default is tight.
docker run --rm --init --shm-size=512m ${PLATFORM:+--platform "$PLATFORM"} \
  -v "$(cd "$RELEASE" && pwd):/release:ro" -v "$DIR:/tests:ro" \
  -e "OUTPUT_MODE=$MODE" \
  "$IMAGE" bash /tests/obs-test.sh
