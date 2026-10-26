#!/usr/bin/env bash
# SwarmCast - install, update and start on macOS.
#
# Double-click this file in Finder, or run it from Terminal. The first time,
# macOS may refuse to open a downloaded .command: right-click it -> Open (macOS 14
# and older), or System Settings -> Privacy & Security -> Open Anyway (macOS 15+).
#
#   ./start-macos.command [options]
#   curl -fsSL https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/start-macos.sh | bash
#   curl -fsSL .../start-macos.sh | bash -s -- --no-tunnel
#
# Installer zip (offline install): when this script sits
# next to SHA256SUMS.txt and the matching SwarmCast-v*-<os>-<arch>.tar.gz (as in
# SwarmCast-vX.Y.Z-<os>-<arch>-installer.zip), it installs from those files.
#
# Everything is defined inside functions and `main` is only called on the last
# line, so a partially downloaded script (curl | bash) never runs half-way.
# Compatible with the bash 3.2 that ships with macOS.
# shellcheck disable=SC2329 # functions run through with_retry / trap

set -u
set -o pipefail

SC_OS="macos"
SC_OS_LABEL="macOS"
SC_DEFAULT_RELEASE_URL="https://github.com/Lucas-Angelo/swarmcast/releases/latest/download"
SC_SCRIPT_NAME="start-macos.command"
SC_ISSUES_URL="https://github.com/Lucas-Angelo/swarmcast/issues"
SC_SPEED_DOWN_URL="https://speed.cloudflare.com/__down?bytes=10000000"
SC_SPEED_UP_URL="https://speed.cloudflare.com/__up"
SC_PORTS="1935 8080 8081"
SC_RETRY_DELAYS="2 4 8"
SC_STEP_DELAYS="2 5 10"
SC_MIN_DISK_KB=512000      # 500 MB
SC_MIN_RAM_MB=3500         # "4 GB" machines report a bit less than 4096 MB
SC_REC_RAM_MB=7500         # "8 GB"
SC_MIN_CORES=2
SC_REC_CORES=4
SC_MIN_UP_MBPS=10
SC_REC_UP_MBPS=50
SC_OBS_HINT="Now set OBS to stream to rtmp://127.0.0.1:1935/live with the stream key shown in the panel (copy button), keyframe interval 2 s, and start streaming. The live link for your subscribers appears in the panel and here."

OPT_YES=0
OPT_ASK=0
OPT_NO_TUNNEL=0
OPT_INSTALL_ONLY=0
OPT_SMOKE=0
OPT_SKIP_SPEED=0
OPT_NO_FFMPEG=0
OPT_HELP=0

LOG_FILE=""
TMP_DIR=""
STAGING_DIR=""
BELOW=""
SCRIPT_DIR=""      # folder of this script; empty when piped (curl | bash)
LOCAL_DIR=""       # folder of a usable local bundle, if any
SOURCE="online"    # where the package comes from: online | local
FETCH_HTTP=""      # HTTP status of the last failed fetch_small (empty: no answer)
SC_GIVE_UP=0       # set by a step that must not be retried (e.g. HTTP 404)
BIN_JSON=""        # verified binaries.json (ffmpeg pins), if any
FF_WHY=""          # why the video converter was skipped
SC_RESULTS=""      # system-check.json entries
BELOW_IDS=""       # ids of the checks below the minimum
VIEWER_EST=""      # estimated viewers (from the upload speed)
JUST_UPDATED=0     # 1 when this run replaced an installed version (rollback possible)

usage() {
  cat <<'EOF'
SwarmCast setup for macOS: checks your computer, installs or updates SwarmCast
and starts it.

Usage: start-macos.command [options]

Options:
  --ask             Ask before continuing on a computer below the minimum
                    (by default the setup never asks: it warns and continues)
  --yes             Answer "yes" to the questions --ask would ask (kept for
                    compatibility; nothing is asked by default)
  --no-tunnel       Start SwarmCast without the public tunnel (local testing)
  --install-only    Install or update, then exit without starting SwarmCast
  --smoke-test      Install or update, run "swarmcast --smoke-test", exit with its result
  --skip-speedtest  Skip the internet speed test
  --no-ffmpeg       Do not download the video converter (ffmpeg) for the extra qualities
  --help            Show this help

Environment:
  SWARMCAST_HOME         Data folder (default: ~/Library/Application Support/SwarmCast)
  SWARMCAST_RELEASE_URL  Where releases are downloaded from
                         (default: https://github.com/Lucas-Angelo/swarmcast/releases/latest/download)

Install source, first match wins:
  1. SWARMCAST_RELEASE_URL, when set.
  2. A local bundle: SHA256SUMS.txt and this system's SwarmCast-v*.tar.gz in the
     same folder as this script (the extracted installer zip). The default
     release URL is still checked once for a newer version; if it cannot be
     reached (offline, or an HTTP error), the local bundle is used.
  3. The default release URL.

Video converter: the extra viewer qualities (720p/480p/360p) need ffmpeg. It is
downloaded from its publisher (pins and SHA-256 in the release's binaries.json),
verified and kept in the data folder under tools/ffmpeg. Without it, or offline,
SwarmCast still works with your original quality only.

SwarmCast is installed for your user only; administrator rights are never needed.
EOF
}

# ---------------------------------------------------------------------------
# Output and logging
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

ts() { date '+%Y-%m-%d %H:%M:%S'; }

log_to_file() {
  if [ -n "$LOG_FILE" ]; then
    printf '[%s] %s\n' "$(ts)" "$*" >>"$LOG_FILE" 2>/dev/null
  fi
  return 0
}

say() { printf '%s\n' "$*"; log_to_file "$*"; }
ok() { printf '%s %s\n' "$SYM_OK" "$*"; log_to_file "✓ $*"; }
warn() { printf '%s %s\n' "$SYM_WARN" "$*"; log_to_file "⚠ $*"; }
err() { printf '%s %s%s%s\n' "$SYM_BAD" "$C_BOLD" "$*" "$C_RESET" >&2; log_to_file "✗ $*"; }
heading() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; log_to_file "== $* =="; }

pause_before_close() {
  # Keeps the window readable when something went wrong (e.g. after a double-click from
  # the file manager). The only key the setup ever waits for.
  if [ "$OPT_YES" = 0 ] && [ -z "${SWARMCAST_NO_PAUSE:-}" ] && [ -t 0 ] && [ -t 1 ]; then
    printf '\nPress Enter to close this window.'
    read -r _ || true
  fi
}

die() {
  local code="${2:-1}"
  err "$1"
  if [ -n "$LOG_FILE" ]; then
    printf 'Setup log: %s\n' "$LOG_FILE" >&2
  fi
  log_to_file "Exiting with code $code"
  cleanup
  pause_before_close
  exit "$code"
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

cleanup() {
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
  STAGING_DIR=""
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  TMP_DIR=""
}

on_signal() {
  trap - INT TERM HUP
  printf '\n'
  warn "Interrupted. Cleaning up; your installed version (if any) was not changed."
  cleanup
  exit 130
}

have_tty() {
  [ -t 0 ] && return 0
  ( : </dev/tty ) 2>/dev/null
}

# confirm "question" y|n  -> 0 for yes, 1 for no
confirm() {
  local q="$1" def="$2" hint ans
  if [ "$def" = "y" ]; then hint="(Y/n)"; else hint="(y/N)"; fi
  if [ "$OPT_YES" = 1 ]; then
    say "$q $hint yes (--yes)"
    return 0
  fi
  if ! have_tty; then
    say "$q $hint -> no terminal to ask, assuming \"$def\". Use --yes to answer yes automatically."
    [ "$def" = "y" ]
    return
  fi
  printf '%s %s ' "$q" "$hint"
  ans=""
  read -r ans </dev/tty || ans=""
  log_to_file "$q $hint answer: ${ans:-<Enter>}"
  case "$ans" in
    [yY] | [yY][eE][sS]) return 0 ;;
    [nN] | [nN][oO]) return 1 ;;
    *) [ "$def" = "y" ] ;;
  esac
}

