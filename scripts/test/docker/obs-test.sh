#!/usr/bin/env bash
# Runs INSIDE a Dockerfile.obs container as "tester" (started by obs.sh).
# Installs SwarmCast with the real start script, starts it, runs OBS headless (Xvfb + llvmpipe)
# with obs-websocket, builds a scene with a media source over the websocket API, points the
# stream at SwarmCast and starts streaming, then checks the panel and a curl viewer.
#   RELEASE_URL  release folder URL (default: /release, served here on http://127.0.0.1:8000)
#   SCRIPT       start-linux.sh path (default /release/start-linux.sh)
#   OUTPUT_MODE  advanced (default: x264, 2 s keyframes, as the panel asks) or simple (OBS defaults)
#
# Not file:///release: start-linux.sh requires HTTP 200 for the checksum list, and curl reports
# no HTTP status (000) for file:// URLs, so the script calls the release server unreachable.
set -u
set -o pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"
RELEASE_URL="${RELEASE_URL:-}"
SCRIPT="${SCRIPT:-/release/start-linux.sh}"
OUTPUT_MODE="${OUTPUT_MODE:-advanced}"   # advanced (x264, keyframes every 2 s) | simple (OBS defaults)
WS="python3 /tests/obs_ws.py"
W="$(mktemp -d /tmp/sc-obs.XXXXXX)"
H="$W/home"
export NO_COLOR=1
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }
eq() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }

APP_PID=""
OBS_PID=""
HTTP_PID=""
finish() {
  [ -n "$OBS_PID" ] && kill "$OBS_PID" 2>/dev/null
  # SwarmCast stops everything itself on Ctrl+C: let it finish before the release server goes.
  [ -n "$APP_PID" ] && kill -INT "$APP_PID" 2>/dev/null && wait_for 45 gone "$APP_PID"
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null
}
trap finish EXIT

if [ -z "$RELEASE_URL" ]; then
  python3 -m http.server 8000 --bind 127.0.0.1 --directory /release >"$W/http.log" 2>&1 &
  HTTP_PID=$!
  RELEASE_URL="http://127.0.0.1:8000"
  wait_for 10 curl -fsS -o /dev/null "$RELEASE_URL/SHA256SUMS.txt" || { bad "release server on $RELEASE_URL did not start"; cat "$W/http.log"; exit 1; }
fi

echo "== versions"
echo "  $(. /etc/os-release && echo "$PRETTY_NAME") $(uname -m)"
echo "  OBS package: $(dpkg-query -W -f '${Version}' obs-studio)"
echo "  Mesa: $(dpkg-query -W -f '${Version}' libgl1-mesa-dri)"

echo "== install SwarmCast (start-linux.sh --install-only)"
env SWARMCAST_HOME="$H" SWARMCAST_RELEASE_URL="$RELEASE_URL" bash "$SCRIPT" --yes --skip-speedtest --install-only >"$W/install.txt" 2>&1
eq "$?" 0 "install exit code"
grep -E 'Installed SwarmCast|Already up to date|OBS Studio' "$W/install.txt" | sed 's/^/  > /'

echo "== start SwarmCast (start-linux.sh --no-tunnel)"
env SWARMCAST_HOME="$H" SWARMCAST_RELEASE_URL="$RELEASE_URL" setsid bash "$SCRIPT" --yes --no-tunnel --skip-speedtest >"$W/app.txt" 2>&1 </dev/null &
APP_PID=$!
wait_for 60 grep -qE 'http://127\.0\.0\.1:[0-9]+/auth/' "$W/app.txt" || { bad "no panel URL"; cat "$W/app.txt"; exit 1; }
LOGIN="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/auth/[A-Za-z0-9_-]+' "$W/app.txt" | head -n1)"
ADMIN="${LOGIN%/auth/*}"
curl -s -o /dev/null -c "$W/admin.jar" "$LOGIN"
state() { curl -fsS -b "$W/admin.jar" "$ADMIN/api/state"; }
phase_is() { [ "$(state 2>/dev/null | jq -r .phase)" = "$1" ]; }
wait_for 60 phase_is waiting-obs && ok "phase waiting-obs" || bad "phase $(state | jq -r .phase)"
KEY="$(state | jq -r .streamKey)"
RTMP="$(state | jq -r .rtmpUrl)"

