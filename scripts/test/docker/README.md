# Linux tests in Docker

Tests the **real** staged server (`release/staging/linux-<arch>`, the executable the desktop app runs as
its sidecar), the desktop AppImage and the Playwright suite on Linux, from any machine with Docker
(written on Docker Desktop, arm64 Mac; `@amd64` targets run emulated and are slower). Nothing here
changes the build output.

| Script | What it runs |
| --- | --- |
| `obs.sh` | Section 1: real OBS Studio (Ubuntu 24.04 package, obs-websocket) headless under Xvfb + Mesa llvmpipe, streaming to the staged server in the same container |
| `e2e.sh` | Section 2: the Playwright suite (Firefox, Chromium) in `mcr.microsoft.com/playwright:v<version>-noble` (version read from `package-lock.json`) plus ffmpeg (`Dockerfile.e2e`) |
| `appimage.sh` | Section 3: the desktop AppImage on a minimal Ubuntu 22.04/24.04 and Debian 12 that has only the host packages the website's Linux page lists |
| `webkit.sh` | Section 4: the desktop window's WebKitGTK (Ubuntu 24.04's): how often it loses the panel's first navigation (`race`), and the shell's panel load watchdog against a mock server that never answers the first load (`watchdog`). By hand only, not in CI |

## In CI

`.github/workflows/_docker.yml` runs them natively on `ubuntu-24.04` (x64) and
`ubuntu-24.04-arm` (arm64), no emulation. It is the `docker` stage of `pipeline.yml`, so the
required `ci-ok` check fails with it, on pull requests and `main` that touch this folder, the
Docker workflows, `pipeline.yml`, the e2e specs and server (`apps/server/test/e2e/`) or
`playwright.config.ts`; `linux-docker.yml` runs it weekly and by hand
(`gh workflow run linux-docker.yml --ref <branch>`). A build job stages the server and makes the
AppImage of the commit for each architecture (on Ubuntu 22.04, like the release); then one job per
base image and architecture runs `appimage.sh`, one per architecture `obs.sh`, and one per
architecture `e2e.sh`, with the download cache mounted (Section 2).

### Test images

