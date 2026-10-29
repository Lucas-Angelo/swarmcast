# Linux tests in Docker

Tests the **real** release (start script + packaged app) and the Playwright suite on Linux,
from any machine with Docker (written on Docker Desktop, arm64 Mac; `@amd64` targets run
emulated and are slower). Nothing here changes the release folder.

| Script | What it runs |
| --- | --- |
| `run.sh` | Section 1: `start-linux.sh` + the real `SwarmCast-v*-linux-*.tar.gz` on Ubuntu 22.04/24.04, Debian 12 (the host's architecture) and Ubuntu 24.04 (amd64), plus the real Cloudflare quick tunnel |
| `obs.sh` | Section 2: real OBS Studio (Ubuntu 24.04 package, obs-websocket) headless under Xvfb + Mesa llvmpipe, streaming to SwarmCast in the same container |
| `e2e.sh` | Section 3: the Playwright suite (Firefox, Chromium) in `mcr.microsoft.com/playwright:v<version>-noble` (version read from `package-lock.json`) |
| `appimage.sh` | Section 4: the desktop AppImage on a minimal Ubuntu 22.04/24.04 and Debian 12 that has only the host packages the website's Linux page lists |

## In CI

`.github/workflows/_docker.yml` runs all four natively on `ubuntu-24.04` (x64) and
`ubuntu-24.04-arm` (arm64), no emulation. It is the `docker` stage of `pipeline.yml`, so the
required `ci-ok` check fails with it, on pull requests and `main` that touch this folder,
`start-linux.sh`, `uninstall-linux.sh`, the Docker workflows, `pipeline.yml`, the e2e specs and
server (`apps/server/test/e2e/`) or `playwright.config.ts`; `linux-docker.yml` runs it weekly
and by hand (`gh workflow run linux-docker.yml --ref <branch>`). A build job makes the package and the
AppImage of the commit for each architecture (on Ubuntu 22.04, like the release); then one job
per base image and architecture runs `run.sh --serial <base>` and `appimage.sh`. The tunnel
check (d) runs on the weekly schedule only (Ubuntu 24.04, the `tunnel-test` input), because Cloudflare rate-limits quick
tunnels. The images are built in each job (no layer cache: a weekly job outlives GitHub's 7-day
cache eviction, and the repository's cache is full); their `apt-get` uses retries and a 30 s
time limit per connection.

The release folder defaults to `<main checkout>/release` (override with `--release DIR` or
`RELEASE_DIR`). Build it first (`npm run package` for each target, plus `SHA256SUMS.txt`).

## Section 1: `run.sh`

```sh
scripts/test/docker/run.sh                      # all targets in parallel + tunnel test
scripts/test/docker/run.sh --serial debian:12   # one target
scripts/test/docker/run.sh --no-build --tunnel-only ubuntu:24.04
```

The release is served over HTTP by a `python:3.12-alpine` container on a private Docker
network (`http://release:8000/ok`). A second folder (`/corrupt`) lists a newer version
(`99.0.0`, a link to the real package) with a wrong SHA-256. Per target:

- **a.** `Dockerfile.bare` (no curl, no sudo): the script must name the missing tool and stop.
- **b.** `Dockerfile.bare` + passwordless sudo: with `--yes` the script installs curl with
  `sudo apt-get` and the smoke test passes.
- **c.** `Dockerfile.install` runs `install-test.sh` as a non-root user:
  1. clean install + the real `swarmcast --smoke-test` (MediaMTX + local public server)
  2. second run through `curl … | bash`: "Already up to date", nothing downloaded
  3. corrupted checksum on update: aborts, installed files byte-identical, no `previous/`;
     3b. on a clean install: nothing installed
  4. normal start in the background: panel login (`/auth/<token>` → 200 + cookie), panel 200,
     `/api/state` phase `waiting-obs`, ffmpeg RTMP push → `live` + `obsConnected`, viewer join
     flow with curl (link → 303 + ticket cookie, `POST /api/join`, playlist, init + media
     segment 200), SIGINT → "Off: nothing on your computer is reachable", no MediaMTX left,
     ports closed
  5. the same shutdown with SIGTERM
  6. SIGKILL of the app: the reaper must stop MediaMTX
- **d.** (first target only, or `--tunnel-all`) the real quick tunnel: the
  `https://*.trycloudflare.com/join/…` link must answer `/healthz` with 200 + `x-swarmcast`
  **from the host**, the live link must redirect to `/join`, and the URL must stop answering
  after Ctrl+C.

The tunnel container uses `--dns 1.1.1.1` by default. With Docker Desktop's own resolver the
app never gets a working tunnel: its first `/healthz` probe happens before the new hostname
exists, the resolver caches the NXDOMAIN for the zone's 60 s negative TTL, and the app gives up
after 60 s (twice). Use `--tunnel-docker-dns` to reproduce that.

## Section 2: `obs.sh`

```sh
scripts/test/docker/obs.sh            # Advanced output, x264, keyframe interval 2 s
scripts/test/docker/obs.sh --simple   # OBS Simple output defaults
```

`obs-test.sh` serves the release folder on `http://127.0.0.1:8000` inside the container (not
`file:///release`: the start script needs an HTTP 200 for the checksum list, and curl reports no
HTTP status for `file://`), installs SwarmCast with the start script from there, starts it, writes
the OBS config (first-run wizard skipped via `global.ini`; obs-websocket enabled without auth
in both `global.ini` `[OBSWebSocket]` (obs-websocket ≤ 5.4, OBS ≤ 30) and
`plugin_config/obs-websocket/config.json` (5.5+)), starts OBS under `xvfb-run` with
`LIBGL_ALWAYS_SOFTWARE=1`, and drives it with `obs_ws.py` (a minimal obs-websocket v5 client):
scene + color source + media source (an ffmpeg-generated mp4), custom server
`rtmp://127.0.0.1:1935/live` + the stream key from `/api/state`, `StartStream`. It then checks
`live` / `obsConnected`, a curl viewer gets H.264 segments, `StopStream` returns to
`waiting-obs`, and SIGINT shuts everything down.

## Section 3: `e2e.sh`

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

## Section 4: `appimage.sh`

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
"ready, opening the panel", the app and a `WebKitWebProcess` are still running 5 s later, no
"error while loading shared libraries" or panic, and Quit in the panel leaves no process.
When a base fails with a missing library, the list (here and on the website, both languages) is
what needs fixing. `libharfbuzz0b` and `libfribidi0` were found that way: AppImages leave them to
the host (the AppImage exclude list), and the v0.2.1 AppImage does not start without them.

## Cleanup

`run.sh --clean` removes the images it built. Otherwise:

```sh
docker rmi $(docker images -q 'swarmcast-test-*')
docker rmi mcr.microsoft.com/playwright:v1.64.1-noble
```
