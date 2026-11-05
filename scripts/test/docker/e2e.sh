#!/usr/bin/env bash
# Section 3: the Playwright E2E suite (Firefox + Chromium) on Linux, in the official
# Playwright image matching the repo's @playwright/test version.
#
#   scripts/test/docker/e2e.sh [--platform linux/amd64] [PROJECT...]   (default: firefox chromium)
#
# Reports, with the e2e server log and the fake OBS log, are copied to
# ./test-results/docker-e2e/<project>/ in the repo.
#
# SC_DOWNLOAD_CACHE=<dir> (fetch-binaries.mjs; CI's setup action restores it): mounted into the
# container, so the pinned MediaMTX and cloudflared come from it (SHA-256 checked) and only
# what it lacks is downloaded (and added to it).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=pull.sh
. "$DIR/pull.sh"
PLATFORM=""
PROJECTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) PROJECTS+=("$1") ;;
  esac
  shift
done
[ ${#PROJECTS[@]} -eq 0 ] && PROJECTS=(firefox chromium)

PW_VERSION="$(node -e 'const l=require(process.argv[1]);console.log(l.packages["node_modules/@playwright/test"].version)' "$ROOT/package-lock.json" 2>/dev/null)"
[ -n "$PW_VERSION" ] || PW_VERSION="$(sed -n '/"node_modules\/@playwright\/test"/,/version/ s/.*"version": "\(.*\)".*/\1/p' "$ROOT/package-lock.json" | head -n1)"
IMAGE="mcr.microsoft.com/playwright:v$PW_VERSION-noble"
OUT="$ROOT/test-results/docker-e2e"
rm -rf "$OUT"
mkdir -p "$OUT"
echo "Image: $IMAGE ${PLATFORM:+($PLATFORM)}  projects: ${PROJECTS[*]}"

CACHE=()
if [ -n "${SC_DOWNLOAD_CACHE:-}" ]; then
  mkdir -p "$SC_DOWNLOAD_CACHE" || exit 2
  CACHE=(-v "$(cd "$SC_DOWNLOAD_CACHE" && pwd):/dl-cache" -e SC_DOWNLOAD_CACHE=/dl-cache)
  echo "Download cache: $SC_DOWNLOAD_CACHE ($(find "$SC_DOWNLOAD_CACHE" -type f | wc -l | tr -d ' ') files)"
else
  echo "Download cache: none (SC_DOWNLOAD_CACHE unset): fetch-binaries downloads the binaries"
fi

pull_image "$IMAGE" "$PLATFORM" || exit 2
# ${CACHE[@]+...}: an empty array under `set -u` is an error in bash before 4.4 (macOS's 3.2).
docker run --rm --init ${PLATFORM:+--platform "$PLATFORM"} --ipc=host \
  -v "$ROOT:/src:ro" -v "$OUT:/out" ${CACHE[@]+"${CACHE[@]}"} -e "PROJECTS=${PROJECTS[*]}" -e CI= \
  "$IMAGE" bash /src/scripts/test/docker/e2e-in-container.sh
rc=$?
echo "Reports: $OUT"
exit "$rc"
