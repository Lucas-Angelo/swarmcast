#!/usr/bin/env bash
# apt-get with a time limit per try and retries, for GitHub's Ubuntu runners.
#   .github/scripts/apt-retry.sh install -y --no-install-recommends xvfb
#   .github/scripts/apt-retry.sh --run npx playwright install-deps firefox webkit   (a command that runs apt itself)
#
# GitHub's own Ubuntu mirror (azure.archive.ubuntu.com) sometimes trickles: one package took
# 7 minutes and the job hit its timeout. apt's own retries only catch errors and stalls, not a
# slow transfer. So every try gets TRY_TIMEOUT seconds; after a failed or slow try, the runner's
# mirror list (/etc/apt/apt-mirrors.txt) puts mirrors.edge.kernel.org first (x64 only: arm64
# packages come from ports.ubuntu.com, which kernel.org does not mirror) and it tries again.
set -u
TRY_TIMEOUT="${TRY_TIMEOUT:-360}"
TRIES="${TRIES:-3}"
SUDO=""
[ "$(id -u)" = 0 ] || SUDO=sudo

switched=0
switch_mirror() {
  [ "$switched" = 1 ] && return
  switched=1
  if [ "$(uname -m)" = x86_64 ] && [ -f /etc/apt/apt-mirrors.txt ]; then
    echo "Switching apt to mirrors.edge.kernel.org first"
    printf 'http://mirrors.edge.kernel.org/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:3\nhttps://security.ubuntu.com/ubuntu/\tpriority:4\n' |
      $SUDO tee /etc/apt/apt-mirrors.txt >/dev/null
    $SUDO timeout 180 apt-get update || true
  fi
}

cmd=($SUDO apt-get "$@")
if [ "${1:-}" = --run ]; then
  shift
  cmd=("$@")
fi
for i in $(seq 1 "$TRIES"); do
  if timeout "$TRY_TIMEOUT" "${cmd[@]}"; then exit 0; fi
  echo "::warning::${cmd[*]} failed or took more than ${TRY_TIMEOUT} s (try $i of $TRIES)"
  switch_mirror
done
echo "::error::${cmd[*]} failed $TRIES times"
exit 1
