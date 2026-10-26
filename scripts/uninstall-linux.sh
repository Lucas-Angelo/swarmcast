#!/usr/bin/env bash
# SwarmCast - uninstall on Linux.
#
# Run it from a terminal (no sudo needed):
#   ./uninstall-linux.sh [options]
#
# It stops SwarmCast if it is running, removes a router port that a crash may have
# left open (Direct mode), then deletes the SwarmCast data folder. It never touches
# OBS or anything outside the SwarmCast data folder.
#
# Everything below the marker line is identical in uninstall-macos.command and
# uninstall-linux.sh (scripts/test/uninstall.sh checks it). Compatible with the
# bash 3.2 that ships with macOS.
# shellcheck disable=SC2329 # functions run through trap

SC_SCRIPT_NAME="uninstall-linux.sh"

# ---- shared body (keep identical in both uninstall scripts) ----------------

set -u
set -o pipefail

SC_STOP_GRACE="${SWARMCAST_STOP_GRACE:-10}"   # seconds to wait for a graceful stop
SC_DELETE_DELAYS="${SWARMCAST_DELETE_DELAYS:-1 2 3 4}"  # waits between deletion attempts (s)
SC_CLEANUP_TIMEOUT=60                          # seconds for "swarmcast --cleanup"
SC_OBS_NOTE="Your OBS settings were not changed. Remove the SwarmCast target/server from OBS yourself if you want."
# Entries the app creates in its data folder; at least one must be present before
# anything is deleted (protects against a wrong SWARMCAST_HOME).
SC_MARKERS="app config.json secrets.json state.json logs run bin tools cache blocklists system-check.json"

OPT_KEEP=0
OPT_ASK=0
OPT_HELP=0
EXIT_CODE=0
RESULT=""

case "$(uname -s)" in
  Darwin) SC_OS="macos"; SC_OS_LABEL="macOS" ;;
  *) SC_OS="linux"; SC_OS_LABEL="Linux" ;;
esac

usage() {
  cat <<EOF
SwarmCast uninstaller for $SC_OS_LABEL: stops SwarmCast, removes a router port a
crash may have left open, and deletes the SwarmCast data folder.

Usage: $SC_SCRIPT_NAME [options]

Options:
  --keep-settings   Keep your settings and stream key (config.json, secrets.json);
                    reinstalling later gives you the same stream key
  --ask             Ask for confirmation before removing anything
  --yes             Accepted for compatibility (nothing is asked by default)
  --help            Show this help

Environment:
  SWARMCAST_HOME    Data folder (default: $(default_data_dir_label))

OBS and its settings are never changed. Nothing outside the data folder is deleted.
EOF
}

default_data_dir_label() {
  if [ "$SC_OS" = macos ]; then
    printf '%s' "\$HOME/Library/Application Support/SwarmCast"
  else
    printf '%s' "\${XDG_DATA_HOME:-\$HOME/.local/share}/swarmcast"
  fi
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

init_colors() {
  if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
  else
    C_RED=""; C_GREEN=""; C_YELLOW=""; C_BOLD=""; C_RESET=""
  fi
  SYM_OK="${C_GREEN}✓${C_RESET}"
  SYM_WARN="${C_YELLOW}⚠${C_RESET}"
  SYM_BAD="${C_RED}✗${C_RESET}"
}

say() { printf '%s\n' "$*"; }
ok() { printf '%s %s\n' "$SYM_OK" "$*"; }
warn() { printf '%s %s\n' "$SYM_WARN" "$*"; }
err() { printf '%s %s%s%s\n' "$SYM_BAD" "$C_BOLD" "$*" "$C_RESET"; }
heading() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

pause_before_close() {
  # Keeps the Terminal window readable after a double-click from Finder.
  if [ "$SC_OS" = macos ] && [ -z "${SWARMCAST_NO_PAUSE:-}" ] && [ -t 0 ] && [ -t 1 ]; then
    printf '\nPress Enter to close this window.'
    read -r _ || true
  fi
}

# The only line meant for logs: one summary line on stdout. Nothing is written to disk.
finish() {
  say ""
  say "[$(date '+%Y-%m-%d %H:%M:%S')] SwarmCast uninstall finished: $RESULT (exit code $EXIT_CODE)"
  pause_before_close
  exit "$EXIT_CODE"
}

on_signal() {
  trap - INT TERM HUP
  printf '\n'
  warn "Interrupted. Some files may already be deleted; run this again to finish."
  exit 130
}

have_tty() {
  [ -t 0 ] && return 0
  ( : </dev/tty ) 2>/dev/null
}

# confirm "question" -> 0 for yes, 1 for no (default: no)
confirm() {
  local ans=""
  if ! have_tty; then
    say "$1 (y/N) -> no terminal to ask, assuming \"no\"."
    return 1
  fi
  printf '%s (y/N) ' "$1"
  read -r ans </dev/tty || ans=""
  case "$ans" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep-settings | --keep-config | -KeepSettings) OPT_KEEP=1 ;;
      --ask | -Ask) OPT_ASK=1 ;;
      --yes | -y | -Yes) ;;
      --help | -h | -Help) OPT_HELP=1 ;;
      *)
        printf 'Unknown option: %s\n\n' "$1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

