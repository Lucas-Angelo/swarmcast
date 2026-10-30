#!/usr/bin/env bash
# Runs INSIDE a Dockerfile.appimage container as "tester" (started by appimage.sh).
# The AppImage on a minimal host: copy it to ~/Applications, start it under Xvfb with a D-Bus
# session, then check that its server starts, the panel login works, /api/desktop answers with
# the expected version, the shell opens the panel, and "Quit" ends every process.
#
# Env:
#   APPIMAGE_FILE  the AppImage inside the container (required)
#   EXPECT_VER     expected version (optional; checked when set)
#
# Containers have no FUSE, so the AppImage runs with APPIMAGE_EXTRACT_AND_RUN=1 (the AppImage
# runtime's own fallback). The FUSE 2 package is still installed: the website tells people to.
# HTTP goes through bash's /dev/tcp, so no HTTP client (and none of its libraries) is installed.
set -u
set -o pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"

APPIMAGE_FILE="${APPIMAGE_FILE:?APPIMAGE_FILE is required}"
# Measured: the app must still run this long after it opened the panel (a crash while the
# webview loads it shows here). The one wait that is a duration, on purpose.
ALIVE_AFTER_PANEL_S=5
EXPECT_VER="${EXPECT_VER:-}"
W="$(mktemp -d /tmp/sc-appimage.XXXXXX)"
LOGIN="$W/login.txt"
DESKTOP_LOG="$HOME/.local/share/swarmcast/logs/desktop.log"
FAIL=0
ok() { printf 'PASS %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; FAIL=$((FAIL + 1)); }

# http METHOD PORT PATH [COOKIE]: prints the raw response (status line, headers, body).
http() {
  local m="$1" port="$2" p="$3" cookie="${4:-}" extra=""
  [ -n "$cookie" ] && extra+="Cookie: $cookie"$'\r\n'
  [ "$m" != GET ] && extra+="Origin: http://127.0.0.1:$port"$'\r\n'"Content-Type: application/json"$'\r\n'"Content-Length: 2"$'\r\n'
  exec 3<>"/dev/tcp/127.0.0.1/$port" || return 1
  printf '%s %s HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n%s\r\n' "$m" "$p" "$port" "$extra" >&3
  [ "$m" != GET ] && printf '{}' >&3
  timeout 15 cat <&3
  exec 3<&-
}
status_of() { head -n1 | awk '{ print $2 }'; }
# Processes of the app (shell, server, MediaMTX, cloudflared), from /proc (no procps).
app_procs() {
  local d c
  for d in /proc/[0-9]*; do
    c="$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null)" || continue
    case "$c" in *swarmcast-desktop* | *swarmcast-server* | */mediamtx* | */cloudflared* | *SwarmCast_*.AppImage* | *WebKit*Process*) printf '%s %s\n' "${d#/proc/}" "$c" ;; esac
  done
}

echo "== host"
# shellcheck disable=SC1091
echo "  $(. /etc/os-release && echo "$PRETTY_NAME") $(uname -m), glibc $(ldd --version | head -n1 | awk '{ print $NF }')"
echo "  $(dpkg-query -W -f '${db:Status-Abbrev}\n' | grep -c '^ii') packages installed"

mkdir -p "$HOME/Applications"
app="$HOME/Applications/$(basename "$APPIMAGE_FILE")"
cp "$APPIMAGE_FILE" "$app"
chmod +x "$app"
# Emulated runs (appimage.sh --platform): the AppImage magic bytes at offset 8 keep the kernel's
# binfmt emulator from recognising the ELF file ("ELFAI: not found"). Zeroing them in this copy
# is the usual workaround; the AppImage runtime does not need them.
[ "${CLEAR_APPIMAGE_MAGIC:-0}" = 1 ] && printf '\0\0\0' | dd of="$app" bs=1 seek=8 count=3 conv=notrunc status=none

echo "== start $(basename "$app") under Xvfb + dbus-run-session"
APPIMAGE_EXTRACT_AND_RUN=1 SWARMCAST_TEST_LOGIN_FILE="$LOGIN" SWARMCAST_NO_OPEN=1 SWARMCAST_NO_FFMPEG_INSTALL=1 \
  NO_AT_BRIDGE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- "$app" >"$W/app.log" 2>&1 &
