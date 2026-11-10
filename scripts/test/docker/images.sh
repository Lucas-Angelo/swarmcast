#!/usr/bin/env bash
# The Docker suites' test images: what each one is made of, its key, and where it comes from.
# Sourced by appimage.sh, obs.sh, e2e.sh and webkit.sh; also a command for CI's test-images action.
#
#   test_image SPEC [PLATFORM]   makes the image of SPEC ready (sets TI_IMAGE to its name)
#   images.sh file SPEC...       the archive file name of each SPEC's image (one per line)
#   images.sh artifact SPEC...   the name of the CI artifact that holds those archives
#
# SPEC: appimage:<base> (appimage:ubuntu:22.04, appimage:debian:12...), obs, e2e or webkit.
#
# An image is made of its Dockerfile, its base image (pinned by digest below, or the Playwright
# image of the version in package-lock.json) and the architecture: the key is a hash of those.
# test_image takes the first of:
#   1. the image already in this Docker with that key (label org.swarmcast.test-image.key);
#   2. the archive $SC_TEST_IMAGES/<file> (`docker save` + zstd, CI's test-images action restores
#      it), loaded with `docker load`: no registry and no distribution mirror is asked;
#   3. a build (cold): the pinned base pulled (pull.sh), the Dockerfile built (build.sh, apt with a
#      time limit per try). With SC_TEST_IMAGES set, the image is then saved there and its file
#      listed in $SC_TEST_IMAGES/built.txt, so CI's test-images/save action keeps it for later runs.
# The suites then start it with `docker run --pull never`: a test never pulls an image.
#
# Why: release rehearsal 42757440898 (2026-11-10 04:47 UTC) lost four Docker jobs before any test
# ran: archive.ubuntu.com and security.ubuntu.com answered at 210 kB/s, apt-get update took 155 s
# and then failed on a mirror being synchronised, and the AppImage jobs sat 5 minutes in silence
# (the build log was printed only after a failure) until their step limit. docs/TESTING.md, "No
# third-party service in the gate"; scripts/test/docker/README.md, "Test images".
IMAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=pull.sh
. "$IMAGES_DIR/pull.sh"
# shellcheck source-path=SCRIPTDIR source=build.sh
. "$IMAGES_DIR/build.sh"

# Base images, pinned to the digest of their multi-platform index (the same digest on x64 and
# arm64; the architecture is part of the key). To move one on:
#   docker buildx imagetools inspect ubuntu:24.04 --format '{{json .Manifest.Digest}}'
# A new digest is a new key: the next run builds the image again (cold) and keeps it.
BASE_PINS=(
  'ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11'
  'ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852'
  'debian:12@sha256:268fb24c39bca92d326dd83ea3abebe4a3f7751c804ffef23bb6d857dd343ff8'
)
# Bump this when the archive format or what goes into a key changes: every key changes with it.
IMAGE_FORMAT=1

# pinned TAG: TAG@sha256:... from BASE_PINS; an unknown tag is used as it is (a base tried by hand).
pinned() {
  local p
  for p in "${BASE_PINS[@]}"; do
    if [ "${p%@*}" = "$1" ]; then echo "$p"; return 0; fi
  done
  echo "test image: base $1 is not pinned in images.sh; using the tag as it is" >&2
  echo "$1"
}

# The @playwright/test version in package-lock.json (the Playwright image's tag).
playwright_version() {
  local lock="$IMAGES_DIR/../../../package-lock.json" v
  v="$(node -e 'const l=require(process.argv[1]);console.log(l.packages["node_modules/@playwright/test"].version)' "$lock" 2>/dev/null)"
  [ -n "$v" ] || v="$(sed -n '/"node_modules\/@playwright\/test"/,/version/ s/.*"version": "\(.*\)".*/\1/p' "$lock" | head -n1)"
  echo "$v"
}

# image_arch [PLATFORM]: x64 or arm64, of PLATFORM or else of the Docker daemon.
image_arch() {
  local a="${1:-}"
  a="${a##*/}"
  [ -n "$a" ] || a="$(docker version --format '{{.Server.Arch}}' 2>/dev/null)"
  case "$a" in amd64 | x86_64) echo x64 ;; arm64 | aarch64) echo arm64 ;; *) echo "${a:-unknown}" ;; esac
}