refuse_root() {
  if [ "$(id -u)" = "0" ]; then
    printf '%s\n' \
      "✗ Please do not run this script as root or with sudo." \
      "" \
      "  SwarmCast is installed in your own user folder; removing it needs no" \
      "  administrator rights. Run it again as your normal user, without sudo." >&2
    exit 1
  fi
}

setup_paths() {
  if [ -n "${SWARMCAST_HOME:-}" ]; then
    DATA_DIR="$SWARMCAST_HOME"
    case "$DATA_DIR" in /*) ;; *) DATA_DIR="$PWD/$DATA_DIR" ;; esac
  elif [ "$SC_OS" = macos ]; then
    DATA_DIR="$HOME/Library/Application Support/SwarmCast"
  else
    DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/swarmcast"
  fi
  while [ "${#DATA_DIR}" -gt 1 ] && [ "${DATA_DIR%/}" != "$DATA_DIR" ]; do DATA_DIR="${DATA_DIR%/}"; done
  DATA_REAL="$DATA_DIR"
  if [ -d "$DATA_DIR" ]; then
    DATA_REAL="$(cd "$DATA_DIR" 2>/dev/null && pwd -P)" || DATA_REAL="$DATA_DIR"
  fi
}

# Refuses folders that can never be a SwarmCast data folder (a wrong SWARMCAST_HOME).
check_safe_target() {
  local home_real="" d
  if [ -d "$HOME" ]; then home_real="$(cd "$HOME" 2>/dev/null && pwd -P)"; fi
  for d in "$DATA_DIR" "$DATA_REAL"; do
    case "$d" in
      / | "" | "$HOME" | "$home_real" | /home | /Users | /usr | /usr/* | /etc | /etc/* | /bin | /sbin | /System | /System/* | /Library | /Applications | /var | /tmp | /private | /private/tmp | /private/var)
        return 1 ;;
    esac
    # An ancestor of the home folder.
    case "$HOME/" in "$d"/*) return 1 ;; esac
    if [ -n "$home_real" ]; then case "$home_real/" in "$d"/*) return 1 ;; esac; fi
  done
  return 0
}

looks_like_swarmcast() {
  local m
  for m in $SC_MARKERS; do
    if [ -e "$DATA_DIR/$m" ]; then return 0; fi
  done
  return 1
}

# Prints "PID<TAB>executable path" for this user's processes.
list_processes() {
  local p exe pid uid me
  if [ "$SC_OS" = linux ] && [ -d /proc/self ]; then
    # One GNU find instead of a readlink per process (other users' links are unreadable).
    if find /proc/self/ -maxdepth 0 -printf '' >/dev/null 2>&1; then
      find /proc -mindepth 2 -maxdepth 2 -name exe -printf '%h\t%l\n' 2>/dev/null |
        awk -F '\t' '$2 != "" { sub(/^\/proc\//, "", $1); if ($1 !~ /^[0-9]+$/) next; sub(/ \(deleted\)$/, "", $2); print $1 "\t" $2 }'
      return 0
    fi
    for p in /proc/[0-9]*; do
      exe="$(readlink "$p/exe" 2>/dev/null)" || continue
      [ -n "$exe" ] || continue
      printf '%s\t%s\n' "${p#/proc/}" "${exe% (deleted)}"
    done
    return 0
  fi
  me="$(id -u)"
  # macOS: "comm" is the executable path as it was started (absolute for SwarmCast's
  # own processes); lsof resolves the rare relative one.
  ps -axo pid=,uid=,comm= 2>/dev/null | while read -r pid uid exe; do
    [ "$uid" = "$me" ] || continue
    case "$exe" in
      /*) ;;
      *) exe="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)" ;;
    esac
    [ -n "$exe" ] && printf '%s\t%s\n' "$pid" "$exe"
  done
}

# Processes whose executable lives inside the data folder (swarmcast, its reaper,
# mediamtx, cloudflared, swarmcast-tray, ffmpeg...). Nothing else is ever touched.
find_swarmcast_processes() {
  local pid exe
  list_processes | while IFS="$(printf '\t')" read -r pid exe; do
    [ "$pid" = "$$" ] && continue
    case "$exe" in
      "$DATA_DIR"/* | "$DATA_REAL"/*) printf '%s\t%s\n' "$pid" "$exe" ;;
    esac
  done
}

# describe "PID<TAB>path" lines -> "name (PID n), ..."
describe() {
  printf '%s\n' "$1" | awk -F '\t' 'NF { n = split($2, a, "/"); printf "%s%s (PID %s)", (c++ ? ", " : ""), a[n], $1 }'
}

pids_of() { printf '%s\n' "$1" | awk -F '\t' 'NF { printf "%s ", $1 }'; }

# wait_until_gone SECONDS: polls until nothing runs from the data folder; sets FOUND.
wait_until_gone() {
  local waited=0 limit=$(($1 * 2))
  FOUND="$(find_swarmcast_processes)"
  while [ -n "$FOUND" ] && [ "$waited" -lt "$limit" ]; do
    sleep 0.5
    waited=$((waited + 1))
    FOUND="$(find_swarmcast_processes)"
  done
}

stop_processes() {
  local found pid exe
  found="$(find_swarmcast_processes)"
  if [ -z "$found" ]; then
    ok "SwarmCast is not running."
    return 0
  fi
  heading "Stopping SwarmCast"
  while IFS="$(printf '\t')" read -r pid exe; do
    [ -n "$pid" ] && say "  ${exe##*/} (PID $pid)"
  done <<EOF
