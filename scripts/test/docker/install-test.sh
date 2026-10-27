#!/usr/bin/env bash
# Runs INSIDE a Dockerfile.install container, as the non-root user "tester".
# Exercises the real start-linux.sh + the real SwarmCast package:
#   install + smoke test, "already up to date" (curl | bash), corrupted checksum (update and
#   clean install), normal start with an RTMP stream + a curl viewer, Ctrl+C / SIGTERM shutdown.
#
# Env:
#   RELEASE_URL   URL of the real release folder (SHA256SUMS.txt, packages, start-linux.sh)
#   CORRUPT_URL   URL of a release folder whose SHA256SUMS.txt lists a wrong checksum
#   SCRIPT        Path of start-linux.sh inside the container (default /release/start-linux.sh)
#   EXPECT_VER    Expected version (default 0.2.0)
#   SKIP_SPEED    1 = pass --skip-speedtest to the first run too (default 0)
set -u
set -o pipefail

RELEASE_URL="${RELEASE_URL:?RELEASE_URL is required}"
CORRUPT_URL="${CORRUPT_URL:-}"
SCRIPT="${SCRIPT:-/release/start-linux.sh}"
EXPECT_VER="${EXPECT_VER:-0.2.0}"
SKIP_SPEED="${SKIP_SPEED:-0}"

W="$(mktemp -d /tmp/sc-docker-test.XXXXXX)"
H="$W/swarm home"            # a space on purpose: quoting must hold
export NO_COLOR=1

PASS=0
FAIL=0
FAILED=""
CASE=""