echo "== test media"
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 20 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "$W/test.mp4" && ok "generated $W/test.mp4"

echo "== OBS config (skip the first-run wizard, enable obs-websocket without auth)"
C="$HOME/.config/obs-studio"
mkdir -p "$C/plugin_config/obs-websocket" "$C/basic/profiles/SwarmCast" "$C/basic/scenes"
cat >"$C/global.ini" <<'EOF'
[General]
FirstRun=true
LastVersion=503316482
EnableAutoUpdates=false
ConfirmOnExit=false

[Basic]
Profile=SwarmCast
ProfileDir=SwarmCast
SceneCollection=SwarmCast
SceneCollectionFile=SwarmCast
ConfigOnNewProfile=false

[BasicWindow]
SysTrayEnabled=false
WarnBeforeStartingStream=false
WarnBeforeStoppingStream=false

; obs-websocket 5.0-5.4 (OBS 28-30) read their settings here; 5.5+ (OBS 31+) use
; plugin_config/obs-websocket/config.json (written below as well).
[OBSWebSocket]
FirstLoad=false
ServerEnabled=true
ServerPort=4455
AlertsEnabled=false
AuthRequired=false
ServerPassword=
EOF
if [ "$OUTPUT_MODE" = advanced ]; then
  # What the SwarmCast panel asks for: x264 with a 2 s keyframe interval (Advanced output mode;
  # Simple mode has no keyframe setting).
  OUT_INI='[Output]
Mode=Advanced

[AdvOut]
Encoder=obs_x264
TrackIndex=1
ApplyServiceSettings=false'
  echo '{"bitrate":2500,"keyint_sec":2,"preset":"veryfast","rate_control":"CBR","profile":"high","tune":""}' >"$C/basic/profiles/SwarmCast/streamEncoder.json"
else
  OUT_INI='[Output]
Mode=Simple

[SimpleOutput]
StreamEncoder=x264
VBitrate=2500
ABitrate=128
Preset=veryfast'
fi
cat >"$C/basic/profiles/SwarmCast/basic.ini" <<EOF
[General]
Name=SwarmCast

$OUT_INI

[Video]
BaseCX=1280
BaseCY=720
OutputCX=1280
OutputCY=720
FPSType=0
FPSCommon=30

[Audio]
SampleRate=48000
EOF
cat >"$C/plugin_config/obs-websocket/config.json" <<'EOF'
{"alerts_enabled": false, "auth_required": false, "first_load": false, "server_enabled": true, "server_password": "", "server_port": 4455}
EOF

echo "== start OBS under Xvfb (LIBGL_ALWAYS_SOFTWARE=$LIBGL_ALWAYS_SOFTWARE)"
xvfb-run -a -s "-screen 0 1920x1080x24" bash -c 'glxinfo -B 2>/dev/null | grep -E "OpenGL renderer|OpenGL core profile version|OpenGL version"' | sed 's/^/  > /'
xvfb-run -a -s "-screen 0 1920x1080x24" obs --disable-shutdown-check --disable-missing-files-check --verbose >"$W/obs.txt" 2>&1 &
OBS_PID=$!
if wait_for 90 $WS GetVersion >/dev/null 2>&1; then
  ok "obs-websocket answers"
else
  bad "obs-websocket did not answer within 90 s"
  echo "  --- OBS output (last 60 lines) ---"; tail -n 60 "$W/obs.txt" | sed 's/^/  | /'
  LOG="$(ls -t "$C/logs/"*.txt 2>/dev/null | head -n1)"
  [ -n "$LOG" ] && { echo "  --- OBS log $LOG (errors) ---"; grep -iE 'error|fail|opengl|egl|glx' "$LOG" | head -n 40 | sed 's/^/  | /'; }
  printf '\nOBS RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi
