#!/usr/bin/env bash
# Sourced by the Docker suites (through images.sh, only when a test image is not saved yet):
# build_image IMAGE DOCKERFILE [docker build options...] builds one of their test images (the
# test's scaffolding: a user, sudo, curl, ffmpeg, OBS... installed with apt) from this folder.
#
# - The BuildKit log (--progress=plain: apt's own lines) is printed as it comes, each line
#   prefixed with "  | ", so a slow mirror shows while it is slow. It used to be printed only
#   after a failure: release rehearsal 42757440898 showed nothing for 5 minutes, until the step's
#   time limit, while apt fetched its indexes at 210 kB/s.
# - The Dockerfiles install with .github/scripts/apt-retry.sh (a time limit per try, tries),
#   mounted for the build only (`--build-context ci=.github/scripts`, RUN --mount): nothing of it
#   stays in the image.
# - Infra recovery, not a test retry: a failed build is tried ONCE more after a pause, with
#   --no-cache (a fresh apt-get update), because a distribution mirror serving a half-synchronised
#   archive is outside our control. Pipeline run 41273197813 (2026-11-01 05:38 UTC) lost
#   `docker / ubuntu:24.04 x64` that way: apt exited with 100 within seconds, an error apt itself
#   does not retry (a 404, a hash or size mismatch: its network retries alone take 31 s); release
#   rehearsal 42757440898 again ("File has unexpected size ... Mirror sync in progress?"). A
#   second failure fails. Nothing that runs SwarmCast is retried.
#
#   BUILD_RETRY_PAUSE  seconds before the second try (default 60)
BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_CI_SCRIPTS="$(cd "$BUILD_DIR/../../../.github/scripts" && pwd)"

# One `docker build`, its log printed as it comes; the exit code is docker's.
build_once() {
  local img="$1" df="$2"
  shift 2
  docker build --progress=plain --build-context "ci=$BUILD_CI_SCRIPTS" -f "$BUILD_DIR/$df" "$@" -t "$img" "$BUILD_DIR" 2>&1 | prefixed '  | '
  return "${PIPESTATUS[0]}"
}

build_image() {
  local img="$1" df="$2" rc pause="${BUILD_RETRY_PAUSE:-60}" start=$SECONDS
  shift 2
  echo "build $img from $df (try 1 of 2):"
  build_once "$img" "$df" "$@"
  rc=$?
  if [ "$rc" != 0 ]; then
    echo "build of $img failed (exit $rc) after $((SECONDS - start)) s, try 1 of 2 (its log above)"
    echo "infra: building $img again in $pause s, from scratch (--no-cache)"
    sleep "$pause"
    echo "build $img from $df (try 2 of 2, --no-cache):"
    build_once "$img" "$df" --no-cache "$@"
    rc=$?
    if [ "$rc" = 0 ]; then
      echo "infra recovery: build of $img worked on try 2 of 2 (try 1's log above)"
      [ "${GITHUB_ACTIONS:-}" = true ] && echo "::warning title=infra recovery::build of test image $img worked on try 2 of 2; try 1's log is in the step output"
    else
      echo "build of $img failed (exit $rc), try 2 of 2 (both logs above)"
    fi
  fi
  return "$rc"
}
