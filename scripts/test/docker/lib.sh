#!/usr/bin/env bash
# Sourced by the Docker suites (on the host and inside their containers, where this folder is
# mounted as /tests): waits for a condition with a deadline, never a fixed sleep. Bash only (no
# procps, curl or Python), so it also runs on the AppImage's minimal host.
#
#   wait_for SECONDS COMMAND...   0 as soon as COMMAND succeeds (tried every 0.5 s), 1 once SECONDS
#                                 have passed (wall clock: a slow COMMAND does not stretch it)
#   gone PID                      0 when PID no longer runs

wait_for() {
  local end=$((SECONDS + $1))
  shift
  while :; do
    "$@" && return 0
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 0.5
  done
}

gone() { ! kill -0 "$1" 2>/dev/null; }
