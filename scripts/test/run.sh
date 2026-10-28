#!/usr/bin/env bash
# Tests for scripts/start-macos.command and scripts/start-linux.sh against a fake
# release served from 127.0.0.1. Needs bash, node and tar. Usage: scripts/test/run.sh
set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$ROOT/scripts/test"

case "$(uname -s)" in
  Darwin) OS=macos; SCRIPT="$ROOT/scripts/start-macos.command" ;;
  Linux) OS=linux; SCRIPT="$ROOT/scripts/start-linux.sh" ;;
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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarmcast-test.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
RELEASE="$WORK/release"
DATA="$WORK/swarm home"          # a space on purpose: quoting must hold
SCRIPT_TMP="$WORK/tmp"           # TMPDIR for the script under test
REQ_LOG="$WORK/requests.log"
mkdir -p "$RELEASE" "$SCRIPT_TMP"
: >"$REQ_LOG"

PASS=0
FAIL=0
FAILED_NAMES=""
CASE=""
CASE_FAILED=0
OUT=""
SERVER_PID=""

finish() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  if [ "${KEEP_WORK:-0}" = 1 ]; then echo "Work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap finish EXIT

begin() {
  CASE="$1"
  CASE_FAILED=0
  OUT="$WORK/out-$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_').txt"
  printf '\n=== %s\n' "$CASE"
}

fail() {
  printf '  FAIL: %s\n' "$*"
  CASE_FAILED=1
}

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
assert_ne() { if [ "$1" != "$2" ]; then pass "$3"; else fail "$3 (did not expect '$2')"; fi; }
assert_file() { if [ -e "$1" ]; then pass "exists: ${1#"$WORK"/}"; else fail "missing: ${1#"$WORK"/}"; fi; }
assert_no_file() { if [ ! -e "$1" ]; then pass "absent: ${1#"$WORK"/}"; else fail "should not exist: ${1#"$WORK"/}"; fi; }
assert_contains() { if grep -qiF -- "$2" "$1"; then pass "${3:-"contains '$2'"}"; else fail "${3:-"contains '$2'"} ('$2' not found in ${1#"$WORK"/})"; fi; }
assert_not_contains() { if ! grep -qiF -- "$2" "$1"; then pass "${3:-"does not contain '$2'"}"; else fail "${3:-"does not contain '$2'"}"; fi; }
file_content() { tr -d '\r\n' <"$1" 2>/dev/null; }

assert_no_staging() {
  local leftovers
  leftovers="$(find "$DATA/app" -maxdepth 1 -name '.staging-*' 2>/dev/null)"
  if [ -z "$leftovers" ]; then pass "no staging folder left"; else fail "staging folder left: $leftovers"; fi
}

assert_tmp_empty() {
  if [ -z "$(ls -A "$SCRIPT_TMP")" ]; then pass "temporary files cleaned up"; else fail "temporary files left: $(ls -A "$SCRIPT_TMP")"; fi
}

# run_script URL [args...] -> sets RC, output in $OUT
run_script() {
  local url="$1"
  shift
  env SWARMCAST_HOME="$DATA" SWARMCAST_RELEASE_URL="$url" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
    "$SCRIPT" "$@" >"$OUT" 2>&1 </dev/null
  RC=$?
  echo "  (exit code $RC)"
}

# Every fake release also publishes binaries.json + a fake ffmpeg archive served by the
# local server (pass --no-ffmpeg-pins as the first argument to leave them out).
make_release() {
  local ff=(--ffmpeg-base "$URL")
  if [ "${1:-}" = --no-ffmpeg-pins ]; then ff=(); shift; fi
  node "$TEST_DIR/make-fake-release.mjs" --dir "$RELEASE" --os "$OS" --arch "$ARCH" ${ff[@]+"${ff[@]}"} "$@" >/dev/null ||
    { echo "make-fake-release failed" >&2; exit 2; }
}

pkg() { echo "SwarmCast-v$1-$OS-$ARCH.tar.gz"; }
ffasset() { if [ "$OS" = linux ]; then echo "ffmpeg-fake-$1-linux.tar.xz"; else echo "ffmpeg-fake-$1-macos.zip"; fi; }

