#!/usr/bin/env bash
# SwarmCast - uninstall on macOS.
#
# Double-click this file in Finder, or run it from Terminal. The first time, macOS
# may refuse to open a downloaded .command: right-click it -> Open (macOS 14 and
# older), or System Settings -> Privacy & Security -> Open Anyway (macOS 15+).
#   ./uninstall-macos.command [options]
#
# It stops SwarmCast if it is running, removes a router port that a crash may have
# left open (Direct mode), removes the SwarmCast desktop app (SwarmCast.app in
# Applications, only when its bundle id is SwarmCast's) and its "start with the
# computer" entry, then deletes the SwarmCast data folder. It never asks anything
# (unless --ask), never uses sudo, and never touches OBS or anything that is not
# SwarmCast's own.
#
# Everything below the marker line is identical in uninstall-macos.command and
# uninstall-linux.sh (scripts/test/uninstall.sh checks it). Compatible with the
# bash 3.2 that ships with macOS.
# shellcheck disable=SC2329 # functions run through trap

SC_SCRIPT_NAME="uninstall-macos.command"

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
# Desktop app (docs/DESKTOP.md).
SC_APP_ID="io.github.lucas-angelo.swarmcast"
SC_DEB_PACKAGE="swarm-cast"
SC_BOOTOUT_TIMEOUT=15                          # seconds for "launchctl bootout"
# macOS: the system-wide Applications folder (the tests point it at a fake one).
SC_SYSTEM_APPS="${SWARMCAST_APPLICATIONS_DIR:-/Applications}"

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
crash may have left open, removes the SwarmCast desktop app and its "start with
the computer" entry, and deletes the SwarmCast data folder.

Usage: $SC_SCRIPT_NAME [options]

Options:
  --keep-settings   Keep your settings and stream key (config.json, secrets.json);
                    reinstalling later gives you the same stream key
  --ask             Ask for confirmation before removing anything
  --yes             Accepted for compatibility (nothing is asked by default)
  --help            Show this help

Environment:
  SWARMCAST_HOME    Data folder (default: $(default_data_dir_label))

OBS and its settings are never changed. Only SwarmCast's own files are deleted.
$(desktop_usage_note)
EOF
}

desktop_usage_note() {
  if [ "$SC_OS" = macos ]; then
    printf '%s' "SwarmCast.app is removed only when its bundle id is $SC_APP_ID."
  else
    printf '%s' "A $SC_DEB_PACKAGE package is not removed (that needs sudo): the command is shown."
  fi
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

# ---------------------------------------------------------------------------
# Desktop app (docs/DESKTOP.md)
# ---------------------------------------------------------------------------

# add_line VAR VALUE: appends VALUE as a new line of the list in VAR.
add_line() {
  if [ -z "${!1}" ]; then printf -v "$1" '%s' "$2"; else printf -v "$1" '%s\n%s' "${!1}" "$2"; fi
}

# xdg_dir VALUE DEFAULT: an XDG base folder; relative values are ignored (XDG spec).
xdg_dir() {
  case "${1:-}" in /*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac
}

# bundle_id APP: CFBundleIdentifier of a .app (empty when it has none).
bundle_id() {
  local plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || return 0
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null
    return 0
  fi
  tr -d '\r\n' <"$plist" 2>/dev/null |
    sed -n 's|.*<key>CFBundleIdentifier</key>[[:space:]]*<string>\([^<]*\)</string>.*|\1|p'
}

# is_swarmcast_appimage PATH: a SwarmCast*.AppImage directly in one of the folders
# where people keep AppImages.
is_swarmcast_appimage() {
  local d name
  for d in "$HOME/Applications" "$HOME/Downloads" "$HOME/.local/bin"; do
    case "$1" in "$d"/*) ;; *) continue ;; esac
    name="${1#"$d"/}"
    case "$name" in */*) continue ;; SwarmCast*.AppImage) return 0 ;; esac
  done
  return 1
}