The images (`Dockerfile.*`: the test's scaffolding, installed with `apt-get`) are the test's
set-up, not what it tests, so a test never fetches them: no Docker Hub, MCR, Ubuntu or Debian
mirror at test time ([docs/TESTING.md](../../../docs/TESTING.md#no-third-party-service-in-the-gate)).
`images.sh` gives each one a key, a hash of what it is made of: its Dockerfile, its base image
(`ubuntu:22.04`, `ubuntu:24.04`, `debian:12` pinned by digest in `BASE_PINS`; for `e2e`, the
Playwright image of the `@playwright/test` version in `package-lock.json`, whose tag a release
never moves) and the architecture. A suite takes its image from the first of:

1. the image already in this Docker with that key (label `org.swarmcast.test-image.key`);
2. `$SC_TEST_IMAGES/<name>-<arch>-<key>.tar.zst` (`docker save` + zstd), loaded with
   `docker load`. In CI, `.github/actions/test-images` puts there the files an earlier run
   uploaded as an artifact, from the default branch or the job's own branch;
3. a build (the cold path): the pinned base pulled (`pull.sh`: a time limit per try, 4 tries),
   the Dockerfile built (`build.sh`). With `SC_TEST_IMAGES` set, the image is then saved there
   and listed in `built.txt`, and in CI `.github/actions/test-images/save` uploads the job's
   images for the next runs (kept 90 days).

Every suite then starts its image with `docker run --pull never`. So in CI a key is built once
per branch scope (once for `main`, whose artifacts every branch uses), and again only when its
Dockerfile, its pin or the Playwright version changes, or after 90 days. To move a base on,
replace its digest in `BASE_PINS`
(`docker buildx imagetools inspect ubuntu:24.04 --format '{{json .Manifest.Digest}}'`); the next
run builds it from the new base and the current packages. Sizes (arm64, zstd): the AppImage hosts
99, 116 and 139 MB, OBS 243 MB, the Playwright image 958 MB.

When an image is built, the build makes a failure explain itself and survive one hiccup:

- the packages go in through `image-apt.sh`: `apt-get` through `.github/scripts/apt-retry.sh` (a
  time limit per try, 3 tries), retrying a connection 3 times with a 15 s time limit, and
  `apt-get update` fails on any index it could not fetch (`APT::Update::Error-Mode=any`; by
  default it only warns and the install then fails with "Unable to locate package"), so the log
  names the broken index. Both scripts are mounted for that build step only (RUN --mount, the
  named contexts `ci` and `apt` of `build.sh`), and the step removes apt's lists, the .debs and
  its settings: only the packages stay in the image;
- on a GitHub Ubuntu runner, an Ubuntu image's archive sources go through the runner's own
  mirror list for that step (`/etc/apt/apt-mirrors.txt`: Azure's copy of the archive first, then
  archive.ubuntu.com), as the runner's apt does, and `apt-retry.sh` drops the Azure line after a
  slow try, as on the runner; the image keeps its own sources. The first cold run of this design
  (soak run 42763674289, an hour after the incident below) lost every Ubuntu x64 image to
  archive.ubuntu.com still trickling: three 90 s tries of `apt-get update` ran out on it;
- the BuildKit log (`--progress=plain`, apt's own lines) and `docker pull`'s lines are printed
  as they come, prefixed with `  | ` and `  pull | `, so a slow mirror shows while it is slow;
- a failed build is tried once more after 60 s (`BUILD_RETRY_PAUSE`), with `--no-cache`; a second
  failure fails the suite with both logs. Infra recovery, not a test retry (the rules in
  `.github/workflows/README.md`): only the scaffolding image is rebuilt, never a step that runs
  SwarmCast.

Why: release rehearsal 42757440898 (`soak/p100g`, 2026-11-10 04:47 UTC) lost four jobs at once
(`docker / AppImage ubuntu:22.04 x64` and `ubuntu:24.04 x64`, `desktop linux-x64 /
clean-machine (ubuntu-22.04)`, `docker / OBS Studio x64`), all in their image builds, before any
SwarmCast code ran. archive.ubuntu.com and security.ubuntu.com answered at 210 kB/s: `apt-get
update` took 155 s for OBS's image and then failed on "File has unexpected size ... Mirror sync in
progress?", and its second build ran out of the step's 12 minutes; the AppImage steps printed
nothing for 5 minutes (the build log was printed only after a failure) until their limit. Before
that, pipeline run 41273197813 (2026-11-01 05:38 UTC) lost `docker / ubuntu:24.04 x64` when
`apt-get` exited with 100 within seconds (a 404 or a hash mismatch: a mirror serving a
half-synchronised archive), and `docker build -q` hid apt's message.

Why an artifact and not the Actions cache: the images of one pipeline weigh about 3.5 GB (both
architectures, the clean-machine jobs' pair included), the repository's 10 GB of caches held
9.6 GB on 2026-11-10, and GitHub evicts what is over (the Rust caches first, as the least
recently used), while a public repository's artifacts have no quota; and a cache unused for 7
days is deleted, longer than between two weekly runs of `linux-docker.yml`, while an artifact
stays 90 days. A container registry (ghcr.io) would need `packages: write` and the package made
public (a private one has 500 MB of free storage), which only the repository owner can switch;
the artifacts need neither.

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

Copies the repo into the container (without `node_modules`, build output, `vendor/`), runs
`npm ci`, `fetch-binaries.mjs` (detects linux-arm64), `npm run build`, prints the
H.264/AAC support of the bundled browsers (`codec-probe.mjs`), then runs each project with
`playwright.linux.config.ts`: the main config, but the chromium project has no `channel`
(Google Chrome does not exist for Linux arm64). Reports go to `test-results/docker-e2e/<project>/`,
with that project's `e2e-server.log` and `fake-obs.log` (CI uploads them when a project fails).
After every Playwright invocation, nothing of the e2e web server (its own process, the MediaMTX
and cloudflared it started) may still run 10 s after Playwright stopped it: a check that fails the
run (what is left is then killed, so the next invocation can bind its ports).

With `SC_DOWNLOAD_CACHE` set (as in CI, where the job's setup restores the download cache), `e2e.sh`
mounts that folder into the container as `/dl-cache`, so `fetch-binaries.mjs` takes MediaMTX and
cloudflared from it after checking their SHA-256 (`✓ mediamtx ...: ... from the download cache`)
and downloads only what it lacks, into it. Without it, they are downloaded each run.
`e2e.sh` prints which (`Download cache:`). How CI restores that cache, and why:
[.github/workflows/README.md](../../../.github/workflows/README.md#pinned-downloads-in-docker).

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

## Section 4: `webkit.sh`

```sh
scripts/test/docker/webkit.sh race --loads 3000                          # 12 loops of the app's navigations
scripts/test/docker/webkit.sh race --pattern blank --pattern app-fresh --copies 8 --loads 1500
scripts/test/docker/webkit.sh watchdog                                   # this checkout's shell
scripts/test/docker/webkit.sh watchdog --src /path/to/an/older/checkout  # fails without the watchdog
```

Why and what was measured: [docs/DESKTOP.md](../../../docs/DESKTOP.md#panel-load-watchdog).
`Dockerfile.webkit` is Ubuntu 24.04 with its WebKitGTK 4.1 (the library the app's window uses on
Linux), Python's GObject bindings, Xvfb, and the desktop shell's build dependencies, Node and rustup.

- `race` runs `webkit_coop.py` 12 times at once (`--copies`), each under its own Xvfb, with no
  network (`--network none`): one webview repeats the window's navigations, the splash on a custom
  `tauri://` scheme registered like wry does, then `/auth/<token>` and `/` from a server on 127.0.0.1
  with the panel's headers (COOP same-origin, CSP...). A load that has not committed in 5 s is
  watched for 20 s more; one that still has not committed is a stall (printed with the webview's
  load events), and the harness opens it again, as the watchdog does, to check that this recovers
  it. `--pattern app-fresh` makes a new webview per load (an app start), `--pattern blank` sends a
  new webview's first navigation straight to the server (the case #115 measured, which loses loads
  much more often), `--no-coop` drops the header, `--mode watchdog` uses the app's own schedule.
  Each harness prints a JSON line, then the totals per pattern; exit 1 when a load never committed
  in the end.
- `watchdog` builds the shell (`cargo build`, debug) from `--src` (default: this checkout; the mock
  server always comes from this checkout) and runs it under Xvfb and a D-Bus session with
  `SWARMCAST_SIDECAR` set to `apps/desktop/test/mock-server.mjs` and `MOCK_LOSE_PANEL_LOADS=1`
  (`--lose N`): the mock never answers the first N panel loads, so the window's navigation neither
  commits nor fails, as WebKit's lost one. It passes when the panel page loads (the mock's page
  reports its language) after exactly N new navigations of the watchdog, within the watchdog's
  schedule plus 15 s. The update check goes to an address that refuses, never to the real feed.
  Against a shell without the watchdog it fails: the window stays on the splash.

## Cleanup

Remove the images the suites built (and the bases they pulled):

```sh
docker rmi $(docker images -q 'swarmcast-test-*')
docker rmi mcr.microsoft.com/playwright:v1.64.1-noble
```

A suite builds its image again only when none with its key is left (`images.sh`), so after a
change to a Dockerfile the next run builds it by itself.
