# Linux tests in Docker

Tests the **real** staged server (`release/staging/linux-<arch>`, the executable the desktop app runs as
its sidecar), the desktop AppImage and the Playwright suite on Linux, from any machine with Docker
(written on Docker Desktop, arm64 Mac; `@amd64` targets run emulated and are slower). Nothing here
changes the build output.

| Script | What it runs |
| --- | --- |
| `obs.sh` | Section 1: real OBS Studio (Ubuntu 24.04 package, obs-websocket) headless under Xvfb + Mesa llvmpipe, streaming to the staged server in the same container |
| `e2e.sh` | Section 2: the Playwright suite (Firefox, Chromium) in `mcr.microsoft.com/playwright:v<version>-noble` (version read from `package-lock.json`) |
| `appimage.sh` | Section 3: the desktop AppImage on a minimal Ubuntu 22.04/24.04 and Debian 12 that has only the host packages the website's Linux page lists |

## In CI

`.github/workflows/_docker.yml` runs them natively on `ubuntu-24.04` (x64) and
`ubuntu-24.04-arm` (arm64), no emulation. It is the `docker` stage of `pipeline.yml`, so the
required `ci-ok` check fails with it, on pull requests and `main` that touch this folder, the
Docker workflows, `pipeline.yml`, the e2e specs and server (`apps/server/test/e2e/`) or
`playwright.config.ts`; `linux-docker.yml` runs it weekly and by hand
(`gh workflow run linux-docker.yml --ref <branch>`). A build job stages the server and makes the
AppImage of the commit for each architecture (on Ubuntu 22.04, like the release); then one job per
base image and architecture runs `appimage.sh`, one per architecture `obs.sh`, and one per
architecture `e2e.sh`.

### Test images

