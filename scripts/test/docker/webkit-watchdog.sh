#!/usr/bin/env bash
# Inside the container of webkit.sh watchdog: builds the desktop shell (debug) from /src, runs it
# with the mock server (/mock-server.mjs) whose first $LOSE answers of /auth/<token> never come,
# and checks that the panel opens anyway (the mock's panel page reports its language).
set -u
# shellcheck source-path=SCRIPTDIR source=lib.sh
. /tests/lib.sh
LOSE="${LOSE:-1}"
work="$HOME/work"
mkdir -p "$work/apps" "$work/assets"
rsync -a --delete --exclude target --exclude node_modules /src/apps/desktop/ "$work/apps/desktop/"
rsync -a /src/assets/brand/ "$work/assets/brand/"
cp /mock-server.mjs "$work/apps/desktop/test/mock-server.mjs"
chmod +x "$work/apps/desktop/test/mock-server.mjs"
cd "$work/apps/desktop/src-tauri" || exit 2
echo "building the desktop shell (debug)"
cargo build --locked -q || exit 2
data="$(mktemp -d)"
log="$data/logs/desktop.log"
# Every wait below is the watchdog's own schedule (5 s, 10 s, 20 s, 30 s) plus 15 s.
waits=(5 10 20 30)
deadline=15
for ((i = 0; i < LOSE; i++)); do deadline=$((deadline + waits[i < 3 ? i : 3])); done
# No update check against the real feed: an address that refuses (an automatic check that
# fails is silent, docs/DESKTOP.md "Updates").
SWARMCAST_SIDECAR="$work/apps/desktop/test/mock-server.mjs" SWARMCAST_DATA_DIR="$data" SWARMCAST_NO_OPEN=1 \
  SWARMCAST_NO_NOTIFY=1 SWARMCAST_UPDATE_URL=https://127.0.0.1:9/latest.json \
  MOCK_LOSE_PANEL_LOADS="$LOSE" MOCK_AUTOSTART=0 MOCK_LOG_REQUESTS=1 \
  dbus-run-session -- xvfb-run -a target/debug/swarmcast-desktop >"$data/app.out" 2>&1 &
app=$!
panel_opened() { grep -q 'mock-report language=' "$log" 2>/dev/null; }
wait_for "$deadline" panel_opened
opened=$?
# The token never leaves the container, but keep it out of the output all the same.
grep -E '\[desktop\] |holding panel|answering the panel|http GET /(auth|$)|mock-report language' "$log" | sed -E 's#/auth/[0-9a-f]+#/auth/<token>#'
kill "$app" 2>/dev/null
wait_for 10 gone "$app" || kill -9 "$app" 2>/dev/null
renavigations="$(grep -c 'did not open within .*, opening it again' "$log")"
if [ "$opened" != 0 ]; then
  echo "FAIL: the panel did not open within $deadline s ($LOSE lost load(s), $renavigations new navigation(s))"
  exit 1
fi
if [ "$renavigations" != "$LOSE" ]; then
  echo "FAIL: the panel opened after $renavigations new navigation(s), expected $LOSE (one per lost load)"
  exit 1
fi
echo "PASS: the panel opened after $LOSE lost load(s), through $renavigations new navigation(s) of the watchdog"
