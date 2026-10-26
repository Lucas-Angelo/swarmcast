# Real OBS + Cloudflare quick tunnel end-to-end test (macOS)

A manual, "like a person" end-to-end test of SwarmCast with **real** components:

- **OBS Studio** (tested with 33.0.0, obs-websocket 5.7.6) streaming over RTMP, driven through its
  built-in obs-websocket server — no SwarmCast code is used to configure OBS;
- **SwarmCast** in dev mode (`node --import tsx apps/server/src/main.ts`) with the **real Cloudflare
  quick tunnel** (`https://*.trycloudflare.com`);
- **real browsers** through the tunnel via Playwright: Google Chrome (`channel: 'chrome'`), Firefox,
  WebKit, plus iPhone 15 (WebKit) and Pixel 7 (Chrome) emulation.

It is not part of CI (it needs OBS, a GUI session and internet access).

## Prerequisites

- macOS on Apple Silicon (paths assume `/Applications/OBS.app`; override with `OBS_BIN=...`).
- Node ≥ 22.12, `ffmpeg` on `PATH` (`brew install ffmpeg`).
- OBS Studio: `brew install --cask obs`.
- Google Chrome in `/Applications` and Playwright browsers: `npx playwright install chromium firefox webkit`.
- From the repo root:
  ```sh
  npm install
  node scripts/build/fetch-binaries.mjs          # MediaMTX + cloudflared into vendor/<platform>/
  npm run build -w @swarmcast/shared -w @swarmcast/viewer -w @swarmcast/admin
  (cd scripts/test/obs-e2e && npm install)       # obs-websocket-js (kept out of the root lockfile)
  ```
- Free ports: 41935 (RTMP), 48080 (public), 48081 (admin), 48888 (MediaMTX HLS), 4455 (obs-websocket).
  These are deliberately not SwarmCast's defaults so the test can run next to other work.

## OBS configuration (`setup-obs.mjs`)

`run.mjs` calls `setup-obs.mjs` automatically. **It only writes OBS files when
`~/Library/Application Support/obs-studio` does not exist yet** (pass `--force` to `setup-obs.mjs`
to overwrite — this replaces your OBS settings!). When OBS is already configured it just reads the
obs-websocket password from `plugin_config/obs-websocket/config.json`; in that case make sure the
WebSocket server is enabled (Tools → WebSocket Server Settings) and that a profile and scene
collection called `SwarmCast` exist, or edit `OBS_FLAGS` in `run.mjs`.

Files it creates (all under `~/Library/Application Support/obs-studio/`):

| File | Purpose |
| --- | --- |
| `global.ini`, `user.ini` | `[General] FirstRun=true`, `LastVersion=553648128` (33.0.0), `MacOSPermissionsDialogLastShown=1`, `EnableAutoUpdates=false`: no auto-config wizard, no macOS permissions dialog, no "What's new". `[Basic]` selects the `SwarmCast` profile and scene collection. |
| `plugin_config/obs-websocket/config.json` | `{"server_enabled": true, "server_port": 4455, "auth_required": true, "server_password": "<random>", "first_load": false, "alerts_enabled": false}` |
| `basic/profiles/SwarmCast/basic.ini` | `[Output] Mode=Advanced`, `[AdvOut] Encoder=obs_x264`, `[Video]` 1280x720 @ 30 fps |
| `basic/profiles/SwarmCast/streamEncoder.json` | Advanced → Streaming encoder: `{"rate_control":"CBR","bitrate":2500,"keyint_sec":2,"preset":"veryfast","profile":"high"}` (obs-websocket has no request to edit encoder settings) |
| `basic/scenes/SwarmCast.json` | one empty scene, no global audio devices (avoids microphone / screen-recording prompts) |

It also generates `artifacts/testsrc-720p30.mp4` (ffmpeg `testsrc2` + 1 kHz tone, 60 s) for an OBS
**Media Source** (looping), which needs no macOS permission.