# --- static analysis -------------------------------------------------------
begin "syntax check"
if bash -n "$SCRIPT"; then pass "bash -n $(basename "$SCRIPT")"; else fail "bash -n $(basename "$SCRIPT")"; fi
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S warning "$SCRIPT" >"$OUT" 2>&1; then pass "shellcheck"; else fail "shellcheck"; fi
else
  echo "  (shellcheck not installed, skipped)"
fi
end

# --- server ----------------------------------------------------------------
node "$TEST_DIR/serve.mjs" "$RELEASE" "$WORK/port" "$REQ_LOG" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
[ -s "$WORK/port" ] || { echo "static server did not start" >&2; exit 2; }
URL="http://127.0.0.1:$(cat "$WORK/port")"
CLOSED_URL="http://127.0.0.1:$(node "$TEST_DIR/serve.mjs" --free-port)"
echo "Fake release server: $URL  (platform $OS-$ARCH, script $(basename "$SCRIPT"))"

COMMON=(--yes --no-tunnel --skip-speedtest)

# No back-off sleeps between retries (the scripts honour this only for a release on 127.0.0.1).
# Cases 6 and 11a keep the real delays and check them.
export SWARMCAST_TEST_RETRY_DELAYS="0 0 0"

# --- 1. clean install ------------------------------------------------------
begin "1. clean install + smoke test"
make_release --version 0.0.1
run_script "$URL" "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.1" "current/VERSION is 0.0.1"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.0.1" "smoke test ran v0.0.1 with SWARMCAST_DATA_DIR exported"
assert_file "$DATA/app/current/bin/mediamtx"
assert_no_file "$DATA/app/previous"
assert_contains "$DATA/logs/install.log" "smoke test passed" "install.log has the smoke test output"
assert_contains "$DATA/logs/install.log" "Installed SwarmCast v0.0.1" "install.log has the install"
assert_contains "$REQ_LOG" "GET /$(pkg 0.0.1) 200" "package was downloaded"
assert_contains "$REQ_LOG" "GET /binaries.json 200" "binaries.json (ffmpeg pins) fetched"
assert_contains "$REQ_LOG" "GET /$(ffasset 9.0.2-fake) 200" "ffmpeg downloaded from the URL in binaries.json"
assert_eq "$("$DATA/tools/ffmpeg/ffmpeg" -hide_banner -version 2>/dev/null | head -n 1 | cut -d' ' -f1-3)" "ffmpeg version 9.0.2-fake" "ffmpeg installed in tools/ffmpeg (outside app/) and runs"
assert_contains "$DATA/tools/ffmpeg/PIN" "9.0.2-fake" "pin stamp written"
assert_contains "$DATA/tools/ffmpeg/SOURCE.txt" "publisher" "SOURCE.txt says where it came from"
assert_contains "$OUT" "Installed ffmpeg 9.0.2-fake"
assert_no_staging
assert_tmp_empty
end

# --- 2. second run: no download --------------------------------------------
begin "2. second run is already up to date"
rm -f "$DATA/fake-smoke-ran"
: >"$REQ_LOG"
run_script "$URL" "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Already up to date (v0.0.1)"
assert_contains "$DATA/logs/install.log" "Already up to date (v0.0.1)" "install.log says already up to date"
assert_not_contains "$REQ_LOG" ".tar.gz" "no package download"
assert_contains "$REQ_LOG" "GET /SHA256SUMS.txt 200" "checksum list fetched"
assert_not_contains "$REQ_LOG" "ffmpeg-fake" "no ffmpeg download (same pin)"
assert_contains "$OUT" "Video converter (ffmpeg 9.0.2-fake) already installed"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.0.1" "smoke test ran"
assert_tmp_empty
end

# --- 2b. piped (curl | bash) ----------------------------------------------
begin "2b. piped through bash (curl | bash style)"
rm -f "$DATA/fake-smoke-ran"
env SWARMCAST_HOME="$DATA" SWARMCAST_RELEASE_URL="$URL" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  bash -s -- "${COMMON[@]}" --smoke-test <"$SCRIPT" >"$OUT" 2>&1
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Already up to date (v0.0.1)"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.0.1" "smoke test ran"
end