# Programs started by a .desktop file (Exec= and TryExec= of [Desktop Entry]).
desktop_entry_programs() {
  awk '
    /^[ \t]*\[/ { main = ($0 ~ /^[ \t]*\[Desktop Entry\][ \t]*$/); next }
    main && /^(Exec|TryExec)[ \t]*=/ {
      v = $0
      sub(/^[^=]*=[ \t]*/, "", v)
      if (substr(v, 1, 1) == "\"") { v = substr(v, 2); i = index(v, "\""); if (i) v = substr(v, 1, i - 1) }
      else { i = index(v, " "); if (i) v = substr(v, 1, i - 1) }
      print v
    }' "$1" 2>/dev/null
}

# Finds the desktop app's pieces. Sets AUTOSTART_FILE, DESKTOP_APPS (SwarmCast.app
# bundles with SwarmCast's bundle id), FOREIGN_APPS (a SwarmCast.app that is not
# ours: left alone), APPIMAGES, DESKTOP_ENTRIES (menu entries that start one of those
# AppImages), DESKTOP_DIRS (the app's caches and web data), DEB_INSTALLED, and the
# process filters PROC_DIRS / PROC_FILES.
find_desktop_app() {
  local b f d id config data cache
  AUTOSTART_FILE=""; DESKTOP_APPS=""; FOREIGN_APPS=""; APPIMAGES=""; DESKTOP_ENTRIES=""
  DESKTOP_DIRS=""; DEB_INSTALLED=0; PROC_DIRS=""; PROC_FILES=""
  add_line PROC_DIRS "$DATA_DIR"
  add_line PROC_DIRS "$DATA_REAL"
  if [ "$SC_OS" = macos ]; then
    AUTOSTART_FILE="$HOME/Library/LaunchAgents/$SC_APP_ID.plist"
    for b in "$SC_SYSTEM_APPS/SwarmCast.app" "$HOME/Applications/SwarmCast.app"; do
      [ -d "$b" ] || continue
      id="$(bundle_id "$b")"
      if [ "$id" = "$SC_APP_ID" ]; then
        add_line DESKTOP_APPS "$b"
        add_line PROC_DIRS "$b"
        add_line PROC_DIRS "$(cd "$b" 2>/dev/null && pwd -P)"
      else
        add_line FOREIGN_APPS "$b (bundle id: ${id:-none})"
      fi
    done
    for d in "Caches/$SC_APP_ID" "WebKit/$SC_APP_ID" "HTTPStorages/$SC_APP_ID" \
      "Application Support/$SC_APP_ID" "Saved Application State/$SC_APP_ID.savedState"; do
      if [ -e "$HOME/Library/$d" ] || [ -L "$HOME/Library/$d" ]; then add_line DESKTOP_DIRS "$HOME/Library/$d"; fi
    done
  else
    config="$(xdg_dir "${XDG_CONFIG_HOME:-}" "$HOME/.config")"
    data="$(xdg_dir "${XDG_DATA_HOME:-}" "$HOME/.local/share")"
    cache="$(xdg_dir "${XDG_CACHE_HOME:-}" "$HOME/.cache")"
    AUTOSTART_FILE="$config/autostart/swarmcast.desktop"
    for d in "$HOME/Applications" "$HOME/Downloads" "$HOME/.local/bin"; do
      for f in "$d"/SwarmCast*.AppImage; do
        if [ -f "$f" ] || [ -L "$f" ]; then add_line APPIMAGES "$f"; add_line PROC_FILES "$f"; fi
      done
    done
    # Menu entries made for an AppImage (AppImageLauncher, Gear Lever, by hand): only
    # *swarmcast*.desktop files whose command is a SwarmCast AppImage from the
    # folders above (present or already deleted).
    for f in "$data/applications"/*.desktop; do
      [ -f "$f" ] || continue
      case "$(printf '%s' "${f##*/}" | tr '[:upper:]' '[:lower:]')" in *swarmcast*) ;; *) continue ;; esac
      while IFS= read -r b; do
        if [ -n "$b" ] && is_swarmcast_appimage "$b"; then add_line DESKTOP_ENTRIES "$f"; break; fi
      done <<EOF