add_below() {
  if [ -z "$BELOW" ]; then BELOW="$1"; else BELOW="$BELOW; $1"; fi
  BELOW_IDS="$BELOW_IDS ${2:-}"
}

# with_retry "description" command [args...]
# Tries up to 4 times (first try + 3 retries with 2 s, 4 s and 8 s back-off).
with_retry() {
  local desc="$1" attempt=1 delay
  shift
  SC_GIVE_UP=0
  if "$@"; then return 0; fi
  for delay in $SC_RETRY_DELAYS; do
    if [ "$SC_GIVE_UP" = 1 ]; then break; fi
    attempt=$((attempt + 1))
    log_to_file "$desc failed; retrying in ${delay}s (attempt $attempt)"
    printf '  %s failed, retrying in %ss...\n' "$desc" "$delay"
    sleep "$delay"
    if "$@"; then return 0; fi
  done
  log_to_file "$desc failed after $attempt attempts"
  return 1
}

# fetch_small URL OUTFILE: small downloads (checksum list), errors go to the log.
# An HTTP 401/403/404 answer (nothing to download there) is final: no retries.
fetch_small() {
  local code rc=0
  rm -f "$2"
  FETCH_HTTP=""
  code="$(curl -sSL --connect-timeout 10 --max-time 60 -o "$2" -w '%{http_code}' "$1" 2>>"$LOG_FILE")" || rc=$?
  if [ "$rc" = 0 ] && [ "$code" = 200 ]; then return 0; fi
  case "$code" in
    000 | 200 | '') ;;
    *)
      FETCH_HTTP="$code"
      log_to_file "$1 answered HTTP $code"
      case "$code" in 401 | 403 | 404) SC_GIVE_UP=1 ;; esac
      ;;
  esac
  rm -f "$2"
  return 1
}

# download_file URL OUTFILE: large download with a progress bar when interactive.
download_file() {
  rm -f "$2"
  if [ -t 2 ]; then
    curl -fL --progress-bar --connect-timeout 15 --speed-limit 1024 --speed-time 60 -o "$2" "$1"
  else
    curl -fsSL --connect-timeout 15 --speed-limit 1024 --speed-time 60 -o "$2" "$1" 2>>"$LOG_FILE"
  fi
}

check_github_once() {
  # Any HTTP answer means github.com is reachable.
  curl -sS -o /dev/null -I --connect-timeout 10 --max-time 20 "https://github.com" 2>>"$LOG_FILE"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  else
    openssl dgst -sha256 -r "$1" | awk '{print tolower($1)}'
  fi
}

# run_with_timeout SECONDS OUTFILE command [args...]
run_with_timeout() {
  local secs="$1" out="$2" pid wd rc
  shift 2
  "$@" >"$out" 2>&1 </dev/null &
  pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  wd=$!
  wait "$pid"
  rc=$?
  kill "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null
  return "$rc"
}

trim() { printf '%s' "$1" | tr -d ' \t\r\n'; }

# retry_step "description" command [args...]: local steps (unpacking, renaming, writing
# files, checks) get up to 3 more tries after 2 s, 5 s and 10 s, each attempt logged.
# Bounded on purpose: a step that keeps failing ends with a clear error.
retry_step() {
  local desc="$1" attempt=1 delay
  shift
  if "$@"; then return 0; fi
  for delay in $SC_STEP_DELAYS; do
    attempt=$((attempt + 1))
    log_to_file "$desc failed; retrying in ${delay}s (attempt $attempt of 4)"
    printf '  %s failed, retrying in %ss...\n' "$desc" "$delay"
    sleep "$delay"
    if "$@"; then return 0; fi
  done
  log_to_file "$desc failed after $attempt attempts"
  return 1
}

# Installer tests only: SWARMCAST_TEST_FAIL_ONCE=<step> makes that step fail on its first try.
test_fail_once() {
  [ "${SWARMCAST_TEST_FAIL_ONCE:-}" = "$1" ] || return 1
  [ -e "$TMP_DIR/.fail-once-$1" ] && return 1
  : >"$TMP_DIR/.fail-once-$1"
  log_to_file "test hook: failing step '$1' once"
  return 0
}

# JSON string contents (quotes, backslashes, control characters).
json_esc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/ }"
  s="${s//$'\r'/}"
  s="${s//$'\n'/ }"
  printf '%s' "$s"
}

# check_result ID STATUS VALUE MIN REC [DETAIL]: one entry of system-check.json.
check_result() {
  local st="$2"
  case "$st" in bad) st=fail ;; esac
  case "$3" in *skipped*) st=skipped ;; esac
  if [ -n "$SC_RESULTS" ]; then SC_RESULTS="$SC_RESULTS,"; fi
  SC_RESULTS="$SC_RESULTS
    {\"id\": \"$1\", \"status\": \"$st\", \"value\": \"$(json_esc "$3")\", \"min\": \"$(json_esc "$4")\", \"recommended\": \"$(json_esc "$5")\", \"detail\": \"$(json_esc "${6:-}")\"}"
}

# <data>/system-check.json: the report above, for the panel's first-run tutorial
# (English values; the panel translates by id and status). Written atomically.
write_system_check_once() {
  local f="$DATA_DIR/system-check.json" tmp below="" id
  for id in $BELOW_IDS; do
    if [ -n "$below" ]; then below="$below, "; fi
    below="$below\"$id\""
  done
  tmp="$f.tmp.$$"
  printf '{\n  "version": 1,\n  "at": "%s",\n  "os": "%s",\n  "arch": "%s",\n  "results": [%s\n  ],\n  "uploadMbps": %s,\n  "downloadMbps": %s,\n  "viewerEstimate": %s,\n  "belowMinimum": [%s]\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_esc "$OS_DESC")" "$ARCH" "$SC_RESULTS" \
    "${UP_MBPS:-null}" "${DOWN_MBPS:-null}" "${VIEWER_EST:-null}" "$below" >"$tmp" 2>>"$LOG_FILE" && mv -f "$tmp" "$f"
}