# --- 2c. normal start runs the app in the foreground ----------------------
begin "2c. normal start (exec) passes --no-tunnel; --install-only does not start"
rm -f "$DATA/fake-started"
run_script "$URL" --yes --skip-speedtest --install-only
assert_eq "$RC" 0 "--install-only exit code 0"
assert_no_file "$DATA/fake-started"
run_script "$URL" "${COMMON[@]}"
assert_eq "$RC" 0 "start exit code 0 (the fake app exits 0)"
assert_contains "$OUT" "rtmp://127.0.0.1:1935/live" "OBS hint printed"
assert_eq "$(file_content "$DATA/fake-started")" "0.0.1 --no-tunnel" "app started with --no-tunnel"
assert_tmp_empty
end

# --- 3. update ---------------------------------------------------------------
begin "3. update to 0.0.2 keeps config and secrets"
printf '{"ports":{"rtmp":1935}}\n' >"$DATA/config.json"
printf '{"secret":"do-not-touch"}\n' >"$DATA/secrets.json"
printf '{"state":1}\n' >"$DATA/state.json"
cp "$DATA/config.json" "$WORK/config.ref"
cp "$DATA/secrets.json" "$WORK/secrets.ref"
cp "$DATA/state.json" "$WORK/state.ref"
make_release --version 0.0.2
rm -f "$DATA/fake-smoke-ran"
: >"$REQ_LOG"
run_script "$URL" "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.2" "current/VERSION is 0.0.2"
assert_eq "$(file_content "$DATA/app/previous/VERSION")" "0.0.1" "previous/VERSION is 0.0.1"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.0.2" "smoke test ran v0.0.2"
for f in config secrets state; do
  if cmp -s "$DATA/$f.json" "$WORK/$f.ref"; then pass "$f.json untouched"; else fail "$f.json changed"; fi
done
assert_contains "$OUT" "Updating SwarmCast v0.0.1 -> v0.0.2"
assert_not_contains "$REQ_LOG" "ffmpeg-fake" "the app update does not download ffmpeg again"
assert_file "$DATA/tools/ffmpeg/ffmpeg"
assert_no_staging
assert_tmp_empty
end

# --- 4. checksum failure -------------------------------------------------------
begin "4. corrupted 0.0.3 download is rejected"
make_release --version 0.0.3 --corrupt
rm -f "$DATA/fake-smoke-ran"
run_script "$URL" "${COMMON[@]}" --smoke-test
assert_ne "$RC" 0 "non-zero exit code"
assert_contains "$OUT" "Checksum mismatch"
assert_contains "$DATA/logs/install.log" "Checksum mismatch" "install.log has the checksum error"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.2" "current is still 0.0.2"
assert_eq "$(file_content "$DATA/app/previous/VERSION")" "0.0.1" "previous is still 0.0.1"
assert_no_file "$DATA/fake-smoke-ran"
assert_no_staging
assert_tmp_empty
end

# --- 5. offline with an existing install -----------------------------------
begin "5. offline starts the installed version"
rm -f "$DATA/fake-smoke-ran"
run_script "$CLOSED_URL" "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Could not check for updates"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.0.2" "smoke test ran the installed v0.0.2"
assert_contains "$OUT" "Video converter already installed" "offline: the installed ffmpeg is kept"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.2" "current is still 0.0.2"
assert_tmp_empty
end

# --- 6. offline with nothing installed -------------------------------------
begin "6. offline with nothing installed fails clearly (real back-off: the test hook is for 127.0.0.1 only)"
DATA_SAVED="$DATA"
DATA="$WORK/empty home"
# localhost, not 127.0.0.1: SWARMCAST_TEST_RETRY_DELAYS must be ignored, so the real delays run.
run_script "${CLOSED_URL/127.0.0.1/localhost}" "${COMMON[@]}" --smoke-test
assert_ne "$RC" 0 "non-zero exit code"
assert_contains "$OUT" "release server is unreachable"
for d in 2 4 8; do assert_contains "$OUT" "failed, retrying in ${d}s" "back-off of ${d} s"; done
assert_not_contains "$DATA/logs/install.log" "test hook: retry delays" "test hook not used"
assert_no_file "$DATA/app/current"
assert_tmp_empty
DATA="$DATA_SAVED"
end

# --- 9. video converter (ffmpeg) ---------------------------------------------
DATA_SAVED="$DATA"

