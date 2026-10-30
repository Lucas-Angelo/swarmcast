#!/usr/bin/env bash
# Sourced by the Docker suites: pull_image IMAGE [PLATFORM] pulls a base image with retries.
#
# Infra recovery, not a test retry: a registry hiccup (Docker Hub answered one CI run's pull with
# "502 Bad Gateway") is the network, not the test: each try has a time limit, and a failed or slow try is retried after
# a pause (5 s, 15 s, 45 s). `docker build` then finds the image locally and does not pull it
# again (no --pull). An image that is already here is not pulled, so --no-build runs and
# offline machines keep working. Exit code 1 after the last try, with every try's error.
#
#   PULL_TRIES (default 4), PULL_TIMEOUT seconds per try (default 300)
pull_image() {
  local image="$1" platform="${2:-}" try out tries="${PULL_TRIES:-4}" limit="${PULL_TIMEOUT:-300}" pause=5 errors=() tmo=()
  # macOS has no timeout(1) unless coreutils is installed: there, a try has no time limit.
  if command -v timeout >/dev/null; then tmo=(timeout "$limit"); fi
  if docker image inspect ${platform:+--platform "$platform"} "$image" >/dev/null 2>&1; then
    return 0
  fi
  for ((try = 1; try <= tries; try++)); do
    if out="$(${tmo[@]+"${tmo[@]}"} docker pull -q ${platform:+--platform "$platform"} "$image" 2>&1)"; then
      if [ "$try" -gt 1 ]; then echo "infra recovery: docker pull $image worked on try $try of $tries (before: ${errors[*]})" >&2; fi
      return 0
    fi
    errors+=("try $try: $(printf '%s' "$out" | tail -n 1)")
    echo "pull $image${platform:+ ($platform)}: failed or took more than $limit s (try $try of $tries): $(printf '%s' "$out" | tail -n 1)" >&2
    if [ "$try" -lt "$tries" ]; then sleep "$pause"; fi
    pause=$((pause * 3))
  done
  echo "pull $image: gave up after $tries tries: ${errors[*]}" >&2
  return 1
}