write_system_check() {
  if ! retry_step "Saving the system check" write_system_check_once; then
    rm -f "$DATA_DIR/system-check.json.tmp.$$"
    warn "Could not save $DATA_DIR/system-check.json (the panel will not show this report)."
  fi
}

mbps_of_bps() { awk -v b="$1" 'BEGIN { printf "%.1f", b * 8 / 1000000 }'; }

# num_ge A B -> true when A >= B (floating point)
num_ge() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 >= b + 0) }'; }

# ver_gt A B -> true when version A (X.Y.Z) is newer than version B
ver_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 1
  }'
}

gb_of_mb() { awk -v m="$1" 'BEGIN { printf "%.1f GB", m / 1024 }'; }

size_of_kb() {
  awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1f GB", k / 1048576; else printf "%d MB", k / 1024 }'
}

# ---------------------------------------------------------------------------
# Setup steps
# ---------------------------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes | -y) OPT_YES=1 ;;
      --ask) OPT_ASK=1 ;;
      --no-tunnel) OPT_NO_TUNNEL=1 ;;
      --install-only) OPT_INSTALL_ONLY=1 ;;
      --smoke-test) OPT_SMOKE=1 ;;
      --skip-speedtest | --skip-speed-test) OPT_SKIP_SPEED=1 ;;
      --no-ffmpeg) OPT_NO_FFMPEG=1 ;;
      --help | -h) OPT_HELP=1 ;;
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
      "  SwarmCast installs into your own user folder and runs as your normal user." \
      "  Running it as root would create files your user account cannot update later" \
      "  and would give the streaming server far more rights than it needs." \
      "  Run it again as your normal user, without sudo." >&2
    exit 1
  fi
}

setup_paths() {
  if [ -n "${SWARMCAST_HOME:-}" ]; then
    DATA_DIR="$SWARMCAST_HOME"
    case "$DATA_DIR" in /*) ;; *) DATA_DIR="$PWD/$DATA_DIR" ;; esac
    export SWARMCAST_DATA_DIR="$DATA_DIR"
  else
    DATA_DIR="$HOME/Library/Application Support/SwarmCast"
  fi
  RELEASE_URL="${SWARMCAST_RELEASE_URL:-$SC_DEFAULT_RELEASE_URL}"
  RELEASE_URL="${RELEASE_URL%/}"
  APP_DIR="$DATA_DIR/app"
  CURRENT_DIR="$APP_DIR/current"
  PREVIOUS_DIR="$APP_DIR/previous"

  if ! (umask 077 && mkdir -p "$DATA_DIR/logs" "$APP_DIR"); then
    die "Could not create the SwarmCast folder: $DATA_DIR
  Check that you have write access to it (or set SWARMCAST_HOME to another folder)."
  fi
  LOG_FILE="$DATA_DIR/logs/install.log"
  if ! : >>"$LOG_FILE" 2>/dev/null; then
    LOG_FILE=""
    die "Cannot write the setup log in $DATA_DIR/logs. Check the folder permissions."
  fi

  local base="${TMPDIR:-/tmp}"
  base="${base%/}"
  TMP_DIR="$(mktemp -d "$base/swarmcast.XXXXXX")" || die "Could not create a temporary folder in $base."
}

# Repairs what an interrupted earlier run may have left behind.
recover_previous_run() {
  local d
  for d in "$APP_DIR"/.staging-*; do
    [ -d "$d" ] || continue
    log_to_file "Removing leftover staging folder $d"
    rm -rf "$d"
  done
  if [ ! -d "$CURRENT_DIR" ] && [ -d "$PREVIOUS_DIR" ]; then
    warn "An earlier update was interrupted; restoring the previous version."
    mv "$PREVIOUS_DIR" "$CURRENT_DIR" || die "Could not restore $PREVIOUS_DIR. Delete $APP_DIR and run this again."
  fi
}

check_os() {
  local ver major
  ver="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
  major="${ver%%.*}"
  OS_DESC="macOS $ver"
  case "$major" in
    '' | *[!0-9]*) OS_STATUS="warn"; OS_NOTE="could not read the macOS version" ;;
    *)
      if [ "$major" -ge 12 ]; then
        OS_STATUS="ok"; OS_NOTE=""
      else
        OS_STATUS="bad"; OS_NOTE="macOS 12 or newer is required"
        add_below "macOS $ver (macOS 12 or newer is required)" os
      fi
      ;;
  esac
}

check_arch() {
  local m
  m="$(uname -m)"
  ARCH_NOTE=""
  case "$m" in
    arm64) ARCH="arm64" ;;
    x86_64)
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
        ARCH="arm64"; ARCH_NOTE="Terminal runs under Rosetta; using the native Apple Silicon build"
      else
        ARCH="x64"
      fi
      ;;
    *) die "Unsupported processor architecture: $m. SwarmCast supports Apple Silicon (arm64) and Intel (x64) Macs." ;;
  esac
}

check_memory() {
  local bytes
  bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  RAM_MB=$((bytes / 1048576))
}

check_cpu() {
  CPU_CORES="$(sysctl -n hw.logicalcpu 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"
}

check_disk() {
  DISK_KB="$(df -Pk "$DATA_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  case "$DISK_KB" in '' | *[!0-9]*) DISK_KB=0 ;; esac
}

port_busy() {
  ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) 2>/dev/null && return 0
  if command -v lsof >/dev/null 2>&1; then
    [ -n "$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null)" ] && return 0
  fi
  return 1
}

port_owner() {
  local pid name
  command -v lsof >/dev/null 2>&1 || return 0
  pid="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1)"
  [ -n "$pid" ] || return 0
  name="$(ps -p "$pid" -o comm= 2>/dev/null)"
  name="${name##*/}"
  printf '%s (PID %s)' "${name:-unknown}" "$pid"
}

check_ports() {
  local p owner
  PORTS_BUSY=""
  PORTS_DETAIL=""
  for p in $SC_PORTS; do
    if port_busy "$p"; then
      owner="$(port_owner "$p")"
      PORTS_BUSY="$PORTS_BUSY $p"
      if [ -n "$PORTS_DETAIL" ]; then PORTS_DETAIL="$PORTS_DETAIL
"; fi
      PORTS_DETAIL="${PORTS_DETAIL}      port $p is used by ${owner:-another program}"
    fi
  done
  PORTS_BUSY="${PORTS_BUSY# }"
}

check_obs() {
  OBS_FOUND=""
  local p
  for p in "/Applications/OBS.app" "$HOME/Applications/OBS.app"; do
    if [ -d "$p" ]; then OBS_FOUND="$p"; break; fi
  done
}

# Folder of this script when it runs from a file; empty for curl | bash.
find_script_dir() {
  local src="${BASH_SOURCE[0]:-}"
  case "$src" in */start-* | start-*) ;; *) return 0 ;; esac
  [ -f "$src" ] || return 0
  (cd "$(dirname "$src")" 2>/dev/null && pwd -P)
}

