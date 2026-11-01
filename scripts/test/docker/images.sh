#!/usr/bin/env bash
# The Docker suites' test images, prebuilt and published to GitHub's container registry, so a test
# run does not depend on the distributions' package mirrors (apt) being up at that moment.
#
# Sourced by run.sh, appimage.sh and obs.sh:
#   test_image KIND LOCAL_TAG BASE PLATFORM   makes the image LOCAL_TAG for KIND on BASE: pulls
#                                             the published image of this exact Dockerfile, or
#                                             builds it here when there is none (printing the
#                                             whole build, apt included, when the build fails)
# Run (CI: _docker.yml's images job; by hand for a local copy):
#   scripts/test/docker/images.sh ref KIND BASE [PLATFORM]   the published reference
#   scripts/test/docker/images.sh publish [--refresh] [BASE...]
#       builds and pushes every published image of this host's architecture that the registry
#       does not have yet (--refresh: all of them, from a freshly pulled base). Needs
#       `docker login ghcr.io` with permission to write packages.
#
# KIND: install (Dockerfile.install), appimage (Dockerfile.appimage), bare-sudo (Dockerfile.bare
# with WITH_SUDO=1), obs (Dockerfile.obs, Ubuntu 24.04 only), and bare (Dockerfile.bare: no apt,
# always built here from the base image).
#
# A published image's tag names its kind, base, architecture and a hash of its Dockerfile and build
# arguments (`install-ubuntu-24.04-amd64-<12 hex>`): a changed Dockerfile has no published image,
# so it is built here (and published by the next run of the images job outside pull requests).
# The weekly linux-docker.yml run republishes every image from fresh bases and packages
# (--refresh), so the tested distributions stay current. Only these extra tools (the test's
# scaffolding) come from the snapshot; the start script's own `apt-get install curl` (run.sh b)
# still runs live, as it does for users.
#
# Environment:
#   SC_TEST_IMAGES      auto (default): pull, else build | build: always build here (Dockerfile
#                       work, offline machines)
#   SC_TEST_IMAGE_REPO  registry repository (default ghcr.io/lucas-angelo/swarmcast-test)
#   SC_PULL_TIMEOUT     seconds per pull try of a published image (default 300)
set -u

IMAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_REPO="${SC_TEST_IMAGE_REPO:-ghcr.io/lucas-angelo/swarmcast-test}"
# Bumping this republishes every image (the tags change).
IMAGES_SCHEME=1
# shellcheck source-path=SCRIPTDIR source=pull.sh
. "$IMAGES_DIR/pull.sh"

image_dockerfile() { # KIND -> file name
  case "$1" in
    install) echo Dockerfile.install ;;
    appimage) echo Dockerfile.appimage ;;
    bare | bare-sudo) echo Dockerfile.bare ;;
    obs) echo Dockerfile.obs ;;
    *) echo "unknown test image kind: $1" >&2; return 2 ;;
  esac
}
image_args() { case "$1" in bare-sudo) echo WITH_SUDO=1 ;; esac; } # KIND -> build args
image_arch() { # PLATFORM (empty: the Docker host's) -> amd64 | arm64
  local a="${1#linux/}"
  [ -n "$a" ] || a="$(docker version -f '{{.Server.Arch}}')"
  case "$a" in x86_64 | amd64) echo amd64 ;; aarch64 | arm64) echo arm64 ;; *) echo "$a" ;; esac
}

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }

image_ref() { # KIND BASE [PLATFORM] -> registry reference
  local kind="$1" base="$2" df arch key
  df="$(image_dockerfile "$kind")" || return 2
  arch="$(image_arch "${3:-}")" || return 2
  key="$({ printf 'scheme=%s\nkind=%s\nbase=%s\nargs=%s\n' "$IMAGES_SCHEME" "$kind" "$base" "$(image_args "$kind")"; cat "$IMAGES_DIR/$df"; } | sha256_of)"
  printf '%s:%s-%s-%s-%s' "$IMAGE_REPO" "$kind" "${base//[:\/]/-}" "$arch" "${key:0:12}"
}

# image_build KIND TAG BASE PLATFORM [docker build options...]: the full build log, apt's own
# messages included, is printed when the build fails (BuildKit's quiet mode keeps only the last line).
image_build() {
  local kind="$1" tag="$2" base="$3" plat="$4" df log rc a args=()
  shift 4
  df="$(image_dockerfile "$kind")" || return 2
  for a in $(image_args "$kind"); do args+=(--build-arg "$a"); done
  log="$(mktemp "${TMPDIR:-/tmp}/sc-image-build.XXXXXX")"
  docker build --progress=plain ${plat:+--platform "$plat"} -f "$IMAGES_DIR/$df" --build-arg "BASE=$base" \
    ${args[@]+"${args[@]}"} --label "org.opencontainers.image.source=https://github.com/Lucas-Angelo/swarmcast" \
    "$@" -t "$tag" "$IMAGES_DIR" >"$log" 2>&1
  rc=$?
  if [ "$rc" != 0 ]; then
    echo "build of $tag failed (exit $rc); its log:"
    sed 's/^/  | /' "$log"
  fi
  rm -f "$log"
  return "$rc"
}