$(desktop_entry_programs "$f")
EOF
    done
    for d in "$data/$SC_APP_ID" "$cache/$SC_APP_ID" "$config/$SC_APP_ID"; do
      if [ -e "$d" ] || [ -L "$d" ]; then add_line DESKTOP_DIRS "$d"; fi
    done
    if command -v dpkg-query >/dev/null 2>&1 &&
      dpkg-query -W -f='${Status}' "$SC_DEB_PACKAGE" 2>/dev/null | grep -q ' installed$'; then
      DEB_INSTALLED=1
    fi
    # The package's files (stopped, never deleted: that is apt's job).
    add_line PROC_DIRS "/usr/lib/SwarmCast"
    add_line PROC_FILES "/usr/bin/swarmcast-desktop"
    add_line PROC_FILES "/usr/bin/swarmcast-server"
  fi
}

# True when any part of the desktop app is on this computer.
desktop_app_found() {
  [ -n "$DESKTOP_APPS$APPIMAGES$DESKTOP_ENTRIES$DESKTOP_DIRS" ] || [ "$DEB_INSTALLED" = 1 ] ||
    [ -e "$AUTOSTART_FILE" ] || [ -L "$AUTOSTART_FILE" ]
}

show_desktop_app() {
  local x
  while IFS= read -r x; do [ -n "$x" ] && say "Desktop app: $x"; done <<EOF
$DESKTOP_APPS
$APPIMAGES
EOF
  if [ "$DEB_INSTALLED" = 1 ]; then say "Desktop app: package $SC_DEB_PACKAGE (installed with apt)"; fi
  while IFS= read -r x; do [ -n "$x" ] && say "Not SwarmCast's, left alone: $x"; done <<EOF
$FOREIGN_APPS
EOF
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

# Processes whose executable lives inside a SwarmCast folder: the data folder
# (swarmcast, its reaper, mediamtx, cloudflared, swarmcast-tray, ffmpeg...) and the
# desktop app (SwarmCast.app, a SwarmCast AppImage and the folder it mounts, the
# swarm-cast package's files). Nothing else is ever touched.
find_swarmcast_processes() {
  list_processes | SC_SELF="$$" SC_DIRS="$PROC_DIRS" SC_FILES="$PROC_FILES" SC_LINUX="$([ "$SC_OS" = linux ] && echo 1)" awk -F '\t' '
    BEGIN { nd = split(ENVIRON["SC_DIRS"], dirs, "\n"); nf = split(ENVIRON["SC_FILES"], files, "\n") }
    $1 == ENVIRON["SC_SELF"] || $2 == "" { next }
    {
      for (i = 1; i <= nd; i++) if (dirs[i] != "" && index($2, dirs[i] "/") == 1) { print; next }
      for (i = 1; i <= nf; i++) if (files[i] != "" && $2 == files[i]) { print; next }
      # A running AppImage mounts itself at <tmp>/.mount_<first 6 letters of its name>XXXXXX.
      if (ENVIRON["SC_LINUX"] == 1 && tolower($2) ~ /\/\.mount_swarmc[^\/]*\/usr\/(bin\/swarmcast-(desktop|server)$|lib\/swarmcast\/|libexec\/swarmcast\/swarmcast-server$)/) { print; next }
    }'
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

# The SwarmCast program that can run "--cleanup": the script-mode one in the data
# folder, else the desktop app's server (its sidecar). Empty when there is none.
cleanup_binary() {
  local c b
  for c in "$DATA_DIR/app/current/swarmcast" "$DATA_DIR/app/previous/swarmcast"; do
    if [ -f "$c" ] && [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    c="$b/Contents/MacOS/swarmcast-server"
    if [ -f "$c" ] && [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done <<EOF
$DESKTOP_APPS
EOF
  c="/usr/bin/swarmcast-server"
  if [ "$DEB_INSTALLED" = 1 ] && [ -f "$c" ] && [ -x "$c" ]; then printf '%s' "$c"; fi
  return 0
}

# Removes a router port left open by a crash (Direct mode), using SwarmCast itself.
router_cleanup() {
  local bin out rc pid wd line
  bin="$(cleanup_binary)"
  [ -n "$bin" ] || return 0
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


# run_bounded SECONDS command...: runs a command, killing it after SECONDS.
run_bounded() {
  local secs="$1" pid wd rc
  shift
  "$@" </dev/null &
  pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  wd=$!
  wait "$pid"
  rc=$?
  kill "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null
  return "$rc"
}

FAILED=""       # paths that could not be removed (reported at the end)
ADMIN_APPS=""   # SwarmCast.app bundles this user may not remove

# remove_or_record PATH: remove_with_retry, remembering a failure for the report.
remove_or_record() {
  if remove_with_retry "$1"; then return 0; fi
  add_line FAILED "$1"
  return 1
}

# The "start with the computer" entry (written by the app, off by default).
remove_autostart() {
  if [ "$SC_OS" = macos ] && { [ -n "$DESKTOP_APPS" ] || [ -e "$AUTOSTART_FILE" ]; } &&
    command -v launchctl >/dev/null 2>&1; then
    # Unloads the login item too (best effort: usually it is not loaded).
    run_bounded "$SC_BOOTOUT_TIMEOUT" launchctl bootout "gui/$(id -u)/$SC_APP_ID" >/dev/null 2>&1
  fi
  if [ -e "$AUTOSTART_FILE" ] || [ -L "$AUTOSTART_FILE" ]; then
    if remove_or_record "$AUTOSTART_FILE"; then ok "Removed the \"start with the computer\" entry: $AUTOSTART_FILE"; fi
  fi
}

remove_desktop_app() {
  local b parent x n=0
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    parent="${b%/*}"
    # /Applications is only writable for administrators: never sudo, tell the user.
    if [ ! -w "$parent" ] || { [ ! -O "$b" ] && [ ! -w "$b" ]; }; then
      add_line ADMIN_APPS "$b"
      continue
    fi
    if remove_or_record "$b"; then ok "Removed the desktop app: $b"; fi
  done <<EOF
$DESKTOP_APPS
EOF
  while IFS= read -r x; do
    [ -n "$x" ] || continue
    if remove_or_record "$x"; then ok "Removed the menu entry: $x"; fi
  done <<EOF
$DESKTOP_ENTRIES
EOF
  while IFS= read -r x; do
    [ -n "$x" ] || continue
    if remove_or_record "$x"; then ok "Removed the desktop app: $x"; fi
  done <<EOF
$APPIMAGES
EOF
  while IFS= read -r x; do
    [ -n "$x" ] || continue
    if remove_or_record "$x"; then n=$((n + 1)); fi
  done <<EOF
$DESKTOP_DIRS
EOF
  if [ "$n" -gt 0 ]; then ok "Removed the desktop app's caches and web data ($n folders)."; fi
}

delete_data() {
  local e name
  if [ "$OPT_KEEP" = 1 ]; then
    for e in "$DATA_DIR"/* "$DATA_DIR"/.[!.]* "$DATA_DIR"/..?*; do
      [ -e "$e" ] || [ -L "$e" ] || continue
      name="${e##*/}"
      case "$name" in config.json | secrets.json) continue ;; esac
      remove_or_record "$e"
    done
  else
    remove_or_record "$DATA_DIR"
  fi
}

# What needs an administrator: shown at the end, never done with sudo.
show_admin_steps() {
  local b
  [ -n "$ADMIN_APPS" ] || [ "$DEB_INSTALLED" = 1 ] || return 0
  heading "Still to do (needs an administrator)"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    warn "$b was not removed: your user is not allowed to change ${b%/*}. In Finder, drag SwarmCast from ${b%/*} to the Trash (macOS asks for an administrator's name and password)."
  done <<EOF
$ADMIN_APPS
EOF
  if [ "$DEB_INSTALLED" = 1 ]; then
    warn "The SwarmCast desktop app is installed as a system package ($SC_DEB_PACKAGE). To remove it, run this command in a terminal (it asks for your password):"
    say ""
    say "    sudo apt remove $SC_DEB_PACKAGE"
  fi
}

admin_result() {
  local r=""
  if [ -n "$ADMIN_APPS" ]; then r="; still installed (needs an administrator): $(printf '%s' "$ADMIN_APPS" | tr '\n' ' ')"; fi
  if [ "$DEB_INSTALLED" = 1 ]; then r="$r; still installed: package $SC_DEB_PACKAGE (sudo apt remove $SC_DEB_PACKAGE)"; fi
  printf '%s' "$r"
}

main() {
  local have_data=0 removed_empty=0 e
  parse_args "$@"
  init_colors
  if [ "$OPT_HELP" = 1 ]; then
    usage
    exit 0
  fi
  refuse_root
  setup_paths
  trap on_signal INT TERM HUP
  find_desktop_app

  say "${C_BOLD}SwarmCast uninstaller for $SC_OS_LABEL${C_RESET}"
  say "Data folder: $DATA_DIR"
  show_desktop_app

  if [ -e "$DATA_DIR" ] || [ -L "$DATA_DIR" ]; then
    if ! check_safe_target; then
      err "$DATA_DIR is not a SwarmCast data folder (check SWARMCAST_HOME). Nothing was deleted."
      EXIT_CODE=1; RESULT="refused: unsafe folder $DATA_DIR"
      finish
    fi
    if [ -d "$DATA_DIR" ] && looks_like_swarmcast; then
      have_data=1
    elif [ -d "$DATA_DIR" ] && [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
      rmdir "$DATA_DIR" 2>/dev/null
      removed_empty=1
    else
      err "$DATA_DIR does not look like a SwarmCast data folder (check SWARMCAST_HOME). Nothing was deleted."
      EXIT_CODE=1; RESULT="refused: not a SwarmCast folder"
      finish
    fi
  fi
  if [ "$have_data" = 0 ] && ! desktop_app_found; then
    if [ "$removed_empty" = 1 ]; then
      ok "SwarmCast is not installed on this computer (the data folder was empty and has been removed)."
    else
      ok "SwarmCast is not installed on this computer (no data folder). Nothing to do."
    fi
    say "$SC_OBS_NOTE"
    RESULT="not installed"
    finish
  fi

  if [ "$have_data" = 1 ] && [ "$OPT_KEEP" = 1 ]; then
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
  if [ "$have_data" = 1 ]; then router_cleanup; fi
  heading "Deleting SwarmCast files"
  cd "$HOME" 2>/dev/null || cd / || true
  remove_autostart
  remove_desktop_app
  if [ "$have_data" = 1 ]; then delete_data; fi

  if [ -z "$FAILED" ]; then
    heading "Done"
    if [ "$have_data" = 1 ] && [ "$OPT_KEEP" = 1 ]; then
      ok "SwarmCast was removed. Your settings and stream key were kept in: $DATA_DIR"
      say "  Run the start script again to reinstall with the same stream key, or delete that folder to remove them too."
      RESULT="removed (settings kept in $DATA_DIR)"
    else
      if [ -n "$ADMIN_APPS" ] || [ "$DEB_INSTALLED" = 1 ]; then
        ok "SwarmCast's files in your user folder were removed."
      else
        ok "SwarmCast was removed from this computer."
      fi
      if [ "$have_data" = 1 ]; then RESULT="removed $DATA_DIR"; else RESULT="removed the desktop app"; fi
    fi
    RESULT="$RESULT$(admin_result)"
    show_admin_steps
    say "$SC_OBS_NOTE"
    say "You can also delete the folder with the installer files (the extracted zip) yourself."
  else
    err "Some files could not be removed:"
    while IFS= read -r e; do
      [ -n "$e" ] && report_leftovers "$e"
    done <<EOF
$FAILED
EOF
    say "  Close any program that may be using them (or restart the computer) and run this again."
    case "$FAILED" in *.app | *.app$'\n'*) say "  An app can also be dragged from Finder to the Trash." ;; esac
    show_admin_steps
    EXIT_CODE=1
    RESULT="some files could not be removed$(admin_result)"
    say "$SC_OBS_NOTE"
  fi
  finish
}

main "$@"