# A local bundle is SHA256SUMS.txt plus this platform's package next to the
# script (the extracted installer zip). Sets PKG_* and LOCAL_DIR.
find_local_bundle() {
  LOCAL_DIR=""
  [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/SHA256SUMS.txt" ] || return 1
  if ! parse_sums "$SCRIPT_DIR/SHA256SUMS.txt"; then
    say "Note: $SCRIPT_DIR/SHA256SUMS.txt lists no SwarmCast package for $SC_OS-$ARCH; ignoring the local files."
    return 1
  fi
  if [ ! -f "$SCRIPT_DIR/$PKG_NAME" ]; then
    say "Note: $PKG_NAME (listed in SHA256SUMS.txt) is not next to this script; ignoring the local files."
    PKG_NAME=""; PKG_SHA=""; PKG_VERSION=""
    return 1
  fi
  LOCAL_DIR="$SCRIPT_DIR"
  LOCAL_NAME="$PKG_NAME"; LOCAL_SHA="$PKG_SHA"; LOCAL_VERSION="$PKG_VERSION"
}

# With a local bundle, look once (no retries) at the default release URL for a
# newer version. Not reaching it (offline, or an HTTP 404/401 answer) is fine:
# the local bundle is used.
check_online_newer() {
  local sums="$TMP_DIR/online-SHA256SUMS.txt"
  ONLINE_STATE="unreachable"
  if fetch_small "$SC_DEFAULT_RELEASE_URL/SHA256SUMS.txt" "$sums"; then
    ONLINE_STATE="same"
    if parse_sums "$sums" && ver_gt "$PKG_VERSION" "$LOCAL_VERSION"; then
      ONLINE_STATE="newer"
      SOURCE="online"
      RELEASE_URL="$SC_DEFAULT_RELEASE_URL"
      SUMS_FILE="$sums"
      say "A newer version v$PKG_VERSION is available online ($RELEASE_URL); using it instead of the local bundle v$LOCAL_VERSION."
      return 0
    fi
  elif [ -n "$FETCH_HTTP" ]; then
    log_to_file "Online release check: HTTP $FETCH_HTTP; using the local bundle"
  fi
  PKG_NAME="$LOCAL_NAME"; PKG_SHA="$LOCAL_SHA"; PKG_VERSION="$LOCAL_VERSION"
}

check_network() {
  RELEASE_OK=0
  PKG_NAME=""; PKG_SHA=""; PKG_VERSION=""
  ONLINE_STATE=""
  SUMS_FILE="$TMP_DIR/SHA256SUMS.txt"

  if [ -z "${SWARMCAST_RELEASE_URL:-}" ] && find_local_bundle; then
    SOURCE="local"
    RELEASE_OK=1
    SUMS_FILE="$LOCAL_DIR/SHA256SUMS.txt"
    say "Install source: local bundle in $LOCAL_DIR (v$LOCAL_VERSION)"
    if check_github_once; then GITHUB_OK=1; else GITHUB_OK=0; fi
    check_online_newer
    return 0
  fi

  SOURCE="online"
  if [ -n "${SWARMCAST_RELEASE_URL:-}" ]; then
    say "Install source: $RELEASE_URL (from SWARMCAST_RELEASE_URL)"
  else
    say "Install source: $RELEASE_URL"
  fi
  if with_retry "Connecting to github.com" check_github_once; then GITHUB_OK=1; else GITHUB_OK=0; fi
  if with_retry "Downloading the release checksum list" fetch_small "$RELEASE_URL/SHA256SUMS.txt" "$SUMS_FILE"; then
    RELEASE_OK=1
    parse_sums "$SUMS_FILE"
  fi
}

# Finds this platform's package in a GNU-format SHA256SUMS file.
parse_sums() {
  local re line hash name
  re="^SwarmCast-v([0-9]+\.[0-9]+\.[0-9]+)-${SC_OS}-${ARCH}\.tar\.gz$"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    hash="${line%% *}"
    name="${line#* }"
    name="${name# }"
    name="${name#\*}"
    [[ $hash =~ ^[0-9a-fA-F]{64}$ ]] || continue
    if [[ $name =~ $re ]]; then
      PKG_VERSION="${BASH_REMATCH[1]}"
      PKG_NAME="$name"
      PKG_SHA="$(printf '%s' "$hash" | tr 'A-F' 'a-f')"
      log_to_file "Latest release: $PKG_NAME ($PKG_SHA)"
      return 0
    fi
  done <"$1"
  log_to_file "No package for $SC_OS-$ARCH in SHA256SUMS.txt"
  return 1
}

system_check() {
  heading "Checking your computer"
  check_os
  check_arch
  check_memory
  check_cpu
  check_disk
  check_ports
  check_obs
  say "Checking the connection to github.com and to the release server..."
  check_network
}

speed_down_once() {
  SPEED_BPS="$(curl -fsS -o /dev/null --connect-timeout 10 --max-time 60 -w '%{speed_download}' "$SC_SPEED_DOWN_URL" 2>>"$LOG_FILE")" || return 1
  num_ge "$SPEED_BPS" 1
}

speed_up_once() {
  SPEED_BPS="$(curl -fsS -o /dev/null --connect-timeout 10 --max-time 60 -w '%{speed_upload}' \
    -H 'Content-Type: application/octet-stream' --data-binary @"$TMP_DIR/upload.bin" "$SC_SPEED_UP_URL" 2>>"$LOG_FILE")" || return 1
  num_ge "$SPEED_BPS" 1
}

speed_test() {
  DOWN_MBPS=""
  UP_MBPS=""
  if [ "$OPT_SKIP_SPEED" = 1 ]; then
    say "Speed test skipped (--skip-speedtest)."
    return 0
  fi
  heading "Measuring your internet speed"
  say "Downloading ~10 MB and uploading ~3 MB to speed.cloudflare.com..."
  if with_retry "Download speed test" speed_down_once; then
    DOWN_MBPS="$(mbps_of_bps "$SPEED_BPS")"
  fi
  head -c 3000000 /dev/zero >"$TMP_DIR/upload.bin"
  if with_retry "Upload speed test" speed_up_once; then
    UP_MBPS="$(mbps_of_bps "$SPEED_BPS")"
  fi
  rm -f "$TMP_DIR/upload.bin"
}

sym_for() {
  case "$1" in ok) printf '%s' "$SYM_OK" ;; warn) printf '%s' "$SYM_WARN" ;; *) printf '%s' "$SYM_BAD" ;; esac
}

plain_sym() {
  case "$1" in ok) printf '✓' ;; warn) printf '⚠' ;; *) printf '✗' ;; esac
}