V="$($WS GetVersion)"
echo "  OBS $(jq -r .obsVersion <<<"$V"), obs-websocket $(jq -r .obsWebSocketVersion <<<"$V"), platform $(jq -r .platformDescription <<<"$V")"
LOG="$(ls -t "$C/logs/"*.txt 2>/dev/null | head -n1)"
[ -n "$LOG" ] && grep -E 'Loading up OpenGL|OpenGL loaded|Renderer:|Version: [0-9]|EGL|GLX' "$LOG" | head -n 8 | sed 's/^/  log> /'

echo "== scene, media source and stream settings via obs-websocket"
$WS CreateScene '{"sceneName":"SwarmCast Test"}' >/dev/null && ok "CreateScene" || bad "CreateScene"
$WS SetCurrentProgramScene '{"sceneName":"SwarmCast Test"}' >/dev/null && ok "SetCurrentProgramScene" || bad "SetCurrentProgramScene"
$WS CreateInput '{"sceneName":"SwarmCast Test","inputName":"Background","inputKind":"color_source_v3","inputSettings":{"color":4278190335,"width":1280,"height":720}}' >/dev/null && ok "CreateInput color_source_v3" || bad "CreateInput color_source_v3"
$WS CreateInput "$(jq -nc --arg f "$W/test.mp4" '{sceneName:"SwarmCast Test",inputName:"Test video",inputKind:"ffmpeg_source",inputSettings:{local_file:$f,is_local_file:true,looping:true,restart_on_activate:true}}')" >/dev/null && ok "CreateInput ffmpeg_source (media source)" || bad "CreateInput ffmpeg_source"
$WS SetStreamServiceSettings "$(jq -nc --arg s "$RTMP" --arg k "$KEY" '{streamServiceType:"rtmp_custom",streamServiceSettings:{server:$s,key:$k}}')" >/dev/null && ok "SetStreamServiceSettings rtmp_custom $RTMP" || bad "SetStreamServiceSettings"
eq "$($WS GetStreamServiceSettings | jq -r .streamServiceSettings.server)" "$RTMP" "OBS stream server"
$WS StartStream >/dev/null && ok "StartStream" || bad "StartStream"
stream_active() { [ "$($WS GetStreamStatus 2>/dev/null | jq -r .outputActive)" = true ]; }
wait_for 30 stream_active && ok "OBS output active" || bad "OBS output not active"

