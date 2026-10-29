#!/usr/bin/env bash
# apt-get on GitHub's Ubuntu runners, with downloads that cannot hang a job.
#
#   apt-retry.sh update
#   apt-retry.sh install  [apt-get options] PKG|./x.deb...  download (time-limited, retried), then install offline
#   apt-retry.sh download [apt-get options] PKG|./x.deb...  download only: the .debs a later step or test installs
#   apt-retry.sh playwright-deps BROWSER...                 the system libraries of Playwright's browsers (install)
#   apt-retry.sh --run CMD...                               any other command that runs apt itself (time-limited, retried)
#
# `install ... --download-only` is the same as `download`.
#
# Environment:
#   APT_DEBS              folder for the downloaded .debs (apt's Dir::Cache::archives), e.g. the
#                         .deb cache the setup action restores (input apt-debs). Default: apt's own.
#   APT_UPDATE_TIMEOUT    seconds per `apt-get update` try (default 90)
#   APT_DOWNLOAD_TIMEOUT  seconds per download try (default 150)
#   APT_TRIES             tries per phase (default 3)
#
# Why: GitHub's own mirror (azure.archive.ubuntu.com) sometimes trickles at 40-75 kB/s
# (actions/runner-images#15142, #14823). apt's timeouts only fire when NO data arrives, so a slow
# mirror never fails over by itself, and jobs hit their timeout (61.8 MB in 24 min). So:
# - only the network part has a time limit: `update` and `install --download-only`. Installing
#   (dpkg) runs afterwards from the local files with --no-download and no limit, so a kill can
#   never land in the middle of dpkg;
# - the limit is `sudo timeout -k 15`: timeout runs as root and signals apt's whole process
#   group, SIGKILL 15 s after the SIGTERM (apt finishes a running transfer on SIGTERM; one
#   "360 s" try ran 616 s). Never --foreground (then only the direct child is signalled);
# - after the first failed or slow try, the azure line is deleted from the runner's mirror list
#   (/etc/apt/apt-mirrors.txt; the maintainers' workaround in runner-images#15142), so the next
#   tries and every later apt call of the job use archive.ubuntu.com. arm64 runners use
#   ports.ubuntu.com and have no azure line: nothing changes there;
# - Dpkg::Lock::Timeout: wait for another apt or dpkg instead of failing at once;
# - every phase prints one line: "apt: <what>: Fetched <size> in <time> (<s> s in all) from <mirrors>".
set -u

UPDATE_TIMEOUT="${APT_UPDATE_TIMEOUT:-90}"
DOWNLOAD_TIMEOUT="${APT_DOWNLOAD_TIMEOUT:-150}"
TRIES="${APT_TRIES:-3}"
KILL_AFTER=15
MIRRORS=/etc/apt/apt-mirrors.txt
SUDO=()
[ "$(id -u)" = 0 ] || SUDO=(sudo)

OPTS=(-o Dpkg::Lock::Timeout=60)
if [ -n "${APT_DEBS:-}" ]; then
  "${SUDO[@]}" mkdir -p "$APT_DEBS/partial"
  OPTS+=(-o "Dir::Cache::archives=$APT_DEBS")
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

drop_azure() {
  if [ -f "$MIRRORS" ] && grep -q 'azure\.archive\.ubuntu\.com' "$MIRRORS"; then
    echo "Removing azure.archive.ubuntu.com from $MIRRORS for the rest of this job"
    "${SUDO[@]}" sed -i '/azure\.archive\.ubuntu\.com/d' "$MIRRORS"
  fi
}

# summary WHAT SECONDS: apt's own "Fetched … in …" line and the hosts it used, from $LOG.
summary() {
  local fetched hosts
  fetched="$(grep -Eo 'Fetched [0-9.,]+ [kMG]?B in [^(]*\([^)]*\)' "$LOG" | tail -n 1)"
  hosts="$(grep -Eo '^(Get|Hit|Ign|Err):[0-9]+ [a-z+]+://[^/ ]+' "$LOG" | sed -E 's#^[^ ]+ [a-z+]+://##' | sort -u | paste -sd, -)"
  echo "apt: $1: ${fetched:-nothing to fetch} ($2 s in all) from ${hosts:-the local cache}"
}

