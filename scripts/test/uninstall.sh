#!/usr/bin/env bash
# Tests for scripts/uninstall-macos.command and scripts/uninstall-linux.sh.
# Needs bash, node and tar; a C compiler (cc) or a copyable `sleep` for the
# running-process cases. Usage: scripts/test/uninstall.sh
set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$ROOT/scripts/test"

case "$(uname -s)" in
  Darwin) OS=macos; SCRIPT="$ROOT/scripts/uninstall-macos.command"; START="$ROOT/scripts/start-macos.command" ;;
  Linux) OS=linux; SCRIPT="$ROOT/scripts/uninstall-linux.sh"; START="$ROOT/scripts/start-linux.sh" ;;
  *) echo "Unsupported OS for this harness: $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64)
    ARCH=x64
    if [ "$OS" = macos ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then ARCH=arm64; fi
    ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarmcast-uninstall-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
DATA="$WORK/swarm home"          # a space on purpose: quoting must hold
OUT=""
PIDS=""                          # every process started by the tests (killed at the end)

PASS=0
FAIL=0
FAILED_NAMES=""
CASE=""
CASE_FAILED=0

finish() {
  local p
  for p in $PIDS; do kill -9 "$p" 2>/dev/null; done
  chmod -R u+rwX "$WORK" 2>/dev/null
  if [ "${KEEP_WORK:-0}" = 1 ]; then echo "Work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap finish EXIT

begin() {
  CASE="$1"
  CASE_FAILED=0
  OUT="$WORK/out-$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_').txt"
  : >"$OUT"
  printf '\n=== %s\n' "$CASE"
}
fail() { printf '  FAIL: %s\n' "$*"; CASE_FAILED=1; }
pass() { printf '  ok: %s\n' "$*"; }
end() {
  if [ "$CASE_FAILED" = 0 ]; then
    PASS=$((PASS + 1))
    printf 'PASS %s\n' "$CASE"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES="$FAILED_NAMES
  - $CASE"
    printf -- '--- output of the script ---\n'
    cat "$OUT" 2>/dev/null
    printf -- '--- end of output ---\n'
    printf 'FAIL %s\n' "$CASE"
  fi
}

assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (expected '$2', got '$1')"; fi; }
assert_file() { if [ -e "$1" ]; then pass "exists: ${1#"$WORK"/}"; else fail "missing: ${1#"$WORK"/}"; fi; }
assert_no_file() { if [ ! -e "$1" ]; then pass "absent: ${1#"$WORK"/}"; else fail "should not exist: ${1#"$WORK"/}"; fi; }
assert_contains() { if grep -qiF -- "$2" "$1"; then pass "${3:-"contains '$2'"}"; else fail "${3:-"contains '$2'"} ('$2' not found)"; fi; }
assert_not_contains() { if ! grep -qiF -- "$2" "$1"; then pass "${3:-"does not contain '$2'"}"; else fail "${3:-"does not contain '$2'"}"; fi; }
assert_alive() { if kill -0 "$1" 2>/dev/null; then pass "$2 is running"; else fail "$2 should still run"; fi; }
assert_dead() { if kill -0 "$1" 2>/dev/null; then fail "$2 is still running"; else pass "$2 was stopped"; fi; }
file_content() { tr -d '\r\n' <"$1" 2>/dev/null; }

# run_uninstall [args...] -> RC, output in $OUT. SWARMCAST_HOME="$DATA".
run_uninstall() {
  env SWARMCAST_HOME="$DATA" NO_COLOR=1 SWARMCAST_STOP_GRACE=2 SWARMCAST_DELETE_DELAYS="1 1" \
    "$SCRIPT" "$@" >"$OUT" 2>&1 </dev/null
  RC=$?
  echo "  (exit code $RC)"
}

# A minimal installed tree like the start script and the app leave behind.
make_tree() {
  rm -rf "$DATA"
  mkdir -p "$DATA/app/current/bin" "$DATA/app/previous" "$DATA/logs" "$DATA/run/icons" "$DATA/blocklists" \
    "$DATA/bin/ffmpeg-7.1" "$DATA/tools" "$DATA/cache"
  printf '0.0.1\n' >"$DATA/app/current/VERSION"
  printf '0.0.0\n' >"$DATA/app/previous/VERSION"
  printf 'fake\n' >"$DATA/app/current/bin/mediamtx"
  printf 'log\n' >"$DATA/logs/install.log"
  printf '{"ports":{"rtmp":1935}}\n' >"$DATA/config.json"
  printf '{"streamKey":"keep-me"}\n' >"$DATA/secrets.json"
  printf '{}\n' >"$DATA/state.json"
  printf '{}\n' >"$DATA/system-check.json"
  printf 'x\n' >"$DATA/blocklists/list.txt"
  printf 'x\n' >"$DATA/.hidden"
}

# A fake `swarmcast` that records how it was called (outside the data folder).
install_recording_swarmcast() {
  cat >"$DATA/app/current/swarmcast" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_CLEANUP_LOG"
printf '%s\n' "SWARMCAST_DATA_DIR=$SWARMCAST_DATA_DIR" >>"$FAKE_CLEANUP_LOG"
echo "fake cleanup output line"
exit "${FAKE_CLEANUP_EXIT:-0}"
EOF
  chmod 755 "$DATA/app/current/swarmcast"
}

# --- a real executable that sleeps (the running-process cases) --------------
SLEEPER="$WORK/sleeper"
if command -v cc >/dev/null 2>&1; then
  printf '#include <stdlib.h>\n#include <unistd.h>\nint main(int c, char **v) { sleep(c > 1 ? atoi(v[1]) : 300); return 0; }\n' >"$WORK/sleeper.c"
  cc -o "$SLEEPER" "$WORK/sleeper.c" 2>/dev/null || rm -f "$SLEEPER"
fi
if [ ! -x "$SLEEPER" ] && [ "$OS" = linux ]; then cp "$(command -v sleep)" "$SLEEPER"; fi

# start_detached PIDFILE command... : started through a subshell so it is not our
# child (no zombie keeps "running" after the uninstaller stops it).
start_detached() {
  local pf="$1"
  shift
  ( "$@" >/dev/null 2>&1 </dev/null & echo $! >"$pf" )
  PIDS="$PIDS $(cat "$pf")"
}

# --- static analysis -------------------------------------------------------
begin "syntax check"
for f in "$ROOT/scripts/uninstall-macos.command" "$ROOT/scripts/uninstall-linux.sh" "$0"; do
  if bash -n "$f"; then pass "bash -n $(basename "$f")"; else fail "bash -n $(basename "$f")"; fi
done
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S warning "$ROOT/scripts/uninstall-macos.command" "$ROOT/scripts/uninstall-linux.sh" "$0" >"$OUT" 2>&1; then pass "shellcheck"; else fail "shellcheck"; fi
else
  echo "  (shellcheck not installed, skipped)"
fi
if cmp -s <(sed -n '/^# ---- shared body/,$p' "$ROOT/scripts/uninstall-macos.command") <(sed -n '/^# ---- shared body/,$p' "$ROOT/scripts/uninstall-linux.sh"); then
  pass "macOS and Linux uninstallers share the same body"
else
  fail "the shared body of uninstall-macos.command and uninstall-linux.sh differs"
fi
for f in "$ROOT/scripts/uninstall-macos.command" "$ROOT/scripts/uninstall-linux.sh"; do
  if [ -x "$f" ]; then pass "$(basename "$f") is executable"; else fail "$(basename "$f") is not executable"; fi
done
end

# --- 1. not installed ------------------------------------------------------
begin "1. nothing installed"
DATA="$WORK/never installed"
run_uninstall
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "not installed"
assert_contains "$OUT" "Your OBS settings were not changed"
assert_no_file "$DATA"
assert_eq "$(find "$WORK" -maxdepth 1 -newer "$OUT" | wc -l | tr -d ' ')" 0 "nothing written next to the data folder"
end

begin "1b. empty data folder is removed and reported as not installed"
mkdir -p "$DATA"
run_uninstall
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "not installed"
assert_no_file "$DATA"
end
DATA="$WORK/swarm home"

# --- 2. real install with the start script, then uninstall -----------------
begin "2. install with the start script (local bundle), then uninstall from the bundle folder"
BUNDLE="$WORK/installer folder"
CLOSED_URL="http://127.0.0.1:$(node "$TEST_DIR/serve.mjs" --free-port)"
node "$TEST_DIR/make-fake-release.mjs" --dir "$BUNDLE" --os "$OS" --arch "$ARCH" --version 0.0.1 >/dev/null ||
  { echo "make-fake-release failed" >&2; exit 2; }
grep "  SwarmCast-v0.0.1-$OS-$ARCH.tar.gz\$" "$BUNDLE/SHA256SUMS.txt" >"$BUNDLE/sums.tmp" && mv "$BUNDLE/sums.tmp" "$BUNDLE/SHA256SUMS.txt"
sed "s|^SC_DEFAULT_RELEASE_URL=.*|SC_DEFAULT_RELEASE_URL=\"$CLOSED_URL\"|" "$START" >"$BUNDLE/$(basename "$START")"
cp "$SCRIPT" "$BUNDLE/"
chmod 755 "$BUNDLE/$(basename "$START")" "$BUNDLE/$(basename "$SCRIPT")"
mkdir -p "$WORK/tmp"
env -u SWARMCAST_RELEASE_URL SWARMCAST_HOME="$DATA" TMPDIR="$WORK/tmp" NO_COLOR=1 \
  "$BUNDLE/$(basename "$START")" --yes --skip-speedtest --install-only >"$OUT" 2>&1 </dev/null
assert_eq "$?" 0 "start script installed v0.0.1"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.1" "current/VERSION is 0.0.1"
printf '{"streamKey":"abc"}\n' >"$DATA/secrets.json"
env SWARMCAST_HOME="$DATA" NO_COLOR=1 "$BUNDLE/$(basename "$SCRIPT")" >"$OUT" 2>&1 </dev/null
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0"
assert_no_file "$DATA"
assert_contains "$OUT" "SwarmCast was removed from this computer"
assert_contains "$OUT" "Your OBS settings were not changed. Remove the SwarmCast target/server from OBS yourself if you want."
assert_contains "$OUT" "started with: --cleanup --data-dir $DATA" "swarmcast --cleanup was run with the data folder"
assert_contains "$OUT" "SwarmCast uninstall finished: removed" "final summary line"
assert_file "$BUNDLE/$(basename "$SCRIPT")"
assert_file "$BUNDLE/SwarmCast-v0.0.1-$OS-$ARCH.tar.gz"
end

# --- 3. --keep-settings ----------------------------------------------------
begin "3. --keep-settings keeps only config.json and secrets.json"
make_tree
cp "$DATA/config.json" "$WORK/config.ref"
cp "$DATA/secrets.json" "$WORK/secrets.ref"
run_uninstall --keep-settings
assert_eq "$RC" 0 "exit code 0"
assert_eq "$(cd "$DATA" && ls -A | sort | tr '\n' ' ')" "config.json secrets.json " "only config.json and secrets.json are left"
if cmp -s "$DATA/config.json" "$WORK/config.ref"; then pass "config.json unchanged"; else fail "config.json changed"; fi
if cmp -s "$DATA/secrets.json" "$WORK/secrets.ref"; then pass "secrets.json unchanged"; else fail "secrets.json changed"; fi
assert_contains "$OUT" "settings and stream key were kept"
end

begin "3b. uninstalling again after --keep-settings removes the rest"
run_uninstall --yes
assert_eq "$RC" 0 "exit code 0 (--yes accepted)"
assert_no_file "$DATA"
end

# --- 4. running processes --------------------------------------------------
begin "4. stops processes running from the data folder, never others"
if [ ! -x "$SLEEPER" ]; then
  echo "  (no C compiler to build a test process, skipped)"
else
  make_tree
  mkdir -p "$WORK/outside/bin"
  # rm first: overwriting a signed binary in place gets it killed on macOS.
  rm -f "$DATA/app/current/bin/mediamtx"
  cp "$SLEEPER" "$DATA/app/current/bin/mediamtx"
  cp "$SLEEPER" "$DATA/app/current/bin/cloudflared"
  cp "$SLEEPER" "$DATA/tools/ffmpeg"
  cp "$SLEEPER" "$WORK/outside/bin/mediamtx"   # same name, outside the data folder
  start_detached "$WORK/p1" "$DATA/app/current/bin/mediamtx" 300
  # Ignores SIGTERM (inherited across exec): must be force-stopped after the grace period.
  start_detached "$WORK/p2" sh -c 'trap "" TERM; exec "$0" 300' "$DATA/app/current/bin/cloudflared"
  # Started with a relative path (macOS: resolved with lsof).
  ( cd "$DATA/tools" || exit 1; ./ffmpeg 300 >/dev/null 2>&1 </dev/null & echo $! >"$WORK/p3" )
  PIDS="$PIDS $(cat "$WORK/p3")"
  start_detached "$WORK/p4" "$WORK/outside/bin/mediamtx" 300
  sleep 0.5
  assert_alive "$(cat "$WORK/p1")" "mediamtx (inside)"
  assert_alive "$(cat "$WORK/p2")" "cloudflared ignoring SIGTERM (inside)"
  run_uninstall
  assert_eq "$RC" 0 "exit code 0"
  assert_contains "$OUT" "Stopping SwarmCast"
  assert_contains "$OUT" "mediamtx (PID $(cat "$WORK/p1"))"
  assert_contains "$OUT" "ffmpeg (PID $(cat "$WORK/p3"))"
  assert_contains "$OUT" "forcing it to stop"
  assert_contains "$OUT" "SwarmCast stopped"
  assert_not_contains "$OUT" "PID $(cat "$WORK/p4"))" "the outside process is not listed"
  assert_dead "$(cat "$WORK/p1")" "mediamtx (inside)"
  assert_dead "$(cat "$WORK/p2")" "cloudflared (inside, forced)"
  assert_dead "$(cat "$WORK/p3")" "ffmpeg started with a relative path (inside)"
  assert_alive "$(cat "$WORK/p4")" "mediamtx outside the data folder"
  assert_no_file "$DATA"
  kill -9 "$(cat "$WORK/p4")" 2>/dev/null
fi
end

# --- 5. swarmcast --cleanup --------------------------------------------------
begin "5. runs swarmcast --cleanup before deleting"
make_tree
install_recording_swarmcast
rm -f "$WORK/cleanup.log"
FAKE_CLEANUP_LOG="$WORK/cleanup.log" run_uninstall
assert_eq "$RC" 0 "exit code 0"
assert_eq "$(head -n 1 "$WORK/cleanup.log")" "--cleanup --data-dir $DATA" "called with --cleanup --data-dir"
assert_eq "$(sed -n 2p "$WORK/cleanup.log")" "SWARMCAST_DATA_DIR=$DATA" "SWARMCAST_DATA_DIR set"
assert_contains "$OUT" "fake cleanup output line" "its output is shown"
assert_no_file "$DATA"
end

begin "5b. a failing cleanup is only a note"
make_tree
install_recording_swarmcast
FAKE_CLEANUP_LOG="$WORK/cleanup.log" FAKE_CLEANUP_EXIT=1 run_uninstall
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "router port cleanup did not finish"
assert_no_file "$DATA"
end

begin "5c. no swarmcast binary: cleanup is skipped"
make_tree
run_uninstall
assert_eq "$RC" 0 "exit code 0"
assert_not_contains "$OUT" "Checking the router"
assert_no_file "$DATA"
end

# --- 6. busy files ------------------------------------------------------------
begin "6. retries a folder it cannot delete at first (read-only)"
make_tree
chmod 500 "$DATA/logs"
run_uninstall
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "trying again"
assert_no_file "$DATA"
end

begin "6b. reports what could not be removed"
mkdir -p "$WORK/locked parent"
DATA="$WORK/locked parent/data"
make_tree
chmod 555 "$WORK/locked parent"
run_uninstall
chmod 755 "$WORK/locked parent"
assert_eq "$RC" 1 "exit code 1"
assert_contains "$OUT" "could not be removed"
assert_contains "$OUT" "    $DATA" "the path is listed"
assert_contains "$OUT" "finished: some files could not be removed"
rm -rf "$WORK/locked parent"
DATA="$WORK/swarm home"
end

# --- 7. safety ---------------------------------------------------------------
begin "7. refuses a folder that is not SwarmCast's"
DATA="$WORK/my documents"
mkdir -p "$DATA"
printf 'precious\n' >"$DATA/thesis.txt"
run_uninstall
assert_eq "$RC" 1 "exit code 1"
assert_contains "$OUT" "does not look like a SwarmCast data folder"
assert_eq "$(file_content "$DATA/thesis.txt")" "precious" "file untouched"
DATA="$WORK/swarm home"
end

begin "7b. refuses the home folder even with SwarmCast files in it"
mkdir -p "$WORK/fake home"
printf '{}\n' >"$WORK/fake home/config.json"
printf 'mine\n' >"$WORK/fake home/notes.txt"
HOME="$WORK/fake home" SWARMCAST_HOME="$WORK/fake home" NO_COLOR=1 "$SCRIPT" >"$OUT" 2>&1 </dev/null
RC=$?
assert_eq "$RC" 1 "exit code 1"
assert_contains "$OUT" "is not a SwarmCast data folder"
assert_file "$WORK/fake home/notes.txt"
assert_file "$WORK/fake home/config.json"
end

begin "7c. --ask without a terminal cancels and changes nothing"
make_tree
run_uninstall --ask
assert_eq "$RC" 1 "exit code 1"
assert_contains "$OUT" "cancelled"
assert_file "$DATA/app/current/VERSION"
assert_file "$DATA/secrets.json"
end

begin "7d. default data folder (no SWARMCAST_HOME) follows the start script rules"
mkdir -p "$WORK/home2"
if [ "$OS" = macos ]; then D2="$WORK/home2/Library/Application Support/SwarmCast"; else D2="$WORK/home2/.local/share/swarmcast"; fi
mkdir -p "$D2/app/current"
env -u SWARMCAST_HOME -u XDG_DATA_HOME HOME="$WORK/home2" NO_COLOR=1 "$SCRIPT" >"$OUT" 2>&1 </dev/null
RC=$?
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Data folder: $D2"
assert_no_file "$D2"
assert_file "$WORK/home2"
end

# --- 8. usage ---------------------------------------------------------------
begin "8. --help and unknown options"
"$SCRIPT" --help >"$OUT" 2>&1
assert_eq "$?" 0 "--help exits 0"
assert_contains "$OUT" "--keep-settings"
"$SCRIPT" --bogus >"$OUT" 2>&1
assert_eq "$?" 2 "unknown option exits 2"
end

printf '\n==============================\n'
printf 'Uninstaller tests (%s-%s): %d passed, %d failed\n' "$OS" "$ARCH" "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed:%s\n' "$FAILED_NAMES"
  exit 1
fi