# row STATUS LABEL VALUE MINIMUM RECOMMENDED [ID [DETAIL]] (ID: also saved to system-check.json)
row() {
  local line
  line="$(printf '%-20s %-26s %-10s %s' "$2" "$3" "$4" "$5")"
  line="${line%"${line##*[! ]}"}"
  printf '  %s %s\n' "$(sym_for "$1")" "$line"
  log_to_file "$(plain_sym "$1") $line"
  if [ -n "${6:-}" ]; then check_result "$6" "$1" "$3" "$4" "$5" "${7:-}"; fi
}

# level VALUE MIN REC -> ok | warn | bad
level() {
  if num_ge "$1" "$3"; then echo ok; elif num_ge "$1" "$2"; then echo warn; else echo bad; fi
}

report_and_confirm() {
  local st v
  heading "Report"
  printf '    %-20s %-26s %-10s %s\n' "Check" "This computer" "Minimum" "Recommended"
  log_to_file "$(printf '  %-20s %-26s %-10s %s' "Check" "This computer" "Minimum" "Recommended")"

  row "$OS_STATUS" "Operating system" "$OS_DESC ($ARCH)" "macOS 12" "" os "$OS_NOTE"
  [ -n "$OS_NOTE" ] && say "      $OS_NOTE"
  [ -n "$ARCH_NOTE" ] && say "      $ARCH_NOTE"

  st="$(level "$RAM_MB" "$SC_MIN_RAM_MB" "$SC_REC_RAM_MB")"
  row "$st" "Memory (RAM)" "$(gb_of_mb "$RAM_MB")" "4 GB" "8 GB" ram
  [ "$st" = bad ] && add_below "memory $(gb_of_mb "$RAM_MB") (minimum 4 GB)" ram

  st="$(level "$CPU_CORES" "$SC_MIN_CORES" "$SC_REC_CORES")"
  row "$st" "CPU cores" "$CPU_CORES" "2" "4" cpu
  [ "$st" = bad ] && add_below "$CPU_CORES CPU cores (minimum 2)" cpu

  if [ -n "$UP_MBPS" ]; then
    st="$(level "$UP_MBPS" "$SC_MIN_UP_MBPS" "$SC_REC_UP_MBPS")"
    row "$st" "Upload speed" "$UP_MBPS Mbps" "10 Mbps" "50 Mbps" upload
    [ "$st" = bad ] && add_below "upload speed $UP_MBPS Mbps (minimum 10 Mbps)" upload
  elif [ "$OPT_SKIP_SPEED" = 1 ]; then
    row warn "Upload speed" "not measured (skipped)" "10 Mbps" "50 Mbps" upload
  else
    row warn "Upload speed" "speed test failed" "10 Mbps" "50 Mbps" upload
  fi
  if [ -n "$DOWN_MBPS" ]; then
    row ok "Download speed" "$DOWN_MBPS Mbps" "-" "-" download
  elif [ "$OPT_SKIP_SPEED" = 1 ]; then
    check_result download skipped "not measured (skipped)" "" ""
  else
    check_result download warn "speed test failed" "" ""
  fi

  if [ "$DISK_KB" -ge "$SC_MIN_DISK_KB" ]; then st=ok; else st=bad; add_below "free disk space $(size_of_kb "$DISK_KB") (minimum 500 MB)" disk; fi
  row "$st" "Free disk space" "$(size_of_kb "$DISK_KB")" "500 MB" "" disk

  if [ -z "$PORTS_BUSY" ]; then
    row ok "Ports 1935/8080/8081" "free" "" "" ports
  else
    row warn "Ports 1935/8080/8081" "in use: $PORTS_BUSY" "" "" ports "$(printf '%s' "$PORTS_DETAIL" | tr '\n' ';' | sed 's/^ *//; s/; */; /g; s/;$//')"
    say "$PORTS_DETAIL"
    say "      Maybe SwarmCast is already running? Otherwise close the program using the port."
  fi

  if [ -n "$OBS_FOUND" ]; then
    row ok "OBS Studio" "installed" "" "" obs
  else
    row warn "OBS Studio" "not found" "" "" obs "Install OBS Studio from https://obsproject.com to stream."
    say "      Install OBS Studio from https://obsproject.com to stream."
  fi

  if [ -n "$LOCAL_DIR" ]; then
    # Installing from the local bundle: being offline is fine.
    if [ "$GITHUB_OK" = 1 ]; then row ok "github.com" "reachable" "" "" github; else row warn "github.com" "unreachable (not needed)" "" "" github; fi
    row ok "Local bundle" "v$LOCAL_VERSION (next to this script)" "" "" release
    case "$ONLINE_STATE" in
      newer) row ok "Online release" "newer v$PKG_VERSION available" "" "" ;;
      same) row ok "Online release" "nothing newer" "" "" ;;
      *) row ok "Online release" "not reachable (fine)" "" "" ;;
    esac
  else
    if [ "$GITHUB_OK" = 1 ]; then row ok "github.com" "reachable" "" "" github; else row bad "github.com" "unreachable" "" "" github; fi
    if [ "$RELEASE_OK" = 1 ] && [ -n "$PKG_VERSION" ]; then
      row ok "Release server" "reachable (latest v$PKG_VERSION)" "" "" release
    elif [ "$RELEASE_OK" = 1 ]; then
      row bad "Release server" "no package for $SC_OS-$ARCH" "" "" release
    elif [ -n "$FETCH_HTTP" ]; then
      row bad "Release server" "HTTP $FETCH_HTTP" "" "" release
    else
      row bad "Release server" "unreachable" "" "" release
    fi
  fi

  if [ -n "$UP_MBPS" ]; then
    v="$(awk -v u="$UP_MBPS" 'BEGIN { x = u * 0.75 - 6; if (x < 0) x = 0; printf "%d", x / (6 * 1.15) }')"
    VIEWER_EST="$v"
    say ""
    say "Estimated viewers served directly from this computer: $v"
    say "(Assumes a 6 Mbps stream that is also sent to another platform at the same time.)"
  fi

  # Test hook (installer tests only): pretend one check is below the minimum.
  if [ -n "${SWARMCAST_TEST_BELOW:-}" ]; then add_below "$SWARMCAST_TEST_BELOW" ram; fi
  write_system_check
  if [ -n "$BELOW" ]; then
    say ""
    if [ "$OPT_ASK" = 1 ]; then
      if ! confirm "Your computer/internet is below the recommended minimum: $BELOW. Continue anyway?" n; then
        die "Setup cancelled."
      fi
    else
      warn "Your computer/internet is below the recommended minimum: $BELOW."
      warn "Continuing anyway: SwarmCast may stutter or serve fewer viewers on this computer. (Run with --ask to be asked first.)"
    fi
  fi
}