begin "9a. ffmpeg checksum mismatch: skipped with a warning, the install still succeeds"
DATA="$WORK/ffmpeg bad sha home"
make_release --version 0.0.4 --ffmpeg-bad-sha
rm -f "$DATA/fake-smoke-ran"
run_script "$URL" "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "checksum mismatch for the ffmpeg download"
assert_contains "$OUT" "still works without it"
assert_contains "$DATA/logs/install.log" "checksum mismatch for the ffmpeg download" "install.log has the warning"
assert_no_file "$DATA/tools/ffmpeg/ffmpeg"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.4" "SwarmCast itself was installed"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.0.4" "smoke test ran"
assert_tmp_empty
end

begin "9b. --no-ffmpeg skips the download"
DATA="$WORK/no ffmpeg home"
make_release --version 0.0.4
: >"$REQ_LOG"
run_script "$URL" "${COMMON[@]}" --no-ffmpeg --install-only
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Skipped (--no-ffmpeg)"
assert_not_contains "$REQ_LOG" "ffmpeg-fake" "no ffmpeg download"
assert_no_file "$DATA/tools/ffmpeg/ffmpeg"
assert_tmp_empty
end

begin "9c. a release without binaries.json (older release): skipped with a note"
DATA="$WORK/old release home"
make_release --no-ffmpeg-pins --version 0.0.4
run_script "$URL" "${COMMON[@]}" --install-only
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "this release does not list binaries.json"
assert_no_file "$DATA/tools/ffmpeg/ffmpeg"
assert_tmp_empty
end

begin "9d. a new ffmpeg pin is downloaded once, even when SwarmCast is already up to date"
DATA="$DATA_SAVED"
make_release --version 0.0.2 --ffmpeg-version 9.0.3-fake
: >"$REQ_LOG"
run_script "$URL" "${COMMON[@]}" --install-only
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Already up to date (v0.0.2)"
assert_contains "$REQ_LOG" "GET /$(ffasset 9.0.3-fake) 200" "new ffmpeg downloaded"
assert_contains "$DATA/tools/ffmpeg/PIN" "9.0.3-fake" "pin stamp updated"
: >"$REQ_LOG"
run_script "$URL" "${COMMON[@]}" --install-only
assert_not_contains "$REQ_LOG" "ffmpeg-fake" "not downloaded again"
assert_tmp_empty
end
DATA="$DATA_SAVED"

# --- 11. resilience -----------------------------------------------------------
begin "11a. a transient unpacking failure recovers on retry"
DATA="$WORK/retry home"
make_release --version 0.0.4
env -u SWARMCAST_TEST_RETRY_DELAYS SWARMCAST_HOME="$DATA" SWARMCAST_RELEASE_URL="$URL" SWARMCAST_TEST_FAIL_ONCE=extract TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  "$SCRIPT" --no-tunnel --skip-speedtest --no-ffmpeg --install-only >"$OUT" 2>&1 </dev/null
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Unpacking $(pkg 0.0.4) failed, retrying in 2s"
assert_contains "$DATA/logs/install.log" "(attempt 2 of 4)" "install.log has the retry"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.4" "installed after the retry"
assert_no_staging
assert_tmp_empty
end

begin "11b. a new version that crashes on start: rolled back to the previous one, which starts"
make_release --version 0.0.5
rm -f "$DATA/fake-started"
env SWARMCAST_HOME="$DATA" SWARMCAST_RELEASE_URL="$URL" FAKE_CRASH_VERSION=0.0.5 TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  "$SCRIPT" --no-tunnel --skip-speedtest --no-ffmpeg >"$OUT" 2>&1 </dev/null
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0 (the previous version started)"
assert_contains "$OUT" "The new version v0.0.5 did not start, so SwarmCast went back to v0.0.4"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.4" "current is back to 0.0.4"
assert_eq "$(file_content "$DATA/fake-started")" "0.0.4 --no-tunnel" "v0.0.4 was started"
assert_no_file "$DATA/app/failed"
end