# limited SECONDS WHAT CMD...: CMD (run as root) up to $TRIES times, each try limited to SECONDS.
limited() {
  local limit="$1" what="$2" start=$SECONDS i rc
  shift 2
  for i in $(seq 1 "$TRIES"); do
    "${SUDO[@]}" timeout -k "$KILL_AFTER" "$limit" "$@" 2>&1 | tee "$LOG"
    rc="${PIPESTATUS[0]}"
    if [ "$rc" = 0 ]; then
      summary "$what" $((SECONDS - start))
      return 0
    fi
    echo "::warning::$what failed or took more than $limit s (try $i of $TRIES, exit $rc)"
    drop_azure
  done
  echo "::error::$what failed $TRIES times ($((SECONDS - start)) s)"
  return 1
}

apt_update() {
  limited "$UPDATE_TIMEOUT" "apt-get update" apt-get "${OPTS[@]}" update
}

apt_download() {
  limited "$DOWNLOAD_TIMEOUT" "apt-get install --download-only" \
    env DEBIAN_FRONTEND=noninteractive apt-get "${OPTS[@]}" install -y --download-only "$@"
}

apt_install() {
  apt_download "$@" || return 1
  local start=$SECONDS
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get "${OPTS[@]}" install -y --no-download "$@" || {
    echo "::error::apt-get install --no-download failed"
    return 1
  }
  echo "apt: apt-get install (offline): $((SECONDS - start)) s"
}

# Playwright's `install-deps` runs its own `apt-get update && apt-get install` with no limit.
# Instead: ask it which packages are missing (`--dry-run` resolves them with `apt-get install -s`),
# install those through apt_install, then check that nothing is missing any more.
playwright_deps() {
  local out pkgs
  apt_update || return 1
  out="$(npx --no-install playwright install-deps --dry-run "$@" 2>&1)"
  mapfile -t pkgs < <(sed -n '/^Missing system dependencies/,$ s/^  \([^ ]\{1,\}\)$/\1/p' <<<"$out")
  echo "Playwright ($*) needs ${#pkgs[@]} more packages"
  if [ "${#pkgs[@]}" -gt 0 ]; then apt_install --no-install-recommends "${pkgs[@]}" || return 1; fi
  npx --no-install playwright install-deps --dry-run "$@"
}

# A command that runs apt itself (as root through sudo): limited the same way, but timeout runs
# as this user, so it can only signal sudo (sudo relays SIGTERM; SIGKILL stops sudo only).
# Prefer the subcommands above.
run_limited() {
  local start=$SECONDS i rc
  for i in $(seq 1 "$TRIES"); do
    timeout -k "$KILL_AFTER" "$DOWNLOAD_TIMEOUT" "$@"
    rc=$?
    if [ "$rc" = 0 ]; then
      echo "apt: $*: $((SECONDS - start)) s"
      return 0
    fi
    echo "::warning::$* failed or took more than $DOWNLOAD_TIMEOUT s (try $i of $TRIES, exit $rc)"
    drop_azure
  done
  echo "::error::$* failed $TRIES times"
  return 1
}

[ $# -gt 0 ] || { sed -n '2,8p' "$0"; exit 2; }
mode="$1"
shift
case "$mode" in
  update) apt_update ;;
  download) apt_download "$@" ;;
  install)
    for a in "$@"; do
      if [ "$a" = --download-only ]; then
        args=()
        for b in "$@"; do [ "$b" = --download-only ] || args+=("$b"); done
        apt_download "${args[@]}"
        exit
      fi
    done
    apt_install "$@"
    ;;
  playwright-deps) playwright_deps "$@" ;;
  --run) run_limited "$@" ;;
  *)
    echo "apt-retry.sh: unknown mode '$mode' (update, install, download, playwright-deps, --run)" >&2
    exit 2
    ;;
esac