# image_pull REF [PLATFORM]: 0 pulled, 1 not published (or not readable), 2 the registry did not
# answer after 3 tries. Infra recovery, not a test retry: only network errors are tried again.
image_pull() {
  local ref="$1" plat="${2:-}" try out tmo=() pause=5
  command -v timeout >/dev/null && tmo=(timeout "${SC_PULL_TIMEOUT:-300}")
  for try in 1 2 3; do
    if out="$(${tmo[@]+"${tmo[@]}"} docker pull -q ${plat:+--platform "$plat"} "$ref" 2>&1)"; then
      [ "$try" -gt 1 ] && echo "infra recovery: docker pull $ref worked on try $try"
      return 0
    fi
    case "$out" in
      *"manifest unknown"* | *"not found"* | *denied* | *unauthorized* | *"no matching manifest"*) return 1 ;;
    esac
    echo "pull $ref: failed or timed out (try $try of 3): $(printf '%s' "$out" | tail -n 1)"
    [ "$try" -lt 3 ] && sleep "$pause"
    pause=$((pause * 3))
  done
  return 2
}

# test_image KIND LOCAL_TAG BASE PLATFORM: one line says where the image came from.
test_image() {
  local kind="$1" tag="$2" base="$3" plat="$4" ref digest why
  if [ "$kind" != bare ] && [ "${SC_TEST_IMAGES:-auto}" != build ]; then
    ref="$(image_ref "$kind" "$base" "$plat")" || return 2
    image_pull "$ref" "$plat"
    case $? in
      0)
        docker tag "$ref" "$tag" || return 1
        digest="$(docker image inspect -f '{{join .RepoDigests " "}}' "$ref" 2>/dev/null)"
        echo "image $tag: published ${digest:-$ref}"
        return 0
        ;;
      1) why="no published image for this Dockerfile ($ref)" ;;
      *) why="the registry did not answer ($ref)" ;;
    esac
    echo "image $tag: building here: $why"
    if [ "${GITHUB_ACTIONS:-}" = true ]; then
      echo "::warning title=test image built in the job::$tag: $why; its apt-get used the distribution's mirrors"
    fi
  fi
  pull_image "$base" "$plat" || { echo "pull of $base ($plat) failed"; return 1; }
  image_build "$kind" "$tag" "$base" "$plat" || return 1
  echo "image $tag: built here"
}

# The published set: every kind with apt in its Dockerfile, on every base the suites use.
images_publish() {
  local refresh=0 bases=() plat arch kind base ref fails=0 built=0 kept=0 b
  while [ $# -gt 0 ]; do
    case "$1" in
      --refresh) refresh=1 ;;
      -*) echo "Unknown option: $1" >&2; return 2 ;;
      *) bases+=("$1") ;;
    esac
    shift
  done
  [ ${#bases[@]} -eq 0 ] && bases=(ubuntu:22.04 ubuntu:24.04 debian:12)
  arch="$(image_arch "")" || return 2
  plat="linux/$arch"
  for kind in bare-sudo install appimage obs; do
    for base in "${bases[@]}"; do
      b="$base"
      if [ "$kind" = obs ]; then [ "$base" = "${bases[0]}" ] || continue; b=ubuntu:24.04; fi
      ref="$(image_ref "$kind" "$b" "$plat")" || return 2
      if [ "$refresh" = 0 ] && docker manifest inspect "$ref" >/dev/null 2>&1; then
        echo "published already: $ref"
        kept=$((kept + 1))
        continue
      fi
      echo "##### build $ref"
      # A fresh runner has no base image yet, so pull_image fetches the current one.
      if pull_image "$b" "$plat" && image_build "$kind" "$ref" "$b" "$plat" && image_push "$ref"; then
        built=$((built + 1))
      else
        echo "FAIL $ref"
        fails=$((fails + 1))
      fi
    done
  done
  echo "images ($arch): $built published, $kept already there, $fails failed"
  [ "$fails" = 0 ]
}

image_push() { # REF: push, tried 3 times (registry hiccups)
  local try out
  for try in 1 2 3; do
    if out="$(docker push -q "$1" 2>&1)"; then
      echo "published $1 ($(docker image inspect -f '{{join .RepoDigests " "}}' "$1" 2>/dev/null))"
      return 0
    fi
    echo "push $1: failed (try $try of 3): $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    [ "$try" -lt 3 ] && sleep $((try * 10))
  done
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    ref) shift; image_ref "$@" && echo ;;
    publish) shift; images_publish "$@" ;;
    *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; [ "${1:-}" = -h ] || [ "${1:-}" = --help ] ;;
  esac
fi