begin "11c. system-check.json is written with the schema"
F="$DATA/system-check.json"
assert_file "$F"
if node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ids = ["os","ram","cpu","upload","download","disk","ports","obs","github","release"];
  const ok = j.version === 1 && !isNaN(Date.parse(j.at)) && typeof j.os === "string" && ["x64","arm64"].includes(j.arch)
    && Array.isArray(j.results) && ids.every((id) => j.results.some((r) => r.id === id))
    && j.results.every((r) => ["ok","warn","fail","skipped"].includes(r.status) && ["value","min","recommended","detail"].every((k) => typeof r[k] === "string"))
    && j.uploadMbps === null && j.downloadMbps === null && j.viewerEstimate === null
    && Array.isArray(j.belowMinimum)
    && j.results.find((r) => r.id === "upload").status === "skipped";
  process.exit(ok ? 0 : 1);
' "$F"; then pass "schema ok"; else fail "schema"; cat "$F"; fi
DATA="$WORK/below minimum check"
env SWARMCAST_HOME="$DATA" SWARMCAST_RELEASE_URL="$URL" SWARMCAST_TEST_BELOW="memory 1.0 GB (minimum 4 GB)" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  "$SCRIPT" --skip-speedtest --no-ffmpeg --install-only >"$OUT" 2>&1 </dev/null
assert_contains "$DATA/system-check.json" '"belowMinimum": ["ram"]' "belowMinimum lists the check ids"
end
DATA="$DATA_SAVED"

# --- 10. never asks questions by default -----------------------------------
begin "10a. below the minimum: warns and continues without any input (no --yes)"
DATA="$WORK/below minimum home"
make_release --version 0.0.4
env SWARMCAST_HOME="$DATA" SWARMCAST_RELEASE_URL="$URL" SWARMCAST_TEST_BELOW="memory 1.0 GB (minimum 4 GB)" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  "$SCRIPT" --no-tunnel --skip-speedtest --no-ffmpeg --install-only >"$OUT" 2>&1 </dev/null
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "below the recommended minimum: memory 1.0 GB"
assert_contains "$OUT" "Continuing anyway"
assert_not_contains "$OUT" "(y/N)" "no question asked"
assert_contains "$DATA/logs/install.log" "below the recommended minimum" "install.log has the warning"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.0.4" "installed"
assert_tmp_empty
end

begin "10b. --ask restores the question (--yes answers it)"
DATA="$WORK/ask home"
env SWARMCAST_HOME="$DATA" SWARMCAST_RELEASE_URL="$URL" SWARMCAST_TEST_BELOW="memory 1.0 GB (minimum 4 GB)" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  "$SCRIPT" --ask --yes --no-tunnel --skip-speedtest --no-ffmpeg --install-only >"$OUT" 2>&1 </dev/null
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Continue anyway? (y/N) yes (--yes)"
assert_not_contains "$OUT" "Continuing anyway"
assert_tmp_empty
end
DATA="$DATA_SAVED"

# --- 8. local bundle (installer zip) -----------------------------------------
# The script copy inside the bundle gets its default release URL rewritten (like the
# release workflow does for the public mirror), so no test ever talks to GitHub.
BUNDLE="$WORK/installer folder"     # a space on purpose
BUNDLE_SCRIPT="$BUNDLE/$(basename "$SCRIPT")"

# make_bundle VERSION DEFAULT_URL [--corrupt]: script + package + one-line SHA256SUMS.txt
make_bundle() {
  local v="$1" default_url="$2"
  shift 2
  rm -rf "$BUNDLE"
  node "$TEST_DIR/make-fake-release.mjs" --dir "$BUNDLE" --os "$OS" --arch "$ARCH" --version "$v" --ffmpeg-base "${FFMPEG_BASE:-$URL}" "$@" >/dev/null ||
    { echo "make-fake-release failed" >&2; exit 2; }
  # Like the release workflow: the package and binaries.json (ffmpeg pins) are listed.
  grep -E "  ($(pkg "$v")|binaries\.json)\$" "$BUNDLE/SHA256SUMS.txt" >"$BUNDLE/sums.tmp" && mv "$BUNDLE/sums.tmp" "$BUNDLE/SHA256SUMS.txt"
  # The ffmpeg URL in binaries.json points at the local server (the "publisher"): serve the archive there.
  cp "$BUNDLE"/ffmpeg-fake-* "$RELEASE/" 2>/dev/null
  rm -f "$BUNDLE"/ffmpeg-fake-*
  sed "s|^SC_DEFAULT_RELEASE_URL=.*|SC_DEFAULT_RELEASE_URL=\"$default_url\"|" "$SCRIPT" >"$BUNDLE_SCRIPT"
  chmod 755 "$BUNDLE_SCRIPT"
}