install_or_update() {
  local installed=""
  heading "Installing / updating SwarmCast"
  if [ -f "$CURRENT_DIR/VERSION" ]; then
    installed="$(trim "$(cat "$CURRENT_DIR/VERSION" 2>/dev/null)")"
  fi
  if [ ! -x "$CURRENT_DIR/swarmcast" ]; then
    installed=""
  fi

  if [ "$RELEASE_OK" != 1 ]; then
    local why="offline, or the release server is unreachable"
    if [ -n "$FETCH_HTTP" ]; then
      why="the release server answered HTTP $FETCH_HTTP"
    fi
    if [ -n "$installed" ]; then
      warn "Could not check for updates ($why: $RELEASE_URL)."
      warn "Starting the installed version v$installed."
      return 0
    fi
    if [ -n "$FETCH_HTTP" ]; then
      die "Could not download SwarmCast: the release server answered HTTP $FETCH_HTTP.
  ($RELEASE_URL/SHA256SUMS.txt)
  If you have the SwarmCast installer zip, extract it and run $SC_SCRIPT_NAME
  from the extracted folder. Or get the SwarmCast app: https://lucas-angelo.github.io/swarmcast/"
    fi
    die "Could not download SwarmCast: the release server is unreachable.
  ($RELEASE_URL/SHA256SUMS.txt)
  Check your internet connection (and any firewall, proxy or VPN), then run this again.
  If you received the SwarmCast installer zip, extract it and run $SC_SCRIPT_NAME
  from the extracted folder."
  fi

  if [ -z "$PKG_NAME" ]; then
    if [ -n "$installed" ]; then
      warn "The latest release has no package for $SC_OS-$ARCH. Starting the installed version v$installed."
      return 0
    fi
    die "The latest release has no SwarmCast package for your system ($SC_OS-$ARCH).
  See $SC_ISSUES_URL"
  fi

  if [ "$installed" = "$PKG_VERSION" ]; then
    ok "Already up to date (v$installed)"
    return 0
  fi
  if [ "$SOURCE" = local ] && [ -n "$installed" ] && ver_gt "$installed" "$PKG_VERSION"; then
    ok "Already up to date (v$installed; the local bundle has the older v$PKG_VERSION, so it is not used)"
    return 0
  fi

  if [ -n "$installed" ]; then
    say "Updating SwarmCast v$installed -> v$PKG_VERSION"
  else
    say "Installing SwarmCast v$PKG_VERSION"
  fi
  download_and_install "$installed"
}