echo "== SwarmCast sees OBS"
wait_for 60 phase_is live && ok "phase live" || bad "phase $(state | jq -r .phase)"
eq "$(state | jq -r .obsConnected)" "true" "obsConnected true"
LINK="$(state | jq -r .liveLink)"
BASE="${LINK%/join/*}"
# curl cannot solve the browser check (on by default since v0.2): check the default, then turn it off from the panel API.
eq "$(state | jq -r .security.settings.requireBrowserCheck)" "true" "browser check on by default"
eq "$(curl -s -o /dev/null -X PUT -b "$W/admin.jar" -H "origin: $ADMIN" -H 'content-type: application/json' -d "$(state | jq -c '.security.settings | .requireBrowserCheck = false')" -w '%{http_code}' "$ADMIN/api/security")" "200" "browser check turned off for the curl viewer"
J="$W/viewer.jar"
curl -s -o /dev/null -c "$J" -b "$J" "$LINK"
eq "$(curl -s -o /dev/null -c "$J" -b "$J" -H 'content-type: application/json' -d '{"nickname":"obs-viewer"}' -w '%{http_code}' "$BASE/api/join")" "200" "viewer joined"
got_pl() { [ "$(curl -s -o "$W/index.m3u8" -b "$J" -w '%{http_code}' "$BASE/hls/index.m3u8")" = 200 ]; }
wait_for 30 got_pl && ok "GET /hls/index.m3u8 -> 200" || bad "no playlist"
PL="$W/index.m3u8"
ITEM="$(grep -v '^#' "$PL" | grep -v '^$' | tail -n1)"
case "$ITEM" in *.m3u8) curl -s -b "$J" -o "$W/child.m3u8" "$BASE/hls/$ITEM"; PL="$W/child.m3u8"; ITEM="$(grep -v '^#' "$PL" | grep -v '^$' | tail -n1)" ;; esac
INIT="$(grep -oE 'URI="[^"]+"' "$PL" | head -n1 | sed 's/URI="\(.*\)"/\1/')"
curl -s -b "$J" -o "$W/init.mp4" "$BASE/hls/$INIT"
R="$(curl -s -b "$J" -o "$W/seg.mp4" -w '%{http_code} %{size_download}' "$BASE/hls/$ITEM")"
if [ "${R% *}" = 200 ] && [ "${R#* }" -gt 1000 ]; then ok "segment $ITEM -> 200 (${R#* } bytes)"; else bad "segment $ITEM -> $R"; fi
grep -E '#EXT-X-TARGETDURATION|#EXTINF' "$PL" | head -n 3 | sed 's/^/  pl> /'
TD="$(sed -n 's/^#EXT-X-TARGETDURATION://p' "$PL" | head -n1)"
if [ "$OUTPUT_MODE" = advanced ]; then
  if [ "${TD:-99}" -le 3 ]; then ok "segments ~2 s (TARGETDURATION $TD) with OBS keyframe interval 2 s"; else bad "TARGETDURATION $TD with keyframe interval 2 s"; fi
else
  # Information, not a check: in Simple output mode the keyframe interval is OBS's own default
  # (the panel's setup asks for Advanced output with keyframes every 2 s).
  echo "  INFO: Simple output mode: TARGETDURATION ${TD:-?} s; panel warnings: $(state | jq -c '[.warnings[].code]')"
fi
cat "$W/init.mp4" "$W/seg.mp4" >"$W/joined.mp4"
PROBE="$(ffprobe -v error -show_entries stream=codec_name,codec_type,width,height -of csv=p=0 "$W/joined.mp4" | tr '\n' ' ')"
echo "  ffprobe of init+segment: $PROBE"
case "$PROBE" in *h264,video,1280,720*) ok "segment is H.264 1280x720 (from OBS)" ;; *) bad "unexpected segment streams: $PROBE" ;; esac
echo "  panel warnings: $(state | jq -c .warnings)"
S="$($WS GetStats)"
echo "  OBS stats: fps $(jq -r '.activeFps|floor' <<<"$S"), render skipped $(jq -r .renderSkippedFrames <<<"$S")/$(jq -r .renderTotalFrames <<<"$S"), output skipped $(jq -r .outputSkippedFrames <<<"$S")/$(jq -r .outputTotalFrames <<<"$S"), cpu $(jq -r '.cpuUsage|floor' <<<"$S")%"
SS="$($WS GetStreamStatus)"
echo "  OBS stream: $(jq -r .outputTimecode <<<"$SS"), $(jq -r .outputBytes <<<"$SS") bytes, congestion $(jq -r .outputCongestion <<<"$SS")"

echo "== StopStream -> SwarmCast goes back to waiting-obs"
$WS StopStream >/dev/null && ok "StopStream" || bad "StopStream"
wait_for 30 phase_is waiting-obs && ok "phase back to waiting-obs" || bad "phase $(state | jq -r .phase)"
eq "$(state | jq -r .obsConnected)" "false" "obsConnected false"

echo "== shut down"
kill "$OBS_PID" 2>/dev/null; wait "$OBS_PID" 2>/dev/null; OBS_PID=""
kill -INT "$APP_PID"
wait_for 45 gone "$APP_PID" && ok "SwarmCast exited" || bad "SwarmCast still running"
APP_PID=""
grep -q "Off: nothing on your computer is reachable" "$W/app.txt" && ok "printed the Off line" || bad "no Off line"
pgrep -x mediamtx >/dev/null && bad "mediamtx still running" || ok "no mediamtx left"

printf '\nOBS RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