$found
EOF
  # Graceful first: SwarmCast stops everything by itself on SIGTERM.
  # shellcheck disable=SC2046 # list of PIDs
  kill -TERM $(pids_of "$found") 2>/dev/null
  case "$SC_STOP_GRACE" in '' | *[!0-9]*) SC_STOP_GRACE=10 ;; esac
  wait_until_gone "$SC_STOP_GRACE"
  if [ -n "$FOUND" ]; then
    say "  Still running after ${SC_STOP_GRACE} s; forcing it to stop..."
    # Only what still runs from the data folder right now (never a reused PID).
    # shellcheck disable=SC2046 # list of PIDs
    kill -KILL $(pids_of "$FOUND") 2>/dev/null
    wait_until_gone 5
  fi
  if [ -n "$FOUND" ]; then
    warn "Could not stop: $(describe "$FOUND"). Restart the computer and run this again if files remain."
    return 1
  fi
  ok "SwarmCast stopped."
}

# Removes a router port left open by a crash (Direct mode), using SwarmCast itself.
router_cleanup() {
  local bin="" out rc pid wd line
  if [ -x "$DATA_DIR/app/current/swarmcast" ]; then
    bin="$DATA_DIR/app/current/swarmcast"
  elif [ -x "$DATA_DIR/app/previous/swarmcast" ]; then
    bin="$DATA_DIR/app/previous/swarmcast"
  else
    return 0
  fi
  say "Checking the router for a port SwarmCast left open..."
  out="$(
    SWARMCAST_DATA_DIR="$DATA_DIR" "$bin" --cleanup --data-dir "$DATA_DIR" </dev/null 2>&1 &
    pid=$!
    ( sleep "$SC_CLEANUP_TIMEOUT"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
    wd=$!
    wait "$pid"
    rc=$?
    kill "$wd" 2>/dev/null
    exit "$rc"
  )"
  rc=$?
  while IFS= read -r line; do
    [ -n "$line" ] && say "  $line"
  done <<EOF
$out
EOF
  if [ "$rc" != 0 ]; then
    warn "Note: the router port cleanup did not finish (exit code $rc). This only matters if you used Direct mode: then check your router's port forwarding list for a \"SwarmCast\" entry. Continuing."
  fi
  return 0
}

# remove_with_retry PATH: deletes a file or folder, retrying (files can be busy for a moment).
remove_with_retry() {
  local p="$1" d
  rm -rf -- "$p" 2>/dev/null
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then return 0; fi
  for d in $SC_DELETE_DELAYS; do
    say "  Some files are still busy; trying again in ${d} s..."
    sleep "$d"
    chmod -R u+rwX -- "$p" 2>/dev/null
    rm -rf -- "$p" 2>/dev/null
    if [ ! -e "$p" ] && [ ! -L "$p" ]; then return 0; fi
  done
  return 1
}