RUNNER_PID=$!

finish() {
  echo
  echo "== app output (tail)"
  tail -n 40 "$W/app.log" | sed 's/^/  | /'
  echo "== desktop.log (tail)"
  tail -n 40 "$DESKTOP_LOG" 2>/dev/null | sed 's/^/  | /'
  kill "$RUNNER_PID" 2>/dev/null
}
trap finish EXIT

started() { test -s "$LOGIN" || ! kill -0 "$RUNNER_PID" 2>/dev/null; }
if wait_for 120 started && test -s "$LOGIN"; then ok "the server started (login URL written)"; else
  bad "no login URL (the app or its server did not start)"
  exit 1
fi
url="$(cat "$LOGIN")"
rest="${url#http://127.0.0.1:}"
port="${rest%%/*}"
path="/${rest#*/}"

r="$(http GET "$port" "$path")"
code="$(status_of <<<"$r")"
cookie="$(grep -i '^set-cookie:' <<<"$r" | head -n1 | sed -E 's/^[^:]+: *//; s/;.*//' | tr -d '\r')"
if [ "${code:-999}" -lt 400 ] && [[ "$cookie" == *=* ]]; then ok "panel login (HTTP $code)"; else bad "panel login (HTTP ${code:-none}, cookie '${cookie}')"; fi

r="$(http GET "$port" / "$cookie")"
code="$(status_of <<<"$r")"
if [ "$code" = 200 ] && grep -q '<html' <<<"$r"; then ok "panel page loads behind the login"; else bad "panel page (HTTP ${code:-none})"; fi

r="$(http GET "$port" /api/desktop "$cookie")"
code="$(status_of <<<"$r")"
body="$(sed '1,/^\r\{0,1\}$/d' <<<"$r")"
ver="$(grep -oE '"version":"[^"]+"' <<<"$body" | head -n1 | cut -d'"' -f4)"
if [ "$code" = 200 ] && grep -q '"desktop":true' <<<"$body" && { [ -z "$EXPECT_VER" ] || [ "$ver" = "$EXPECT_VER" ]; }; then
  ok "/api/desktop reports the desktop app ($ver)"
else
  bad "/api/desktop (HTTP ${code:-none}, version '${ver}', expected '${EXPECT_VER:-any}')"
fi

if wait_for 30 grep -qF 'ready, opening the panel' "$DESKTOP_LOG"; then ok "the shell opens the panel in its window"; else bad "the shell never logged 'ready, opening the panel'"; fi
web_process() { [[ "$(app_procs)" == *WebKitWebProcess* ]]; }
if wait_for 30 web_process; then ok "WebKitGTK started its web process (the window has a webview)"; else bad "no WebKitWebProcess within 30 s: the window has no webview"; fi
sleep "$ALIVE_AFTER_PANEL_S"
if [[ "$(app_procs)" == *swarmcast-desktop* ]]; then ok "the app is still running $ALIVE_AFTER_PANEL_S s later"; else bad "the app exited after opening the panel"; fi
if grep -E 'error while loading shared libraries|cannot open shared object|panicked at' "$W/app.log" "$DESKTOP_LOG" 2>/dev/null; then bad "missing library or panic in the output (above)"; else ok "no missing library or panic in the output"; fi
grep -F 'no tray icon' "$DESKTOP_LOG" 2>/dev/null | sed 's/^/INFO /'

r="$(http POST "$port" /api/app/quit "$cookie")"
code="$(status_of <<<"$r")"
if [ "$code" = 200 ]; then ok "Quit in the panel (HTTP 200)"; else bad "Quit in the panel (HTTP ${code:-none})"; fi
none_left() { [ -z "$(app_procs)" ]; }
if wait_for 30 none_left; then ok "nothing left running after Quit"; else bad "processes left after Quit:"; app_procs | sed 's/^/  /'; fi

echo
if [ "$FAIL" = 0 ]; then echo "AppImage minimal host: all checks passed"; else echo "AppImage minimal host: $FAIL failed"; fi
[ "$FAIL" = 0 ]
