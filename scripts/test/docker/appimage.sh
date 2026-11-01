#!/usr/bin/env bash
# Section 4: the desktop AppImage on a minimal host. Builds Dockerfile.appimage (a bare image plus
# only the host packages the website lists) and runs appimage-test.sh in it.
#
#   scripts/test/docker/appimage.sh [--no-build] [--version X.Y.Z] [--platform linux/amd64] APPIMAGE [BASE...]
#
# APPIMAGE  the .AppImage file for the container's architecture
# BASE      base images (default: ubuntu:22.04 ubuntu:24.04 debian:12)
#   --version   expect /api/desktop to report this version
#   --platform  run another architecture (emulated: much slower; CI runs both natively)
#   --no-build  reuse the images of a previous run
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=pull.sh
. "$DIR/pull.sh"
BUILD=1
VERSION=""
PLATFORM=""
FILE=""
BASES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --version) VERSION="$2"; shift ;;
    --platform) PLATFORM="$2"; shift ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) if [ -z "$FILE" ]; then FILE="$1"; else BASES+=("$1"); fi ;;
  esac
  shift
done
[ -f "$FILE" ] || { echo "Usage: $0 [--no-build] [--version X.Y.Z] [--platform P] APPIMAGE [BASE...]" >&2; exit 2; }
[ ${#BASES[@]} -eq 0 ] && BASES=(ubuntu:22.04 ubuntu:24.04 debian:12)
FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"

fails=0
results=()
for base in "${BASES[@]}"; do
  img="swarmcast-test-appimage:${base//[:\/]/-}${PLATFORM:+-${PLATFORM##*/}}"
  echo "##### $base${PLATFORM:+ ($PLATFORM)}: $(basename "$FILE")"
  if [ "$BUILD" = 1 ]; then
    pull_image "$base" "$PLATFORM" ||
      { echo "FAIL pull of $base"; results+=("FAIL $base (base image pull)"); fails=$((fails + 1)); continue; }
    docker build -q ${PLATFORM:+--platform "$PLATFORM"} -f "$DIR/Dockerfile.appimage" --build-arg "BASE=$base" -t "$img" "$DIR" >/dev/null ||
      { echo "FAIL build of $img"; results+=("FAIL $base (image build)"); fails=$((fails + 1)); continue; }
  fi
  # --init reaps the AppImage's children; --shm-size: WebKitGTK and Mesa use shared memory.
  # --network none: the check needs only 127.0.0.1 (no quick tunnel, no blocklist download).
  if docker run --rm --init --shm-size=512m --network none ${PLATFORM:+--platform "$PLATFORM"} \
    -v "$(dirname "$FILE"):/appimage:ro" -v "$DIR:/tests:ro" \
    -e "APPIMAGE_FILE=/appimage/$(basename "$FILE")" -e "EXPECT_VER=$VERSION" -e "CLEAR_APPIMAGE_MAGIC=${PLATFORM:+1}" \
    "$img" bash /tests/appimage-test.sh; then
    results+=("PASS $base")
  else
    results+=("FAIL $base")
    fails=$((fails + 1))
  fi
  echo
done
echo "=================== SUMMARY (AppImage minimal host) ==================="
printf '%s\n' "${results[@]}"
[ "$fails" = 0 ]