report_leftovers() {
  local p="$1" n=0 f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    if [ "$n" -le 20 ]; then say "    $f"; fi
  done <<EOF
$(find "$p" -depth 2>/dev/null)
EOF
  if [ "$n" -gt 20 ]; then say "    ... and $((n - 20)) more"; fi
}

delete_data() {
  local failed="" e name
  heading "Deleting SwarmCast files"
  cd "$HOME" 2>/dev/null || cd / || true
  if [ "$OPT_KEEP" = 1 ]; then
    for e in "$DATA_DIR"/* "$DATA_DIR"/.[!.]* "$DATA_DIR"/..?*; do
      [ -e "$e" ] || [ -L "$e" ] || continue
      name="${e##*/}"
      case "$name" in config.json | secrets.json) continue ;; esac
      remove_with_retry "$e" || failed="$failed
$e"
    done
  else
    remove_with_retry "$DATA_DIR" || failed="$DATA_DIR"
  fi
  if [ -n "$failed" ]; then
    err "Some files could not be removed:"
    while IFS= read -r e; do
      [ -n "$e" ] && report_leftovers "$e"
    done <<EOF
$failed
EOF
    say "  Close any program that may be using them (or restart the computer) and run this again."
    return 1
  fi
  return 0
}

main() {
  parse_args "$@"
  init_colors
  if [ "$OPT_HELP" = 1 ]; then
    usage
    exit 0
  fi
  refuse_root
  setup_paths
  trap on_signal INT TERM HUP

  say "${C_BOLD}SwarmCast uninstaller for $SC_OS_LABEL${C_RESET}"
  say "Data folder: $DATA_DIR"

  if [ ! -e "$DATA_DIR" ] && [ ! -L "$DATA_DIR" ]; then
    ok "SwarmCast is not installed on this computer (no data folder). Nothing to do."
    say "$SC_OBS_NOTE"
    RESULT="not installed"
    finish
  fi
  if ! check_safe_target; then
    err "$DATA_DIR is not a SwarmCast data folder (check SWARMCAST_HOME). Nothing was deleted."
    EXIT_CODE=1; RESULT="refused: unsafe folder $DATA_DIR"
    finish
  fi
  if [ ! -d "$DATA_DIR" ] || ! looks_like_swarmcast; then
    if [ -d "$DATA_DIR" ] && [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
      rmdir "$DATA_DIR" 2>/dev/null
      ok "SwarmCast is not installed on this computer (the data folder was empty and has been removed)."
      say "$SC_OBS_NOTE"
      RESULT="not installed"
      finish
    fi
    err "$DATA_DIR does not look like a SwarmCast data folder (check SWARMCAST_HOME). Nothing was deleted."
    EXIT_CODE=1; RESULT="refused: not a SwarmCast folder"
    finish
  fi

  if [ "$OPT_KEEP" = 1 ]; then
    say "Your settings and stream key (config.json, secrets.json) will be kept (--keep-settings)."
  fi
  if [ "$OPT_ASK" = 1 ]; then
    local q="Remove SwarmCast and all its files from this computer?"
    if [ "$OPT_KEEP" = 1 ]; then q="Remove SwarmCast from this computer (keeping your settings and stream key)?"; fi
    if ! confirm "$q"; then
      say "Uninstall cancelled. Nothing was changed."
      EXIT_CODE=1; RESULT="cancelled"
      finish
    fi
  fi

  stop_processes
  router_cleanup
  if delete_data; then
    heading "Done"
    if [ "$OPT_KEEP" = 1 ]; then
      ok "SwarmCast was removed. Your settings and stream key were kept in: $DATA_DIR"
      say "  Run the start script again to reinstall with the same stream key, or delete that folder to remove them too."
      RESULT="removed (settings kept in $DATA_DIR)"
    else
      ok "SwarmCast was removed from this computer."
      RESULT="removed $DATA_DIR"
    fi
    say "$SC_OBS_NOTE"
    say "You can also delete the folder with the installer files (the extracted zip) yourself."
  else
    EXIT_CODE=1
    RESULT="some files could not be removed"
    say "$SC_OBS_NOTE"
  fi
  finish
}

main "$@"