OBS is started as
`/Applications/OBS.app/Contents/MacOS/OBS --disable-updater --disable-missing-files-check --minimize-to-tray --profile SwarmCast --collection SwarmCast --scene SwarmCast`
(OBS 33 has no `--disable-shutdown-check`; an unclean exit leaves `.sentinel/run_<uuid>` and makes the
next start offer Safe Mode, so the script quits exactly its own OBS process with the standard macOS quit
event — `osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(<pid>).terminate'`
— after stopping the stream and the Media Source, and removes stale sentinels before launching.
Do not use `osascript -e 'quit app "OBS"'`: it answers -128 and was seen to quit OBS and then
**relaunch** it through LaunchServices. The script refuses to start when an OBS is already running
(OBS is single-instance; a second copy exits and the script would drive the old one). OBS 33.0.0 was seen to segfault once on quit inside the Media Source thread
(`mp_media_thread` → `obs_source_output_audio`); that is an OBS bug, reported in the quit step.)

Over obs-websocket the script then: sets video to 1280x720@30, creates the Media Source, sets
`Output/Mode=Advanced` and `AdvOut/Encoder=obs_x264` (profile parameters), sets the stream service to
`rtmp_custom` with **server = the panel's RTMP URL** (`rtmp://127.0.0.1:41935/live`) and **key = the
panel's stream key**, and calls `StartStream`.

## Running

```sh
node scripts/test/obs-e2e/run.mjs              # full run, ~6–9 minutes
node scripts/test/obs-e2e/run.mjs --dns-shim   # skip the unmodified start attempt (see below)
node scripts/test/obs-e2e/run.mjs --no-dns-shim # never use the shim (fail if the unmodified start fails)
node scripts/test/obs-e2e/run.mjs --skip-bonus # without the OBS stop/start and Simple-mode checks
SC_DATA_DIR=/some/dir node scripts/test/obs-e2e/run.mjs   # choose the SwarmCast data dir
```

### The DNS negative-cache shim

On many networks the very first "Start" fails with *"The tunnel was created but its address does not
answer"*: SwarmCast probes `https://<new>.trycloudflare.com/healthz` the instant cloudflared prints
the address, before the DNS record exists; the local resolver (home router / ISP) caches that
NXDOMAIN (~80 s measured here, while 1.1.1.1 already answered after ~2 s), which outlasts the 60 s
reachability timeout, and the retry with a new tunnel hits the same problem. The script first starts
SwarmCast unmodified (this step **fails** while the bug exists) and then restarts it with
`dns-negative-cache-shim.mjs` preloaded (`node --import`), which only delays the first `fetch()` to
each new `*.trycloudflare.com` host by 4 s — the suggested app fix. Delete the shim once the app is
fixed.

### Step statuses

`PASS`, `FAIL`, or `BLOCKED` (the environment, not SwarmCast, prevented the check — e.g. Playwright's
Firefox build does not start at all on macOS 27: *"Could not find profile folder."*). When Firefox is
blocked, the cross-engine P2P check falls back to WebKit ↔ Chrome.

Output: a PASS/FAIL line per step on stdout and `artifacts/report.json` (all numbers), plus
`artifacts/swarmcast.log`, `artifacts/obs.log`, `artifacts/panel-chrome.png`,
`artifacts/viewer-*.png`. `artifacts/` is git-ignored.

At the end the script closes the browsers, stops OBS streaming, quits OBS, stops SwarmCast (SIGINT)
and lists any `mediamtx`/`cloudflared` process still running for its data dir / ports.

## What it checks

1. SwarmCast starts with a real quick tunnel: the panel state gets a
   `https://<random>.trycloudflare.com/join/<secret>` link and `phase: waiting-obs`; `/healthz` answers
   through the tunnel with an `X-SwarmCast` header.