download_and_install() {
  local installed="$1" pkg actual f out kept
  if [ -n "$installed" ]; then kept="Your installed version v$installed was not changed."; else kept="Nothing was installed."; fi

  if [ "$SOURCE" = local ]; then
    pkg="$LOCAL_DIR/$PKG_NAME"
    say "Using $PKG_NAME from the local bundle (no download)."
  else
    pkg="$TMP_DIR/$PKG_NAME"
    say "Downloading $PKG_NAME..."
    if ! with_retry "Download" download_file "$RELEASE_URL/$PKG_NAME" "$pkg"; then
      rm -f "$pkg"
      die "Could not download $RELEASE_URL/$PKG_NAME.
  Check your internet connection and run this again. $kept"
    fi
  fi

  say "Verifying the SHA-256 checksum..."
  actual="$(sha256_of "$pkg")"
  if [ "$actual" != "$PKG_SHA" ]; then
    if [ "$SOURCE" = local ]; then
      # Never delete the user's own files: just refuse to use them.
      die "Checksum mismatch for $PKG_NAME in $LOCAL_DIR: the file is corrupted or was tampered with.
  expected: $PKG_SHA (from SHA256SUMS.txt)
  got:      $actual
  $kept
  Get a fresh copy of the installer zip, extract it again and run the script from there."
    fi
    rm -f "$pkg"
    die "Checksum mismatch for $PKG_NAME: the download is corrupted or was tampered with.
  expected: $PKG_SHA
  got:      $actual
  The download was deleted. $kept
  Try again later; if it keeps happening, report it at $SC_ISSUES_URL"
  fi
  ok "Checksum OK"
  if [ "$SOURCE" = local ]; then
    # Verified: drop the "downloaded from the internet" mark the browser put on it.
    xattr -d com.apple.quarantine "$pkg" 2>/dev/null || true
  fi

  STAGING_DIR="$(mktemp -d "$APP_DIR/.staging-XXXXXX")" || die "Could not create a folder in $APP_DIR. $kept"
  if ! retry_step "Unpacking $PKG_NAME" extract_pkg "$pkg"; then
    die "Could not unpack $PKG_NAME, even after several tries. Check that the disk is not full, then run this again. $kept"
  fi
  if [ "$SOURCE" != local ]; then rm -f "$pkg"; fi

  for f in swarmcast VERSION bin/mediamtx bin/cloudflared; do
    if [ ! -f "$STAGING_DIR/$f" ]; then
      die "The downloaded package is incomplete ($f is missing). $kept
  Report it at $SC_ISSUES_URL"
    fi
  done

  # Only the verified files: they came from the checksum-checked archive.
  xattr -dr com.apple.quarantine "$STAGING_DIR" 2>/dev/null || true
  chmod +x "$STAGING_DIR/swarmcast"
  for f in "$STAGING_DIR"/bin/*; do
    [ -f "$f" ] && chmod +x "$f"
  done

  if [ "$(trim "$(cat "$STAGING_DIR/VERSION")")" != "$PKG_VERSION" ]; then
    die "The downloaded package has the wrong VERSION file (expected $PKG_VERSION). $kept"
  fi

  say "Checking the new version..."
  NEW_VERSION_OUT=""
  retry_step "Checking the new version" check_new_version
  out="$NEW_VERSION_OUT"
  if [ "$out" != "$PKG_VERSION" ]; then
    die "The new version did not start correctly (\"swarmcast --version\" printed \"$out\", expected \"$PKG_VERSION\"). $kept
  Report it at $SC_ISSUES_URL"
  fi

  # Swap: current -> previous, staging -> current (renames in the same folder).
  if [ -d "$CURRENT_DIR" ]; then
    retry_step "Removing the old backup" rm -rf "$PREVIOUS_DIR" || die "Could not remove the old backup $PREVIOUS_DIR. $kept"
    retry_step "Moving the installed version aside" mv "$CURRENT_DIR" "$PREVIOUS_DIR" || die "Could not move the installed version aside. $kept"
    JUST_UPDATED=1
  fi
  if ! retry_step "Moving the new version into place" mv "$STAGING_DIR" "$CURRENT_DIR"; then
    if [ ! -d "$CURRENT_DIR" ] && [ -d "$PREVIOUS_DIR" ]; then
      mv "$PREVIOUS_DIR" "$CURRENT_DIR"
    fi
    die "Could not move the new version into place. $kept"
  fi
  STAGING_DIR=""

  ok "Installed SwarmCast v$PKG_VERSION in $CURRENT_DIR"
  if [ -n "$installed" ]; then
    say "  The previous version v$installed is kept in $PREVIOUS_DIR (for rollback)."
  fi
}

# ---------------------------------------------------------------------------
# Video converter (ffmpeg) for the extra qualities
# ---------------------------------------------------------------------------
# SwarmCast does not ship ffmpeg: this computer downloads the build pinned in the
# release's binaries.json straight from its publisher, checks its SHA-256 and keeps
# it in $DATA_DIR/tools/ffmpeg (outside app/, so updates do not download it again;
# a new download happens only when the pin changes). Any problem here only skips
# ffmpeg: SwarmCast works without it (viewers get the original quality only).

# sums_hash NAME SUMSFILE -> the SHA-256 listed for NAME (empty when absent)
sums_hash() {
  local line hash name
  [ -f "$2" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    hash="${line%% *}"
    name="${line#* }"
    name="${name# }"
    name="${name#\*}"
    if [ "$name" = "$1" ] && [[ $hash =~ ^[0-9a-fA-F]{64}$ ]]; then
      printf '%s' "$hash" | tr 'A-F' 'a-f'
      return 0
    fi
  done <"$2"
}

# Finds a verified binaries.json (local bundle or release server). Sets BIN_JSON,
# or FF_WHY with the reason and returns 1.
get_binaries_json() {
  local want actual src
  BIN_JSON=""
  FF_WHY=""
  if [ "$SOURCE" = local ] && [ -n "$LOCAL_DIR" ]; then
    src="$LOCAL_DIR/binaries.json"
    want="$(sums_hash binaries.json "$LOCAL_DIR/SHA256SUMS.txt")"
    if [ ! -f "$src" ] || [ -z "$want" ]; then
      FF_WHY="the installer folder has no binaries.json (older installer zip)"
      return 1
    fi
  else
    if [ "$RELEASE_OK" != 1 ]; then
      FF_WHY="the release server could not be reached (offline?)"
      return 1
    fi
    want="$(sums_hash binaries.json "$SUMS_FILE")"
    if [ -z "$want" ]; then
      FF_WHY="this release does not list binaries.json"
      return 1
    fi
    src="$TMP_DIR/binaries.json"
    if ! fetch_small "$RELEASE_URL/binaries.json" "$src"; then
      FF_WHY="could not download $RELEASE_URL/binaries.json"
      return 1
    fi
  fi
  actual="$(sha256_of "$src")"
  if [ "$actual" != "$want" ]; then
    FF_WHY="binaries.json does not match its checksum in SHA256SUMS.txt"
    return 1
  fi
  BIN_JSON="$src"
}

# json_field FIELD TEXT -> value of "FIELD": "..." in a one-line JSON object
json_field() {
  printf '%s' "$2" | sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p"
}

ffmpeg_skip_note() {
  say "  SwarmCast still works without it: viewers get your original quality."
  say "  Install it later from the panel (Quality for viewers -> Install the video converter),"
  say "  or run this script again when you are online."
}

# Download + SHA-256 check as one retried unit (a truncated download fails the check).
ff_fetch_verified() {
  local got
  FF_GOT=""
  download_file "$1" "$2" || return 1
  got="$(sha256_of "$2")"
  if [ "$got" != "$3" ]; then
    FF_GOT="$got"
    log_to_file "ffmpeg checksum mismatch: expected $3, got $got"
    rm -f "$2"
    return 1
  fi
}

ff_extract() {
  rm -rf "$2" && mkdir -p "$2" || return 1
  if test_fail_once ffmpeg-extract; then return 1; fi
  tar -xf "$1" -C "$2" 2>>"$LOG_FILE"
}

ff_copy() { cp "$1" "$2" && chmod 755 "$2"; }

ff_write() { printf '%s\n' "$2" >"$1"; }

install_ffmpeg() {
  local dir="$DATA_DIR/tools/ffmpeg" target="$SC_OS-$ARCH" line version url sha binary asset license stamp archive ex found actual
  heading "Video converter (ffmpeg)"
  if [ "$OPT_NO_FFMPEG" = 1 ]; then
    say "Skipped (--no-ffmpeg). Viewers get your original quality only; you can install it later from the panel."
    return 0
  fi
  if ! get_binaries_json; then
    if [ -x "$dir/ffmpeg" ]; then
      ok "Video converter already installed ($dir/ffmpeg); could not check for a newer pin: $FF_WHY."
    else
      warn "Skipping the video converter: $FF_WHY."
      ffmpeg_skip_note
    fi
    return 0
  fi
  line="$(awk -v t="\"$target\":" 'index($0, "\"ffmpeg\": {") { f = 1 } f && index($0, t) { print; exit }' "$BIN_JSON")"
  version="$(awk 'index($0, "\"ffmpeg\": {") { f = 1 } f && /"version":/ { print; exit }' "$BIN_JSON" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')"
  url="$(json_field url "$line")"
  sha="$(json_field sha256 "$line" | tr 'A-F' 'a-f')"
  binary="$(json_field binary "$line")"
  asset="$(json_field asset "$line")"
  license="$(json_field license "$line")"
  if [ -z "$line" ]; then
    warn "Skipping the video converter: no ffmpeg build is pinned for $target."
    ffmpeg_skip_note
    return 0
  fi
  case "$url" in https://* | http://127.0.0.1:* | http://127.0.0.1/*) ;; *) url="" ;; esac
  if [ -z "$url" ] || ! [[ $sha =~ ^[0-9a-f]{64}$ ]] || [ "$binary" != ffmpeg ] || [ -z "$version" ]; then
    warn "Skipping the video converter: the ffmpeg entry in binaries.json is not valid."
    ffmpeg_skip_note
    return 0
  fi
  stamp="$version $sha"
  if [ -x "$dir/ffmpeg" ] && [ "$(trim "$(cat "$dir/PIN" 2>/dev/null)")" = "$(trim "$stamp")" ]; then
    ok "Video converter (ffmpeg $version) already installed"
    return 0
  fi
  if [ "$SC_OS" = linux ] && [ "${asset%.tar.xz}" != "$asset" ] && ! command -v xz >/dev/null 2>&1; then
    warn "Skipping the video converter: unpacking it needs xz (sudo apt-get install xz-utils)."
    ffmpeg_skip_note
    return 0
  fi
  say "Downloading ffmpeg $version for $target from its publisher (SwarmCast does not redistribute it):"
  say "  $url"
  archive="$TMP_DIR/ffmpeg-${asset:-download}"
  FF_GOT=""
  if ! retry_step "ffmpeg download" ff_fetch_verified "$url" "$archive" "$sha"; then
    rm -f "$archive"
    if [ -n "$FF_GOT" ]; then
      warn "Skipping the video converter: checksum mismatch for the ffmpeg download (expected $sha, got $FF_GOT). It was deleted and not installed."
    else
      warn "Skipping the video converter: the download failed (offline, or the publisher is unreachable)."
    fi
    ffmpeg_skip_note
    return 0
  fi
  ok "ffmpeg checksum OK"
  ex="$TMP_DIR/ffmpeg-x"
  if ! retry_step "Unpacking ffmpeg" ff_extract "$archive" "$ex"; then
    rm -rf "$archive" "$ex"
    warn "Skipping the video converter: could not unpack the ffmpeg download."
    ffmpeg_skip_note
    return 0
  fi
  found="$(find "$ex" -type f -name ffmpeg 2>/dev/null | head -n 1)"
  if [ -z "$found" ] || ! (umask 077 && mkdir -p "$dir"); then
    rm -rf "$archive" "$ex"
    warn "Skipping the video converter: ffmpeg was not found in the download, or $dir could not be created."
    ffmpeg_skip_note
    return 0
  fi
  if ! retry_step "Copying ffmpeg" ff_copy "$found" "$dir/ffmpeg.new"; then
    rm -rf "$archive" "$ex" "$dir/ffmpeg.new"
    warn "Skipping the video converter: could not write $dir."
    ffmpeg_skip_note
    return 0
  fi
  rm -rf "$archive" "$ex"
  if [ "$SC_OS" = macos ]; then xattr -d com.apple.quarantine "$dir/ffmpeg.new" 2>/dev/null || true; fi
  if ! run_with_timeout 30 "$TMP_DIR/ffmpeg-version.out" "$dir/ffmpeg.new" -hide_banner -version || ! grep -qi 'ffmpeg version' "$TMP_DIR/ffmpeg-version.out"; then
    rm -f "$dir/ffmpeg.new"
    warn "Skipping the video converter: the downloaded ffmpeg does not run on this computer."
    ffmpeg_skip_note
    return 0
  fi
  if ! retry_step "Installing ffmpeg" mv -f "$dir/ffmpeg.new" "$dir/ffmpeg"; then
    rm -f "$dir/ffmpeg.new"
    warn "Skipping the video converter: could not write $dir/ffmpeg."
    ffmpeg_skip_note
    return 0
  fi
  retry_step "Writing $dir/PIN" ff_write "$dir/PIN" "$stamp" || warn "Could not write $dir/PIN (ffmpeg will be downloaded again next time)."
  printf '%s\nsha256 %s\nlicense %s\nDownloaded from its publisher on this computer by %s; SwarmCast does not redistribute ffmpeg.\n' \
    "$url" "$sha" "$license" "$SC_SCRIPT_NAME" >"$dir/SOURCE.txt"
  ok "Installed ffmpeg $version in $dir (license: ${license:-see SOURCE.txt})"
}

# Unpacks the package into a clean staging folder (retried by the caller).
extract_pkg() {
  rm -rf "$STAGING_DIR" && mkdir -p "$STAGING_DIR" || return 1
  if test_fail_once extract; then return 1; fi
  tar -xzf "$1" -C "$STAGING_DIR" 2>>"$LOG_FILE"
}

# Runs the new binary with --version; NEW_VERSION_OUT gets what it printed.
check_new_version() {
  NEW_VERSION_OUT=""
  if run_with_timeout 30 "$TMP_DIR/version.out" "$STAGING_DIR/swarmcast" --version; then
    NEW_VERSION_OUT="$(trim "$(tr -d '\r' <"$TMP_DIR/version.out" | awk 'NF { l = $0 } END { print l }')")"
  fi
  log_to_file "New binary reports version: ${NEW_VERSION_OUT:-<nothing>}"
  [ "$NEW_VERSION_OUT" = "$PKG_VERSION" ]
}

run_smoke_test() {
  local rc line
  heading "Smoke test"
  say "Running \"swarmcast --smoke-test\" (starts everything without the tunnel, verifies, stops)..."
  "$CURRENT_DIR/swarmcast" --smoke-test </dev/null 2>&1 | while IFS= read -r line || [ -n "$line" ]; do
    printf '  %s\n' "$line"
    log_to_file "[swarmcast] $line"
  done
  rc="${PIPESTATUS[0]}"
  if [ "$rc" = 0 ]; then
    ok "Smoke test passed."
  else
    err "Smoke test failed (exit code $rc). See $LOG_FILE and the logs in $DATA_DIR/logs."
  fi
  log_to_file "Exiting with code $rc"
  exit "$rc"
}

# exec_app BIN ARGS...: replaces this script with SwarmCast (same process), so Ctrl+C, closing
# the window or killing the launcher reach the app directly; it stops everything by itself.
exec_app() {
  local bin="$1"
  shift
  if [ ! -t 0 ] && ( : </dev/tty ) 2>/dev/null; then
    exec "$bin" ${1+"$@"} </dev/tty
  fi
  exec "$bin" ${1+"$@"}
}

# The new version replaced a working one but does not start: put the previous one back.
rollback() {
  local bad="" good=""
  [ -d "$PREVIOUS_DIR" ] || return 1
  bad="$(trim "$(cat "$CURRENT_DIR/VERSION" 2>/dev/null)")"
  good="$(trim "$(cat "$PREVIOUS_DIR/VERSION" 2>/dev/null)")"
  rm -rf "$APP_DIR/failed"
  retry_step "Moving the new version aside" mv "$CURRENT_DIR" "$APP_DIR/failed" || return 1
  if ! retry_step "Restoring the previous version" mv "$PREVIOUS_DIR" "$CURRENT_DIR"; then
    mv "$APP_DIR/failed" "$CURRENT_DIR" 2>/dev/null
    return 1
  fi
  rm -rf "$APP_DIR/failed"
  JUST_UPDATED=0
  warn "The new version v$bad did not start, so SwarmCast went back to v$good, the version you had before."
}

# A freshly updated version must prove it starts (a short self-test without the tunnel)
# before we hand the terminal over to it; transient failures are retried.
self_test_new_version() {
  local bin="$1" delay
  for delay in 0 $SC_STEP_DELAYS; do
    [ "$delay" != 0 ] && { log_to_file "Self-test failed; retrying in ${delay}s"; sleep "$delay"; }
    if "$bin" --smoke-test >>"$LOG_FILE" 2>&1 </dev/null; then
      log_to_file "Self-test of the new version passed"
      return 0
    fi
  done
  return 1
}

start_app() {
  local bin="$CURRENT_DIR/swarmcast"
  local -a app_args
  app_args=()
  if [ "$OPT_NO_TUNNEL" = 1 ]; then app_args+=(--no-tunnel); fi
  [ -x "$bin" ] || die "SwarmCast is not installed correctly ($bin is missing). Run this script again."

  if [ "$JUST_UPDATED" = 1 ]; then
    say "Checking that the new version starts..."
    if ! self_test_new_version "$bin"; then
      if rollback; then
        bin="$CURRENT_DIR/swarmcast"
      else
        STAGING_DIR=""
        die "The new version of SwarmCast could not start, even after several tries.
  Restart your computer and run this again. If it keeps happening, report it at $SC_ISSUES_URL
  and attach $LOG_FILE and the logs in $DATA_DIR/logs."
      fi
    fi
  fi

  heading "Starting SwarmCast"
  say "$SC_OBS_HINT"
  say ""

  trap - EXIT INT TERM HUP
  cleanup
  log_to_file "Starting: $bin ${app_args[*]-}"
  exec_app "$bin" ${app_args[@]+"${app_args[@]}"}
}

main() {
  parse_args "$@"
  init_colors
  if [ "$OPT_HELP" = 1 ]; then
    usage
    exit 0
  fi
  refuse_root
  SCRIPT_DIR="$(find_script_dir)"
  setup_paths
  trap cleanup EXIT
  trap on_signal INT TERM HUP

  log_to_file "==== SwarmCast setup started ($SC_OS_LABEL) args: $* ===="
  say "${C_BOLD}SwarmCast setup for $SC_OS_LABEL${C_RESET}"
  say "Data folder: $DATA_DIR"

  recover_previous_run
  system_check
  speed_test
  report_and_confirm
  install_or_update
  install_ffmpeg

  if [ "$OPT_SMOKE" = 1 ]; then
    run_smoke_test
  fi
  if [ "$OPT_INSTALL_ONLY" = 1 ]; then
    ok "Done (--install-only). Start SwarmCast later by running this script again."
    log_to_file "Exiting with code 0"
    exit 0
  fi
  start_app
}

main "$@"; exit $?