begin() { CASE="$1"; CASE_FAILED=0; printf '\n=== %s\n' "$1"; }
ok() { printf '  ok: %s\n' "$*"; }
bad() { printf '  FAIL: %s\n' "$*"; CASE_FAILED=1; }
end() {
  if [ "$CASE_FAILED" = 0 ]; then PASS=$((PASS + 1)); printf 'PASS %s\n' "$CASE"
  else FAIL=$((FAIL + 1)); FAILED="$FAILED; $CASE"; printf 'FAIL %s\n' "$CASE"; fi
}
eq() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
ne() { if [ "$1" != "$2" ]; then ok "$3"; else bad "$3 (did not expect '$2')"; fi; }
has() { if grep -qF -- "$2" "$1"; then ok "output has: $2"; else bad "output lacks: $2"; fi; }
hasnt() { if ! grep -qF -- "$2" "$1"; then ok "output does not have: $2"; else bad "output should not have: $2"; fi; }
show() { printf -- '  --- %s ---\n' "$1"; sed 's/^/  | /' "$2"; printf -- '  --- end ---\n'; }
no_proc() {
  local p
  # The packaged app's thread name is "MainThread", so match the command line instead.
  p="$(pgrep -a -f "/app/current/(bin/)?$1( |\$)" 2>/dev/null)"
  if [ -z "$p" ]; then ok "no $1 process left"; else bad "$1 still running: $p"; fi
}
tree_sum() { (cd "$1" 2>/dev/null && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# wait_for SECONDS COMMAND... -> 0 once COMMAND succeeds
wait_for() {
  local secs="$1" _i
  shift
  for _i in $(seq 1 "$((secs * 2))"); do
    "$@" && return 0
    sleep 0.5
  done
  return 1
}

run_script() { # run_script URL OUTFILE args... -> RC
  local url="$1" out="$2"
  shift 2
  env SWARMCAST_HOME="$H" SWARMCAST_RELEASE_URL="$url" bash "$SCRIPT" "$@" >"$out" 2>&1 </dev/null
  RC=$?
  echo "  (exit code $RC)"
}

echo "Container: $(. /etc/os-release && echo "$PRETTY_NAME") $(uname -m), user $(id -un) (uid $(id -u))"
echo "curl $(curl --version | head -n1 | cut -d' ' -f2), ffmpeg $(ffmpeg -version | head -n1 | cut -d' ' -f3)"
echo "Release: $RELEASE_URL"

# ---------------------------------------------------------------------------
begin "1. clean install + real smoke test"
first_args=(--yes --no-tunnel --smoke-test)
[ "$SKIP_SPEED" = 1 ] && first_args+=(--skip-speedtest)
O="$W/1.txt"
run_script "$RELEASE_URL" "$O" "${first_args[@]}"
eq "$RC" 0 "exit code 0"
eq "$(tr -d '\r\n' <"$H/app/current/VERSION" 2>/dev/null)" "$EXPECT_VER" "app/current/VERSION"
eq "$("$H/app/current/swarmcast" --version 2>/dev/null | tail -n1)" "$EXPECT_VER" "swarmcast --version"
for f in swarmcast bin/mediamtx bin/cloudflared; do
  if [ -x "$H/app/current/$f" ]; then ok "executable: app/current/$f"; else bad "not executable: app/current/$f"; fi
done
has "$O" "Installed SwarmCast v$EXPECT_VER"
has "$O" "Checksum OK"
has "$O" "✓ smoke test passed"
has "$O" "Smoke test passed."
if [ -z "$(find "$H/app" -maxdepth 1 -name '.staging-*')" ]; then ok "no staging folder left"; else bad "staging folder left"; fi
if [ ! -e "$H/app/previous" ]; then ok "no previous/ on a clean install"; else bad "previous/ exists"; fi
if [ -f "$H/secrets.json" ]; then ok "secrets.json created in SWARMCAST_HOME"; else bad "secrets.json missing in SWARMCAST_HOME"; fi
eq "$(stat -c %a "$H/secrets.json" 2>/dev/null)" "600" "secrets.json mode"
no_proc mediamtx
grep -E 'Operating system|Memory|CPU cores|Upload speed|Download speed|Release server|github.com' "$O" | sed 's/^/  > /'
[ "$CASE_FAILED" = 1 ] && show "script output" "$O"
end

SUM_BEFORE="$(tree_sum "$H/app/current")"

# ---------------------------------------------------------------------------
begin "2. second run (curl | bash) is already up to date"
O="$W/2.txt"
curl -fsSL "$RELEASE_URL/start-linux.sh" |
  env SWARMCAST_HOME="$H" SWARMCAST_RELEASE_URL="$RELEASE_URL" bash -s -- --yes --no-tunnel --skip-speedtest --smoke-test >"$O" 2>&1
RC=$?
echo "  (exit code $RC)"
eq "$RC" 0 "exit code 0"
has "$O" "Already up to date (v$EXPECT_VER)"
hasnt "$O" "Downloading SwarmCast-v"
has "$O" "Smoke test passed."
eq "$(tree_sum "$H/app/current")" "$SUM_BEFORE" "installed files unchanged"
[ "$CASE_FAILED" = 1 ] && show "script output" "$O"
end

# ---------------------------------------------------------------------------
if [ -n "$CORRUPT_URL" ]; then
  begin "3. corrupted checksum on update is rejected, install untouched"
  O="$W/3.txt"
  run_script "$CORRUPT_URL" "$O" --yes --no-tunnel --skip-speedtest --smoke-test
  ne "$RC" 0 "non-zero exit code"
  has "$O" "Checksum mismatch"
  has "$O" "Your installed version v$EXPECT_VER was not changed."
  hasnt "$O" "Smoke test"
  eq "$(tr -d '\r\n' <"$H/app/current/VERSION")" "$EXPECT_VER" "current/VERSION unchanged"
  eq "$(tree_sum "$H/app/current")" "$SUM_BEFORE" "installed files unchanged"
  if [ ! -e "$H/app/previous" ]; then ok "no previous/ created"; else bad "previous/ was created"; fi
  if [ -z "$(find "$H/app" -maxdepth 1 -name '.staging-*')" ]; then ok "no staging folder left"; else bad "staging folder left"; fi
  if [ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'swarmcast.*' 2>/dev/null)" ]; then ok "temp folder cleaned"; else bad "temp folder left: $(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'swarmcast.*')"; fi
  grep -E 'Checksum mismatch|expected:|got:' "$O" | sed 's/^/  > /'
  [ "$CASE_FAILED" = 1 ] && show "script output" "$O"
  end

  begin "3b. corrupted checksum on a clean install installs nothing"
  H_SAVED="$H"
  H="$W/fresh home"
  O="$W/3b.txt"
  run_script "$CORRUPT_URL" "$O" --yes --no-tunnel --skip-speedtest --smoke-test
  ne "$RC" 0 "non-zero exit code"
  has "$O" "Checksum mismatch"
  has "$O" "Nothing was installed."
  if [ ! -e "$H/app/current" ]; then ok "no app/current"; else bad "app/current exists"; fi
  H="$H_SAVED"
  [ "$CASE_FAILED" = 1 ] && show "script output" "$O"
  end
fi

# ---------------------------------------------------------------------------
ADMIN=""
admin_get() { curl -fsS -b "$W/admin.jar" "$ADMIN$1"; }
state() { admin_get /api/state; }
phase_is() { [ "$(state 2>/dev/null | jq -r .phase)" = "$1" ]; }
panel_url_in() { grep -oE 'http://127\.0\.0\.1:[0-9]+/auth/[A-Za-z0-9_-]+' "$1" | head -n1; }

start_bg() { # start_bg OUTFILE -> APP_PID
  # setsid: a background job of a non-interactive shell would start with SIGINT ignored.
  env SWARMCAST_HOME="$H" SWARMCAST_RELEASE_URL="$RELEASE_URL" \
    setsid bash "$SCRIPT" --yes --no-tunnel --skip-speedtest >"$1" 2>&1 </dev/null &
  APP_PID=$!
}

stop_and_check() { # stop_and_check SIGNAL OUTFILE
  local sig="$1" out="$2" rc
  kill -s "$sig" "$APP_PID"
  if wait_for 45 bash -c "! kill -0 $APP_PID 2>/dev/null"; then ok "app exited after SIG$sig"; else bad "app still running 45 s after SIG$sig"; kill -9 "$APP_PID"; fi
  wait "$APP_PID" 2>/dev/null
  rc=$?
  eq "$rc" 0 "app exit code after SIG$sig"
  has "$out" "Stopping everything"
  has "$out" "Off: nothing on your computer is reachable"
  no_proc mediamtx
  no_proc cloudflared
  no_proc swarmcast
  for p in 1935 8080 8081; do
    if port_open "$p"; then bad "port $p still open"; else ok "port $p closed"; fi
  done
}

begin "4. normal start, RTMP stream, curl viewer, Ctrl+C (SIGINT)"
O="$W/4.txt"
start_bg "$O"
if wait_for 60 bash -c "grep -qE 'http://127\.0\.0\.1:[0-9]+/auth/' \"$O\""; then ok "panel URL printed"; else bad "no panel URL after 60 s"; fi
LOGIN="$(panel_url_in "$O")"
echo "  panel: ${LOGIN%/auth/*}/auth/<token>"
ADMIN="${LOGIN%/auth/*}"
# argv[0] rather than /proc/PID/exe: under emulation (Rosetta/QEMU) exe is the emulator.
eq "$(basename "$(tr '\0' '\n' <"/proc/$APP_PID/cmdline" 2>/dev/null | head -n1)")" "swarmcast" "start script exec'd into the app (same PID)"
if [ -n "$LOGIN" ]; then
  eq "$(curl -s -o /dev/null -c "$W/admin.jar" -w '%{http_code}' "$LOGIN")" "200" "GET /auth/<token> -> 200 (cookie + meta refresh)"
  eq "$(curl -s -o "$W/panel.html" -b "$W/admin.jar" -w '%{http_code}' "$ADMIN/")" "200" "GET / (panel) with cookie -> 200"
  if grep -qi '<script' "$W/panel.html"; then ok "panel HTML has a script tag"; else bad "panel HTML looks wrong"; fi
  eq "$(curl -s -o /dev/null -w '%{http_code}' "$ADMIN/api/state")" "401" "GET /api/state without cookie -> 401"
  eq "$(curl -s -o /dev/null -b "$W/admin.jar" -X POST -H 'content-type: application/json' -d '{}' -w '%{http_code}' "$ADMIN/api/live/stop")" "403" "POST without Origin -> 403"
  if wait_for 60 phase_is waiting-obs; then ok "phase waiting-obs"; else bad "phase is $(state | jq -r .phase), expected waiting-obs"; fi
  eq "$(state | jq -r .obsConnected)" "false" "obsConnected false before the stream"
  eq "$(state | jq -r .rtmpUrl)" "rtmp://127.0.0.1:1935/live" "rtmpUrl"
  if pgrep -x mediamtx >/dev/null; then ok "mediamtx running"; else bad "mediamtx not running"; fi
  KEY="$(state | jq -r .streamKey)"
  ffmpeg -hide_banner -loglevel error -re \
    -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0 -b:v 1200k \
    -c:a aac -b:a 96k -f flv "rtmp://127.0.0.1:1935/live/$KEY" >"$W/ffmpeg.log" 2>&1 </dev/null &
  FF_PID=$!
  if wait_for 60 phase_is live; then ok "phase live"; else bad "phase is $(state | jq -r .phase), expected live"; show ffmpeg "$W/ffmpeg.log"; fi
  eq "$(state | jq -r .obsConnected)" "true" "obsConnected true"
  LINK="$(state | jq -r .liveLink)"
  echo "  live link: ${LINK%/join/*}/join/<secret>"
  # curl cannot solve the browser check (on by default since v0.2): check the default, then turn it off from the panel API.
  eq "$(state | jq -r .security.settings.requireBrowserCheck)" "true" "browser check on by default"
  eq "$(curl -s -o /dev/null -X PUT -b "$W/admin.jar" -H "origin: $ADMIN" -H 'content-type: application/json' -d "$(state | jq -c '.security.settings | .requireBrowserCheck = false')" -w '%{http_code}' "$ADMIN/api/security")" "200" "browser check turned off for the curl viewer"
  V="$W/viewer.jar"
  eq "$(curl -s -o /dev/null -c "$V" -b "$V" -w '%{http_code} %{redirect_url}' "$LINK")" "303 ${LINK%/join/*}/join" "GET live link -> 303 /join"
  if grep -q sc_ticket "$V"; then ok "ticket cookie set"; else bad "no ticket cookie"; fi
  eq "$(curl -s -o /dev/null -c "$V" -b "$V" -w '%{http_code}' "${LINK%/join/*}/join")" "200" "GET /join -> 200"
  JOIN="$(curl -s -c "$V" -b "$V" -H 'content-type: application/json' -d '{"nickname":"docker-tester"}' -w ' %{http_code}' "${LINK%/join/*}/api/join")"
  eq "${JOIN##* }" "200" "POST /api/join -> 200 (${JOIN% *})"
  if grep -q sc_session "$V"; then ok "session cookie set"; else bad "no session cookie"; fi
  BASE="${LINK%/join/*}"
  eq "$(curl -s -o /dev/null -b "$V" -w '%{http_code}' "$BASE/watch")" "200" "GET /watch -> 200"
  got_pl() { [ "$(curl -s -o "$W/index.m3u8" -b "$V" -w '%{http_code}' "$BASE/hls/index.m3u8")" = 200 ]; }
  if wait_for 30 got_pl; then ok "GET /hls/index.m3u8 -> 200"; else bad "GET /hls/index.m3u8 never returned 200"; fi
  eq "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hls/index.m3u8")" "401" "GET /hls/index.m3u8 without session -> 401"
  # Follow a variant playlist (if any) down to a media segment.
  PL="$W/index.m3u8"
  for _ in 1 2; do
    ITEM="$(grep -v '^#' "$PL" | grep -v '^$' | tail -n1)"
    case "$ITEM" in
      *.m3u8) curl -s -b "$V" -o "$W/child.m3u8" "$BASE/hls/$ITEM"; PL="$W/child.m3u8" ;;
      *) break ;;
    esac
  done
  INIT="$(grep -oE 'URI="[^"]+"' "$PL" | head -n1 | sed 's/URI="\(.*\)"/\1/')"
  if [ -n "$INIT" ]; then
    eq "$(curl -s -o /dev/null -b "$V" -w '%{http_code}' "$BASE/hls/$INIT")" "200" "GET init segment $INIT -> 200"
  fi
  if [ -n "$ITEM" ]; then
    R="$(curl -s -o "$W/seg" -b "$V" -w '%{http_code} %{size_download}' "$BASE/hls/$ITEM")"
    if [ "${R% *}" = 200 ] && [ "${R#* }" -gt 1000 ]; then ok "GET segment $ITEM -> 200 (${R#* } bytes)"; else bad "GET segment $ITEM -> $R"; fi
  else
    bad "no segment in the playlist"; show playlist "$PL"
  fi
  eq "$(state | jq -r '[.viewers[] | select(.nickname == "docker-tester")] | length')" "1" "panel lists the viewer"
  kill "$FF_PID" 2>/dev/null
  wait "$FF_PID" 2>/dev/null
fi
stop_and_check INT "$O"
[ "$CASE_FAILED" = 1 ] && show "app output" "$O"
end

begin "5. normal start, SIGTERM"
O="$W/5.txt"
start_bg "$O"
if wait_for 60 bash -c "grep -qE 'http://127\.0\.0\.1:[0-9]+/auth/' \"$O\""; then ok "panel URL printed"; else bad "no panel URL after 60 s"; fi
LOGIN="$(panel_url_in "$O")"
ADMIN="${LOGIN%/auth/*}"
curl -s -o /dev/null -c "$W/admin.jar" "$LOGIN"
if wait_for 60 phase_is waiting-obs; then ok "phase waiting-obs"; else bad "phase is $(state | jq -r .phase)"; fi
stop_and_check TERM "$O"
[ "$CASE_FAILED" = 1 ] && show "app output" "$O"
end

# Informational: things seen in the app output that are not failures of this suite.
for f in "$W/4.txt" "$W/5.txt"; do
  n="$(grep -c 'reaper exited unexpectedly' "$f")"
  [ "$n" -gt 0 ] && echo "WARN $(basename "$f"): 'reaper exited unexpectedly, restarting' x$n (see case 6)"
  grep -q 'tray helper stderr.*panic' "$f" && echo "WARN $(basename "$f"): the tray helper panicked (no D-Bus session in the container)"
done

begin "6. app killed with SIGKILL: the reaper must stop MediaMTX"
O="$W/6.txt"
start_bg "$O"
LOGIN=""
if wait_for 60 bash -c "grep -qE 'http://127\.0\.0\.1:[0-9]+/auth/' \"$O\""; then LOGIN="$(panel_url_in "$O")"; fi
ADMIN="${LOGIN%/auth/*}"
curl -s -o /dev/null -c "$W/admin.jar" "$LOGIN"
if wait_for 60 phase_is waiting-obs; then ok "phase waiting-obs"; else bad "phase is $(state | jq -r .phase)"; fi
if pgrep -x mediamtx >/dev/null; then ok "mediamtx running"; else bad "mediamtx not running"; fi
kill -9 "$APP_PID"
wait "$APP_PID" 2>/dev/null
sleep 5
no_proc mediamtx
if port_open 1935; then bad "port 1935 still open 5 s after SIGKILL"; else ok "port 1935 closed"; fi
pkill -9 -x mediamtx 2>/dev/null
pkill -9 -f "/app/current/swarmcast" 2>/dev/null
end

printf '\n==============================\n'
printf 'RESULT %s %s: %d passed, %d failed%s\n' "$(. /etc/os-release && echo "$ID-$VERSION_ID")" "$(uname -m)" "$PASS" "$FAIL" "${FAILED:+ (failed:${FAILED#;})}"
[ "$FAIL" = 0 ]