# run_bundle [args...]: runs the script inside the bundle without SWARMCAST_RELEASE_URL.
run_bundle() {
  env -u SWARMCAST_RELEASE_URL SWARMCAST_HOME="$DATA" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
    "$BUNDLE_SCRIPT" "$@" >"$OUT" 2>&1 </dev/null
  RC=$?
  echo "  (exit code $RC)"
}

DATA_SAVED="$DATA"
DATA="$WORK/bundle home"

begin "8a. local bundle installs with no release server reachable"
make_bundle 0.1.0 "$CLOSED_URL"
: >"$REQ_LOG"
rm -f "$DATA/fake-smoke-ran"
run_bundle "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Install source: local bundle in $BUNDLE (v0.1.0)"
assert_contains "$OUT" "not reachable (fine)" "unreachable online release is not an error"
assert_contains "$OUT" "Using $(pkg 0.1.0) from the local bundle"
assert_contains "$OUT" "Checksum OK"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.1.0" "current/VERSION is 0.1.0"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.1.0" "smoke test ran v0.1.0"
assert_not_contains "$REQ_LOG" "SHA256SUMS" "no request to the release server"
assert_contains "$REQ_LOG" "GET /$(ffasset 9.0.2-fake) 200" "ffmpeg downloaded online using the bundle's binaries.json"
assert_file "$DATA/tools/ffmpeg/ffmpeg"
assert_file "$BUNDLE/$(pkg 0.1.0)"
assert_file "$BUNDLE/SHA256SUMS.txt"
assert_no_staging
assert_tmp_empty
end

begin "8b. second run from the bundle: already up to date; HTTP 404 from the release server is fine"
make_bundle 0.1.0 "$URL/private-repo"
: >"$REQ_LOG"
run_bundle "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Already up to date (v0.1.0)"
assert_eq "$(grep -c 'GET /private-repo/SHA256SUMS.txt 404' "$REQ_LOG")" 1 "online check asked once (no retries on 404)"
assert_not_contains "$OUT" "retrying"
assert_tmp_empty
end

begin "8c. update from a newer local bundle"
printf '{"secret":"do-not-touch"}\n' >"$DATA/secrets.json"
cp "$DATA/secrets.json" "$WORK/bundle-secrets.ref"
make_bundle 0.1.1 "$CLOSED_URL"
rm -f "$DATA/fake-smoke-ran"
run_bundle "${COMMON[@]}" --smoke-test
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Updating SwarmCast v0.1.0 -> v0.1.1"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.1.1" "current/VERSION is 0.1.1"
assert_eq "$(file_content "$DATA/app/previous/VERSION")" "0.1.0" "previous/VERSION is 0.1.0"
assert_eq "$(file_content "$DATA/fake-smoke-ran")" "0.1.1" "smoke test ran v0.1.1"
if cmp -s "$DATA/secrets.json" "$WORK/bundle-secrets.ref"; then pass "secrets.json untouched"; else fail "secrets.json changed"; fi
assert_no_staging
assert_tmp_empty
end