The images (`Dockerfile.*`: the test's scaffolding, installed with `apt-get`) are built in each
job by `build.sh`, with no layer cache: a weekly job outlives GitHub's 7-day cache eviction, and
the repository's 10 GB cache is full. So each job depends on the distribution's mirror at that
moment, and `build.sh` makes a failure explain itself and survive one hiccup:

- `apt-get` retries a connection 5 times with a 30 s time limit, and `apt-get update` fails on
  any index it could not fetch (`APT::Update::Error-Mode=any`; by default it only warns and the
  install then fails with "Unable to locate package"), so the log names the broken index;
- the whole BuildKit log (`--progress=plain`, apt's own lines) is printed when a build fails;
- a failed build is tried once more after 60 s (`BUILD_RETRY_PAUSE`), with `--no-cache`; a second
  failure fails the suite with both logs. Infra recovery, not a test retry (the rules in
  `.github/workflows/README.md`): only the scaffolding image is rebuilt, never a step that runs
  SwarmCast.

Why: pipeline run 41273197813 (a 10-pipeline stability batch, 2026-11-01 05:38 UTC) lost
`docker / ubuntu:24.04 x64` when `apt-get` exited with 100 while building a test image (the start
script suite's, removed since), and `docker build -q` hid apt's message. The whole step took 22 s, two pulls and two earlier builds
included, while apt's retries of a network error take 31 s by themselves (a 404 fails in 2 s): the
error was one apt does not retry (a 404, a hash or size mismatch, an inconsistent index), so a
mirror serving a half-synchronised archive, not a slow or refused connection. The other docker
jobs of the batch ran one or two at a time, and the same run's OBS job built its Ubuntu 24.04 x64
image from the same mirror two minutes later.

A future option: prebuild the images on a schedule and pull them from GitHub's container
registry (ghcr.io), pinned by tag or digest, building only when a Dockerfile changed; then a run
would not touch the mirrors at all. It needs the package to be public (a private one has 500 MB
of free storage, less than these images), which only the repository owner can switch.

`obs.sh` takes the staged server from `release/staging/linux-<arch>` of this checkout (or the main
checkout; override with `--staging DIR`). Make it first: `npm run build && node scripts/build/package.mjs`.

## Section 1: `obs.sh`

```sh
scripts/test/docker/obs.sh            # Advanced output, x264, keyframe interval 2 s
scripts/test/docker/obs.sh --simple   # OBS Simple output defaults
```

`obs-test.sh` starts the staged server (mounted read-only, its own data folder in the container,
`--no-tunnel --no-open`), writes the OBS config (first-run wizard skipped via `global.ini`;
obs-websocket enabled without auth in both `global.ini` `[OBSWebSocket]` (obs-websocket ≤ 5.4,
OBS ≤ 30) and `plugin_config/obs-websocket/config.json` (5.5+)), starts OBS under `xvfb-run` with
`LIBGL_ALWAYS_SOFTWARE=1`, and drives it with `obs_ws.py` (a minimal obs-websocket v5 client):
scene + color source + media source (an ffmpeg-generated mp4), custom server
`rtmp://127.0.0.1:1935/live` + the stream key from `/api/state`, `StartStream`. It then checks
`live` / `obsConnected`, a curl viewer gets H.264 segments, `StopStream` returns to
`waiting-obs`, and SIGINT shuts everything down. Advanced output checks 2 s segments; with
`--simple` the keyframe interval is OBS's own default, so the segment length and the panel's
warnings are printed as information instead.

## Section 2: `e2e.sh`

```sh
scripts/test/docker/e2e.sh                 # firefox + chromium
scripts/test/docker/e2e.sh firefox
```

Copies the repo into the container (without `node_modules`, build output, `vendor/`), installs
ffmpeg, runs `npm ci`, `fetch-binaries.mjs` (detects linux-arm64), `npm run build`, prints the
H.264/AAC support of the bundled browsers (`codec-probe.mjs`), then runs each project with
`playwright.linux.config.ts`: the main config, but the chromium project has no `channel`
(Google Chrome does not exist for Linux arm64). Reports go to `test-results/docker-e2e/<project>/`,
with that project's `e2e-server.log` and `fake-obs.log` (CI uploads them when a project fails).
After every Playwright invocation, nothing of the e2e web server (its own process, the MediaMTX
and cloudflared it started) may still run 10 s after Playwright stopped it: a check that fails the
run (what is left is then killed, so the next invocation can bind its ports).

## Section 3: `appimage.sh`

```sh
scripts/test/docker/appimage.sh --version 0.2.2 release/desktop/linux-arm64/SwarmCast_0.2.2_aarch64.AppImage
scripts/test/docker/appimage.sh --platform linux/amd64 SwarmCast_0.2.2_amd64.AppImage ubuntu:24.04   # one base, emulated
```

The AppImage must match the container's architecture (the Docker host's, or `--platform`). `Dockerfile.appimage` is the bare base
image plus `HOST_PACKAGES` (the list on the website's Linux page: `libgl1 libegl1 fontconfig
fonts-dejavu-core libharfbuzz0b libfribidi0`), FUSE 2 (`libfuse2t64` or `libfuse2`), and the
test's own display and session tools (`xvfb xauth dbus`). There is no curl, Python or Node:
`appimage-test.sh` talks HTTP through bash's `/dev/tcp`, so the test adds no library the app could
quietly borrow. The container has no network (`--network none`) and no FUSE device, so the AppImage
runs with `APPIMAGE_EXTRACT_AND_RUN=1`. Under `xvfb-run` and `dbus-run-session` it checks: the
server starts (login URL), panel login, the panel page, `/api/desktop` (version), the shell logs
"ready, opening the panel", a `WebKitWebProcess` starts (the window has a webview), the app is
still running 5 s after opening the panel (a measured window: a crash while the webview loads
shows there), no "error while loading shared libraries" or panic, and Quit in the panel leaves
no process. Every other wait in these scripts is for its condition with a deadline (`lib.sh`).
When a base fails with a missing library, the list (here and on the website, both languages) is
what needs fixing. `libharfbuzz0b` and `libfribidi0` were found that way: AppImages leave them to
the host (the AppImage exclude list), and the v0.2.1 AppImage does not start without them.

## Cleanup

Remove the images the suites built:

```sh
docker rmi $(docker images -q 'swarmcast-test-*')
docker rmi mcr.microsoft.com/playwright:v1.64.1-noble
```