2. A viewer opens the link **before** OBS streams (sees "Waiting for the stream…"); OBS, configured only
   through obs-websocket + its own config files, then streams to SwarmCast: panel shows
   `obsConnected: true`, `obsBitrateKbps > 0`, `phase: live`; that early viewer must start playing
   without reloading the page.
3. After ~35 s (so the live playlist fills up) every browser opens the live link, types a nickname and
   reaches playback (`video.currentTime` advancing). Time-to-first-frame is recorded per browser
   (page open → first frame, and "Watch" click → first frame). The panel lists the viewers and detects
   the emulated phones as `mobile`.
4. The media playlist has ~2 s segments (proves the 2 s keyframe interval reached the packager).
5. P2P through the tunnel: two Chrome viewers with P2P on see each other (`window.__swarmcast.stats.peers`)
   and download video from each other (`p2pDownBytes > 0`, no hash failures); then Firefox ↔ Chrome.
6. WebSockets work over the quick tunnel: `wss://<tunnel>/control` and `wss://<tunnel>/tracker` open and
   receive frames.
7. Viewer pages talk only to the tunnel host (every HTTP request and WebSocket is recorded; STUN is not
   visible to Playwright).
8. The admin panel renders in Chrome after `/auth/<token>` (screenshot).
9. Bonus: OBS stops and restarts streaming mid-live → the panel goes `waiting-obs` → `live` and viewers
   resume playing. Then a tutorial check: a temporary `SwarmCastSimple` profile in OBS **Simple**
   output mode (x264, 2500 kbps, veryfast) streams for 30 s; the x264 `keyint` OBS logs and the segment
   lengths viewers get are recorded (`report.json` → `obs.simpleMode`), then the profile is removed.
10. Kicking a viewer from the admin API shows "You were removed" and the link no longer works for that
    device; "Generate new link" invalidates the old link and the new one plays.
11. No HTTP 429 from the tunnel/origin at this scale.
12. "Stop everything" returns `verified: true`, viewers see "The stream has ended", the trycloudflare URL
    stops answering (or answers without `X-SwarmCast`), OBS notices the lost connection, and OBS quits
    cleanly.

## Findings from the first runs (2026-10-25, macOS 27.0.1, OBS 33.0.0)

- Unmodified "Start" failed on this network (DNS negative caching, see above).
- A viewer who opens the link before OBS is live (or while OBS is reconnecting) stays on "Waiting for
  the stream…" forever: `/hls/index.m3u8` answers 404, hls.js never retries 4xx manifest errors, and
  the viewer's recovery only calls `hls.startLoad()`, which cannot recover a failed manifest load.
- OBS **Simple** output mode with x264 sends a keyframe every 250 frames (8.3 s at 30 fps), giving
  8.3 s segments. Use **Advanced** output mode with *Keyframe Interval = 2 s* (gives 2.000 s segments).
- One transient burst of Cloudflare 502s (~5 s) was seen when cloudflared's single QUIC connection hit
  "no recent network activity"; it recovered on the same URL by itself.
- Viewer consoles show `connect-src contains an invalid source: 'stun:stun.cloudflare.com:3478'` (CSP).
- Playwright's Firefox does not start on macOS 27 (environment problem; reported as BLOCKED).
- When SwarmCast's stdout is a pipe whose reader dies, every log write fails with EPIPE, the
  `uncaughtException` handler logs that (to stdout again) and the process loops forever instead of
  shutting down (11 MB of "fatal EPIPE" in a minute; MediaMTX left running until the process is killed,
  after which the reaper cleans up correctly). The runner now gives SwarmCast a file as stdout.
- OBS 33.0.0 itself: one segfault on quit (Media Source thread) and one deadlock in `obs_reset_video`
  after `CreateProfile` + `SetVideoSettings` over obs-websocket in quick succession. The runner avoids
  both (pre-created second profile, Media Source stopped before quitting, request timeouts).

Note: `/api/join` is rate-limited to 10 joins per minute per client IP, and through the tunnel every
browser here has the same public IP, so the script spaces joins out (max 8 per rolling minute).