sha256_text() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# spec SPEC [PLATFORM]: sets TI_IMAGE (name:tag), TI_DOCKERFILE, TI_BASE (what FROM gets), TI_ARCH,
# TI_KEY and TI_FILE (the archive's name).
spec() {
  local s="$1" platform="${2:-}" pw
  case "$s" in
    appimage:?*)
      TI_IMAGE="swarmcast-test-appimage:${s#appimage:}"
      TI_DOCKERFILE=Dockerfile.appimage TI_BASE="$(pinned "${s#appimage:}")"
      ;;
    obs) TI_IMAGE=swarmcast-test-obs:latest TI_DOCKERFILE=Dockerfile.obs TI_BASE="$(pinned ubuntu:24.04)" ;;
    webkit) TI_IMAGE=swarmcast-test-webkit:latest TI_DOCKERFILE=Dockerfile.webkit TI_BASE="$(pinned ubuntu:24.04)" ;;
    e2e)
      pw="$(playwright_version)"
      [ -n "$pw" ] || { echo "test image: no @playwright/test version in package-lock.json" >&2; return 2; }
      # A Playwright release's image tag is never moved, so the tag is its pin; the digest it had
      # is recorded in the image (label org.swarmcast.test-image.base-digest).
      TI_IMAGE="swarmcast-test-e2e:$pw" TI_DOCKERFILE=Dockerfile.e2e TI_BASE="mcr.microsoft.com/playwright:v$pw-noble"
      ;;
    *) echo "test image: unknown spec '$s' (appimage:<base>, obs, e2e, webkit)" >&2; return 2 ;;
  esac
  TI_ARCH="$(image_arch "$platform")"
  # Tags: '/' and ':' of a base are not allowed in one; the platform as before (-amd64).
  TI_IMAGE="${TI_IMAGE%%:*}:$(printf '%s' "${TI_IMAGE#*:}" | sed 's#[:/]#-#g')${platform:+-${platform##*/}}"
  TI_KEY="$({
    echo "format $IMAGE_FORMAT"
    echo "base $TI_BASE"
    echo "arch $TI_ARCH"
    cat "$IMAGES_DIR/$TI_DOCKERFILE"
  } | sha256_text | cut -c1-16)"
  TI_FILE="$(printf '%s' "${TI_IMAGE%%:*}-${TI_IMAGE#*:}" | tr -c 'A-Za-z0-9._-' '-')-$TI_ARCH-$TI_KEY.tar.zst"
}

# key_of IMAGE: the key label of IMAGE in this Docker, empty when it is not here.
key_of() { docker image inspect --format '{{index .Config.Labels "org.swarmcast.test-image.key"}}' "$1" 2>/dev/null; }

# test_image SPEC [PLATFORM]: see the top of this file. 0 when TI_IMAGE is ready to run.
test_image() {
  local platform="${2:-}" dir="${SC_TEST_IMAGES:-}" start=$SECONDS digest
  spec "$1" "$platform" || return 2
  if [ "$(key_of "$TI_IMAGE")" = "$TI_KEY" ]; then
    echo "test image $TI_IMAGE ($TI_ARCH, key $TI_KEY): already in this Docker"
    return 0
  fi
  if [ -n "$dir" ] && [ -f "$dir/$TI_FILE" ]; then
    echo "test image $TI_IMAGE ($TI_ARCH, key $TI_KEY): loading $TI_FILE ($(($(wc -c <"$dir/$TI_FILE") / 1000000)) MB), no network"
    if zstd -dc "$dir/$TI_FILE" | docker load && [ "$(key_of "$TI_IMAGE")" = "$TI_KEY" ]; then
      echo "test image $TI_IMAGE: loaded in $((SECONDS - start)) s"
      return 0
    fi
    echo "::warning title=test image::$TI_FILE did not load as $TI_IMAGE with key $TI_KEY; building it instead"
  fi
  echo "test image $TI_IMAGE ($TI_ARCH, key $TI_KEY): not saved yet, so built from $TI_BASE and the distribution's mirror (cold)"
  pull_image "$TI_BASE" "$platform" || return 1
  digest="$(docker image inspect --format '{{join .RepoDigests " "}}' "$TI_BASE" 2>/dev/null)"
  build_image "$TI_IMAGE" "$TI_DOCKERFILE" ${platform:+--platform "$platform"} --build-arg "BASE=$TI_BASE" \
    --label "org.swarmcast.test-image.key=$TI_KEY" --label "org.swarmcast.test-image.base=$TI_BASE" \
    --label "org.swarmcast.test-image.base-digest=${digest:-unknown}" || return 1
  echo "test image $TI_IMAGE: built in $((SECONDS - start)) s"
  [ -n "$dir" ] || return 0
  # Saved for the next runs; not fatal: the test runs with the image built here either way.
  mkdir -p "$dir"
  docker save "$TI_IMAGE" | zstd -T0 -3 -q -o "$dir/$TI_FILE.part"
  if [ "${PIPESTATUS[0]}${PIPESTATUS[1]}" = 00 ] && mv -f "$dir/$TI_FILE.part" "$dir/$TI_FILE"; then
    echo "$TI_FILE" >>"$dir/built.txt"
    echo "test image $TI_IMAGE: saved as $TI_FILE ($(($(wc -c <"$dir/$TI_FILE") / 1000000)) MB) in $((SECONDS - start)) s in all"
  else
    rm -f "$dir/$TI_FILE.part"
    echo "::warning title=test image::could not save $TI_IMAGE to $dir; the next run builds it again"
  fi
  return 0
}

# As a command (not sourced): the names CI's test-images actions need.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  cmd="${1:-}"
  shift || true
  case "$cmd" in
    file) for s in "$@"; do spec "$s" && echo "$TI_FILE" || exit 2; done ;;
    artifact)
      [ $# -gt 0 ] || { echo "images.sh artifact SPEC..." >&2; exit 2; }
      files="$(for s in "$@"; do spec "$s" && echo "$TI_FILE" || exit 2; done | sort)" || exit 2
      echo "test-images-$(image_arch)-$(printf '%s\n' "$files" | sha256_text | cut -c1-16)"
      ;;
    *) sed -n '2,9p' "$0"; exit 2 ;;
  esac
fi