begin "8d. an older local bundle does not downgrade"
make_bundle 0.1.0 "$CLOSED_URL"
run_bundle "${COMMON[@]}" --install-only
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Already up to date (v0.1.1"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.1.1" "current is still 0.1.1"
assert_eq "$(file_content "$DATA/app/previous/VERSION")" "0.1.0" "previous is still 0.1.0"
end

begin "8e. corrupted local package is rejected, nothing changed"
make_bundle 0.1.2 "$CLOSED_URL" --corrupt
rm -f "$DATA/fake-smoke-ran"
run_bundle "${COMMON[@]}" --smoke-test
assert_ne "$RC" 0 "non-zero exit code"
assert_contains "$OUT" "Checksum mismatch"
assert_contains "$DATA/logs/install.log" "Checksum mismatch" "install.log has the checksum error"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.1.1" "current is still 0.1.1"
assert_eq "$(file_content "$DATA/app/previous/VERSION")" "0.1.0" "previous is still 0.1.0"
assert_no_file "$DATA/fake-smoke-ran"
assert_file "$BUNDLE/$(pkg 0.1.2)"
assert_no_staging
assert_tmp_empty
end

begin "8f. a newer online release wins over the local bundle"
make_release --version 0.2.0
make_bundle 0.1.3 "$URL"
: >"$REQ_LOG"
run_bundle "${COMMON[@]}" --install-only
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "A newer version v0.2.0 is available online"
assert_contains "$REQ_LOG" "GET /$(pkg 0.2.0) 200" "online package was downloaded"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.2.0" "current/VERSION is 0.2.0"
assert_no_staging
assert_tmp_empty
end

begin "8g. SWARMCAST_RELEASE_URL overrides the local bundle"
make_release --version 0.2.1
make_bundle 0.1.3 "$CLOSED_URL"
: >"$REQ_LOG"
env SWARMCAST_RELEASE_URL="$URL" SWARMCAST_HOME="$DATA" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  "$BUNDLE_SCRIPT" "${COMMON[@]}" --install-only >"$OUT" 2>&1 </dev/null
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Install source: $URL (from SWARMCAST_RELEASE_URL)"
assert_not_contains "$OUT" "local bundle"
assert_contains "$REQ_LOG" "GET /$(pkg 0.2.1) 200" "package downloaded from the env URL"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.2.1" "current/VERSION is 0.2.1"
assert_tmp_empty
end

begin "8h. piped (curl | bash) ignores files in the current folder"
make_bundle 0.3.0 "$CLOSED_URL"
(cd "$BUNDLE" && env -u SWARMCAST_RELEASE_URL SWARMCAST_HOME="$DATA" TMPDIR="$SCRIPT_TMP" NO_COLOR=1 \
  bash -s -- "${COMMON[@]}" --install-only <"$BUNDLE_SCRIPT" >"$OUT" 2>&1)
RC=$?
echo "  (exit code $RC)"
assert_eq "$RC" 0 "exit code 0 (installed version kept)"
assert_contains "$OUT" "Install source: $CLOSED_URL"
assert_not_contains "$OUT" "local bundle"
assert_contains "$OUT" "Could not check for updates"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.2.1" "current is still 0.2.1"
end

begin "8j. offline bundle: SwarmCast installs, ffmpeg is skipped with a clear note"
DATA="$WORK/offline bundle home"
FFMPEG_BASE="$CLOSED_URL" make_bundle 0.3.1 "$CLOSED_URL"
run_bundle "${COMMON[@]}" --install-only
assert_eq "$RC" 0 "exit code 0"
assert_contains "$OUT" "Skipping the video converter: the download failed"
assert_contains "$OUT" "still works without it"
assert_eq "$(file_content "$DATA/app/current/VERSION")" "0.3.1" "current/VERSION is 0.3.1"
assert_no_file "$DATA/tools/ffmpeg/ffmpeg"
assert_tmp_empty
end

begin "8i. no bundle, HTTP 404 from the release server, nothing installed: points to the installer zip"
DATA="$WORK/empty home 404"
run_script "$URL/private-repo" "${COMMON[@]}" --install-only
assert_ne "$RC" 0 "non-zero exit code"
assert_contains "$OUT" "answered HTTP 404"
assert_contains "$OUT" "installer zip"
assert_not_contains "$OUT" "retrying"
assert_no_file "$DATA/app/current"
assert_tmp_empty
end
DATA="$DATA_SAVED"

# --- 7. usage --------------------------------------------------------------
begin "7. --help and unknown options"
"$SCRIPT" --help >"$OUT" 2>&1
assert_eq "$?" 0 "--help exits 0"
assert_contains "$OUT" "--install-only"
assert_contains "$OUT" "--no-ffmpeg"
assert_contains "$OUT" "--ask"
"$SCRIPT" --bogus >"$OUT" 2>&1
assert_eq "$?" 2 "unknown option exits 2"
end

printf '\n==============================\n'
printf 'Installer tests (%s-%s): %d passed, %d failed\n' "$OS" "$ARCH" "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed:%s\n' "$FAILED_NAMES"
  exit 1
fi
