#!/usr/bin/env bash
# Sourced by the Docker suites: build_image IMAGE DOCKERFILE [docker build options...] builds one
# of their test images (the test's scaffolding: a user, sudo, curl, ffmpeg, OBS... installed with
# apt) from this folder.
#
# - The whole BuildKit log (--progress=plain: apt's own lines) is printed when a build fails;
#   `docker build -q` printed only "exit code: 100".
# - Infra recovery, not a test retry: a failed build is tried ONCE more after a pause, with
#   --no-cache (a fresh apt-get update), because a distribution mirror serving a half-synchronised
#   archive is outside our control. Pipeline run 41273197813 (2026-11-01 05:38 UTC) lost
#   `docker / ubuntu:24.04 x64` that way: apt exited with 100 within seconds, an error apt itself
#   does not retry (a 404, a hash or size mismatch: its network retries alone take 31 s). A second
#   failure fails, with both logs. Nothing that runs SwarmCast is retried: the start script's own
#   `apt-get install curl` (run.sh b) runs live, once, in the test.
#
#   BUILD_RETRY_PAUSE  seconds before the second try (default 60)
BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_image() {
  local img="$1" df="$2" log rc pause="${BUILD_RETRY_PAUSE:-60}"
  shift 2
  log="$(mktemp "${TMPDIR:-/tmp}/sc-build.XXXXXX")"
  docker build --progress=plain -f "$BUILD_DIR/$df" "$@" -t "$img" "$BUILD_DIR" >"$log" 2>&1
  rc=$?
  if [ "$rc" != 0 ]; then
    echo "build of $img failed (exit $rc), try 1 of 2; its log:"
    sed 's/^/  | /' "$log"
    echo "infra: building $img again in $pause s, from scratch (--no-cache)"
    sleep "$pause"
    docker build --progress=plain --no-cache -f "$BUILD_DIR/$df" "$@" -t "$img" "$BUILD_DIR" >"$log" 2>&1
    rc=$?
    if [ "$rc" = 0 ]; then
      echo "infra recovery: build of $img worked on try 2 of 2 (try 1's log above)"
      [ "${GITHUB_ACTIONS:-}" = true ] && echo "::warning title=infra recovery::build of test image $img worked on try 2 of 2; try 1's log is in the step output"
    else
      echo "build of $img failed (exit $rc), try 2 of 2; its log:"
      sed 's/^/  | /' "$log"
    fi
  fi
  rm -f "$log"
  return "$rc"
}
