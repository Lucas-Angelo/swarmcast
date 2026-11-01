# CI and release workflows

How SwarmCast's GitHub Actions are put together. The release steps for the maintainer are in
[docs/RELEASING.md](../../docs/RELEASING.md); this page is about the machinery. (It lives here, not in
`.github/README.md`, because GitHub would show that one on the repository's front page.)

## Entry points

| Workflow | Runs on | What |
|---|---|---|
| `pipeline.yml` | pull requests, push to `main`, monthly, by hand, called by `release.yml` | everything that tests the app; its `ci-ok` job is the one required check |
| `release.yml` | push of a `v*` tag | the pipeline in release flavour, then sign and publish the GitHub release |
| `site.yml` | push to `main` touching the site, after Usage stats, by hand | build and deploy the website (pull requests test it through the pipeline) |
| `codeql.yml` | pull requests and `main` (not docs-only), monthly | code scanning: TypeScript, Go, Rust, the workflows |
| `soak.yml` | the `soak` label on a pull request, by hand once on `main` | repeat suites from `soak-plan.json` and report pass rates; fails on any single failed run |
| `chat-load.yml` | the `chat-load` label on a pull request, by hand once on `main`, monthly | the chat load bench (`scripts/test/chat/bench.ts`, 9 scenarios) on Ubuntu and Windows; the chat and branding property tests at 1,000,000 runs and the exhaustive 24-bit colour sweeps (`fuzz`, `branding-fuzz`) |
| `rendering.yml` | the `rendering` label on a pull request, by hand once on `main`, monthly | the chat corpus and viewer chat UI (`apps/viewer/test/chat`, mock hub) in Chrome, Edge, Firefox and WebKit on Windows, macOS and Ubuntu, plus iPhone and Pixel emulation; a screenshot per engine |
| `devices.yml` | the `devices` label on a pull request, by hand | the viewer in real mobile browsers (`apps/server/test/devices`): Mobile Safari on an iOS Simulator (macOS 26), Chrome on an Android emulator (Ubuntu, KVM); joins `ci-ok` once proven |
| `linux-docker.yml` | weekly, by hand | the Docker suites (`_docker.yml`) with the real Cloudflare tunnel check; pull requests and `main` run them as the pipeline's `docker` stage |
| `stats.yml` | daily, after a release | the public download counters, on the `stats` branch |

Files starting with `_` are reusable workflows (`workflow_call`), the stages of the pipeline.
They have no trigger of their own. There is no `merge_group` trigger: GitHub offers the merge queue to
organization-owned repositories only, and this one belongs to a user.

## The pipeline

```
changes ─┬─ quick ──────────────────────┬─ node ×3, e2e ×7, windows ×5 ──────────────┐
         ├─ build (web + windows pkgs) ─┤                                             ├─ ci-ok
         │                              └─ desktop <target> ×5: build ─ clean-machine ┤
         ├─ site (when the site changed) ─────────────────────────────────────────────┤
         └─ docker (when the Docker suites or what they run changed) ─────────────────┘
```

| Stage | File | Jobs | What |
|---|---|---|---|
| changes | `pipeline.yml` + `.github/scripts/changes.sh` | 1 | which parts the change touches: `app`, `site`, `scripts`, `docker`; and that `ci-ok` waits for every job |
| quick | `_quick.yml` | 1 Ubuntu | lint, typecheck, unit tests, `npm audit`, upstream binaries check, the streamer guides, tray cross-builds and `go vet`, `cargo fmt` |
| build | `_build.yml` | 1 Ubuntu | `npm run build` → `web-dist`; the windows-x64 package and a "newer" one → `pkg-windows-x64`; both checked for development dependencies first |
| desktop &lt;target&gt;: build | `_desktop.yml`, called once per target | 5 (2 macOS; macos-x64 is cross-built on Apple silicon and tested on Intel) | macOS/Linux: their package → `pkg-<target>`; every target: build A of the update test and the real installers → `desktop-<target>`, `update-test-<target>`; the package and the installers checked for development dependencies first |
| desktop &lt;target&gt;: clean-machine | same, after that target's build | 6 (Windows, macOS arm64 + Intel, Ubuntu 22.04, 24.04, 24.04 arm) | preflight (5 images), desktop install/update/uninstall (6), AppImage on a minimal host in Docker (2) |
| node | `_node.yml` | 3 (Ubuntu, macOS, Windows) | unit (macOS, Windows), integration (`integration` in parallel, then `integration-media`), clippy, `cargo test`, crate licences; the start and uninstall scripts when they changed (here, not in clean-machine, which is on the critical path) |
| e2e | `_e2e.yml` | 7 (Ubuntu, macOS × `ui`, `chat`, `media`; Windows chat UI) | Playwright, all three browser projects, in three groups whose greps are exact complements: `chat` is the files in `CHAT_FILES` (chat, moderation, privacy, flood, nickname, browser check), `media` the other `@media` tests, `ui` the rest plus the `@media` file(s) in `MEDIA_WITH_UI`, balanced so each takes about 7 minutes on the slowest macOS runners; the `chat` group also runs the viewer chat UI and corpus specs against a mock hub (`apps/viewer/test/chat`, 1-2.5 minutes), and `chat UI (windows-latest)` runs them in Google Chrome, Microsoft Edge and Firefox on Windows |
| windows | `_windows.yml` | 5 | the Windows suites: installer, app, quality, direct, obs |
| site | `_site.yml` | 1 | the website's unit, type, link and browser tests and the streamer guides |
| docker | `_docker.yml` (also weekly through `linux-docker.yml`) | 12 (x64 and arm64: build, Ubuntu 22.04/24.04 and Debian 12, OBS, Playwright) | the Linux Docker suites of `scripts/test/docker` on their own package and AppImage builds: start script and package, AppImage on a minimal host, real OBS Studio, the Playwright suite in the Playwright image |
| ci-ok | `pipeline.yml` | 1 | the verdict, and nothing else: one shell step, no checkout, no action, no artifact (each stage's jobs write their own results to their summaries) |

That is 30 jobs for a change to the app (8 on macOS, 7 on Windows), 31 when it also touches the
site, 12 more when it touches the Docker suites or what they run. GitHub Free runs 20 jobs at once,
5 of them on macOS.

### What runs where

| Suite | Ubuntu x64 | Ubuntu arm64 | macOS arm64 | macOS Intel | Windows x64 |
|---|---|---|---|---|---|
| lint, typecheck, `npm audit` | 24.04 | | | | |
| unit (Vitest) | 24.04 | | ✓ | | ✓ |
| integration (Vitest, real MediaMTX/ffmpeg) | 24.04 | | ✓ | | ✓ |
| Rust: clippy, `cargo test`, crate licences | 24.04 | | ✓ | | ✓ |
| e2e (Playwright: Chrome, Firefox, WebKit) | 24.04 | Docker (Chromium, Firefox) | ✓ | | |
| viewer chat UI, mock hub | 24.04 (+ phones) | | ✓ (+ phones) | | Chrome, Edge, Firefox |
| Windows suites (installer, app, quality, direct, obs) | | | | | ✓ |
| preflight (package, stream, watch, P2P, tunnel) | 22.04, 24.04 | | ✓ | ✓ | ✓ |
| desktop app: install, update, uninstall | 22.04, 24.04 | 24.04 | ✓ | ✓ | ✓ |
| AppImage on a minimal host | 22.04 (+ Docker bases) | 24.04 (+ Docker bases) | | | |
| start and uninstall scripts | 24.04 (+ the start script on the Docker bases) | the start script on the Docker bases | ✓ | | ✓ (PowerShell 5.1) |
| OBS Studio | Docker | Docker | | | ✓ |
| website | 24.04 | | | | |

"Docker" is the `docker` stage (Ubuntu 22.04, 24.04 and Debian 12 containers on native x64 and arm64
runners, no emulation). The monthly run adds `ubuntu-latest` to the node and e2e jobs as a canary.

**Build once.** `npm run build` runs once per pipeline (`build`), `package.mjs` six times (two
Windows packages, one per macOS and Linux target) and `tauri build` ten times (A and the real build
per target). Every test job downloads those artifacts, so all of them test the same bytes.
The artifacts are tar files, because `upload-artifact` drops the executable bit;
`.github/actions/get-build` downloads and unpacks them. They are kept 3 days for pull requests and 14 days
otherwise.

**Desktop builds.** A (`0.0.0-test.1`) is a `--fast` build that accepts `http://` update URLs and
trusts the key that signed the real build. The clean-machine test updates A to the real installers
through a `latest.json` it writes and serves on `127.0.0.1`. Pull requests and `main` build the
release profile without LTO and with 16 codegen units (`CARGO_PROFILE_RELEASE_*`, so the
`tauri bundle` step that retries the macOS `.dmg` still finds the binary) and sign with a key pair
made in the job. A release builds with `Cargo.toml`'s profile (fat LTO) and the real updater key.
`desktop.mjs` signs only with a key it is given (`TAURI_SIGNING_PRIVATE_KEY`, or `--release-key`
locally); it never picks up a key file by itself.

**What a change runs** (`.github/scripts/changes.sh`):
- `app` is anything except `docs/`, `site/`, `*.md` and the files only other workflows read (soak,
  Docker suites, CodeQL, stats, Dependabot, issue forms). Without it every app stage is skipped.
- `site` is `site/`, `scripts/releases/` (the beta update feed is built with the site), the screenshots, the brand assets, the shared translations, the actions and
  these workflow files.
- `scripts` is `scripts/` (not `scripts/ci` or `scripts/test/docker`), the actions and the
  node workflow (where those tests run): the install-script tests run only then, as before.
- `docker` is `scripts/test/docker/`, the Linux start and uninstall scripts, `_docker.yml`,
  `linux-docker.yml` and `pipeline.yml`, the e2e specs and server (`apps/server/test/e2e/`) and
  `playwright.config.ts`. A Docker suite that fails then fails `ci-ok`, so it cannot turn `main`
  red after the merge.
- Monthly, by hand and on a release, everything runs. When git cannot tell (a new branch, a force
  push), everything runs too.

**`ci-ok`** runs with `if: always()`. It is red when a stage failed or was cancelled, when
`changes` did not succeed, when a stage that the change needs was skipped (for example after an
upstream failure), or when the run is a re-run (`github.run_attempt` above 1): the pull request
shows only the latest attempt, so a green re-run would hide the failure. Fix the cause and push; after
a GitHub outage, start a new run (push, or run the workflow by hand). It is green with every stage
skipped for a docs-only change, within a minute. `changes` fails when `ci-ok` does not wait for
every other job of `pipeline.yml`, so a new stage cannot be left ungated.
Branch protection requires only this check, so the stages can change without touching the
ruleset (docs/RELEASING.md, section 2).

**Concurrency.** A newer push to a pull request cancels its running pipeline. Runs on `main`, tags,
schedules and releases are never cancelled.

## Shared pieces

| Path | What |
|---|---|
| `.github/actions/setup` | Node.js and `npm ci` with the npm cache; optional Go, the pinned test ffmpeg (`FFMPEG_BIN`), the download caches and a `.deb` cache (`apt-debs`); apt settings that retry |
| `.github/actions/setup/save` | last step of a job: saves the caches it filled, on `main` only |
| `.github/actions/cache-restore` | `actions/cache/restore` with a time limit per try (90 s) and one more try after a try that timed out or failed (`.github/actions/cache-restore/restore.mjs`); every `actions/cache` restore goes through it |
| `.github/actions/setup-rust` | the toolchain from `apps/desktop/src-tauri/rust-toolchain.toml`, rust-cache (saved on `main` only), the Tauri build dependencies on Linux |
| `.github/actions/get-build` | downloads and unpacks this run's build artifacts |
| `.github/actions/fetch-artifact` | `actions/download-artifact` tried twice, diagnostics after each failed try, then a REST API + curl fallback checked against the upload's SHA-256 digest (every download in these workflows goes through it; see "Artifact downloads" below) |
| `.github/scripts/apt-retry.sh` | apt with a time limit per try, retries and a mirror switch; `install`, `download`, `playwright-deps` |
| `.github/scripts/changes.sh` | the `changes` job |
| `.github/scripts/media-foundation.ps1` | waits for Media Foundation (Firefox's H.264 on Windows Server), which the first step of a Windows app job starts with DISM, and prints the servicing diagnostics when it fails |
| `.github/scripts/no-dev-deps.mjs` | fails when a development dependency or test code would ship (see Rules) |
| `.github/scripts/test-summary.mjs` | a suite's results in the job summary: Playwright JSON, JUnit XML, the Windows suites' result files, `cargo test` output, the PASS/FAIL lines of the harnesses (the soak's parsers, `scripts/ci/soak-run.mjs`) |
| `.github/scripts/annotate.mjs` | `::error` / `::warning` annotations for those two scripts |
| `.github/soak-plan.json` | what `soak.yml` repeats |

### Artifact downloads

Every artifact download goes through `.github/actions/fetch-artifact`:

1. `actions/download-artifact`.
2. If it fails: a warning, diagnostics (`rest.sh diagnose`), 30 s, then `download-artifact` again.
3. If that fails too: a warning, diagnostics again, then the fallback (`rest.sh fetch`): the
   artifact's REST API URL (`GET /repos/{repo}/actions/artifacts/{id}/zip`, a 302 to a signed blob
   URL, a fresh one per try), downloaded by curl, at most 4 tries 15/30/45 s apart within 240 s,
   each resuming the partial file (`-C -`), cut when slower than 100 kB/s for 30 s. The zip must
   have the size and the SHA-256 digest that the API recorded at upload, or it is thrown away;
   then it is unzipped where `download-artifact` would have put it. Success is a warning,
   `fetch-artifact: infra recovery: ...`, so every use of the fallback is visible in the run's
   annotations.

The diagnostics, in a `fetch-artifact diagnostics` log group: the runner and its image, the
matching artifacts (id, size, digest, expired), the blob host the API redirects to, what the
runner's resolver answers for it (`dscacheutil`, `getent`, `nslookup`), a curl request for its first
8 MiB (status, address, DNS/TCP/TLS/first-byte times, bytes, Azure's error XML), and one GET with
Node.js's `https` (`probe.mjs`: the runtime `download-artifact` uses, asking the same way: socket
lookup, connect and TLS times, status, `x-ms-request-id` and `x-ms-error-code`, the exact error
with its code, syscall and address). They never fail the step. The signed URLs' query (their
signature) is never printed. The REST calls need `actions: read`, which every workflow that
downloads artifacts grants.

Why: `download-artifact` (v8.0.2, `@actions/artifact` 6.3.1) prints only "Unable to download and
extract artifact: Artifact download failed after 5 retries." Its loop (5 attempts 5 s apart, each a
plain GET of the blob URL with a 30 s no-data limit) writes the cause with `core.debug`, which a run
shows only with step debug logging on. Pipeline run 41199245404 on `main` lost
`desktop macos-x64 / clean-machine (macos-15-intel)` that way: three tries of `pkg-macos-x64`
(161,811,655 bytes) failed, 12:33:36-12:36:58 UTC, 15 attempts in all. The log shows what the
cause was not:
- not a slow download or the 30 s limit: tries 2 and 3 took 25.0 s each, which is the five 5 s
  pauses alone; their ten attempts took about 14 ms together, try 1's five about 5 s;
- the response never reached the unzip stage: `download-artifact` constructs its unzip stream (and
  Node prints its `Buffer()` deprecation warning) once a 200 arrives, and no failed try printed it;
- not the network path to the blob storage or a storage outage: one second after the last
  failure, the same job downloaded `desktop-macos-x64` (169 MB) and `update-test-macos-x64` (85 MB)
  from the same host (`productionresultssa5.blob.core.windows.net`, in East US 2) in 6 s and 4 s;
- not the artifact: its zip is sound, and `gh run download` and curl through the REST API get it
  with the recorded digest.

An attempt that ends within a millisecond or two never reached Azure (the runner was in West US;
a working request there takes about 200 ms to its first byte), so the client failed on the
runner itself, and kept failing for 3.5 minutes on one artifact while it worked for others. Which
error that was, only the debug line knew; the diagnostics above now print it from the same
runtime, and the fallback does not depend on that client.

How often: in the 25 hours of runs before it (134 pipeline, soak and release runs, 2,659 jobs that
download artifacts, 79 of them on `macos-15-intel`), no other `download-artifact` try failed.

### Stalled cache restores

A cache restore whose download stalls must not run a job out of time. In 10x stability run
41283774499, `desktop macos-x64 / clean-machine (macos-15-intel)` found `main`'s npm entry, but the
download from the cache's storage stalled at 0 of 79.7 MB and was aborted after 12 s; setup-node
then took 109 s more to exit (its process waits for the requests it left behind, unlike
`actions/cache/restore`, which exits at once), and `npm ci --prefer-offline`, now without a cache,
sat 352 s with no output (npm waits 5 minutes for a request that gets no answer) until the setup
step's 8-minute limit stopped it. What we measured (temporary branches `soak/npm-cold-measure`,
run 41293187839, and `soak/cache-stall-sim`, run 41293309829):

- `npm ci --prefer-offline` from the registry with an empty npm cache (4 runs per runner image):
  5-9 s on Ubuntu, 4-11 s on macOS arm64, 14-22 s on Windows, 31-47 s on `macos-15-intel`; with
  the cache: 7-27 s plus 1-13 s for the restore. The cache saves at most about 20 s: a cold run is
  not slow, a stalled request is.
- A restore whose TLS connection to the cache's storage gets no answer (`iptables` dropping the
  handshake with `*.blob.core.windows.net`) hung `actions/cache/restore` for 748 s before it gave
  up, with `SEGMENT_DOWNLOAD_TIMEOUT_MINS=2`: that limit only covers the transfer of data, not the
  request before it. The same restore straight after took 3 s. A composite action's steps cannot
  have `timeout-minutes` ("Unexpected value 'timeout-minutes'").

So: every `actions/cache` restore goes through `./.github/actions/cache-restore`. It runs
`actions/cache`'s own restore code (its `restore-only` entry point, which the runner downloads for
any job that references `actions/cache`) as a child process, cuts a try off after 90 s (kills the
process group, so its `tar` too, and clears what the try may have half-extracted), and tries
once more after a try that timed out or failed; a plain miss is not retried. The npm cache is no
longer setup-node's: `setup` restores it with the same key and path (so existing entries keep
working) and saves it from `main` with `actions/cache` in `lookup-only` mode (its post step saves
when `main` has no entry for the key). And `setup` sets npm's `fetch-timeout` to 60 s and
`fetch-retries` to 4 for the job, so a request that gets no answer is retried after a minute.
Worst case for one stalled cache in `setup`: 2 x 90 s, then a cold `npm ci` (at most 47 s
measured, plus a minute per stalled request), about 5 minutes over a 24-61 s warm setup, under
the step's 8-minute limit. Not covered: the restores built into setup-go and Swatinem/rust-cache
(`setup-rust`), which cannot be wrapped; `setup-rust`'s step limit applies to them.

## Coverage

Measured in the test steps that already run the suites (no extra test runs), on every OS that runs
them. Each job writes its coverage table (with the floors) into its job summary and uploads the
reports (lcov, json-summary, HTML) as `coverage-*` artifacts, kept 14 days.

| Suite | Jobs | How | Floors checked by |
|---|---|---|---|
| unit | quick (Ubuntu), node (macOS, Windows) | `npm run coverage:unit`: Vitest, V8 | Vitest, in the test step |
| integration | node ×3 | `npm run coverage:integration`: Vitest, V8 (the code the tests run in-process) | Vitest, in the test step (this OS's floors) |
| e2e server | e2e ×4 | `NODE_V8_COVERAGE` on the Playwright step; `scripts/coverage/e2e-server.mjs` keeps the e2e server's files, c8 maps them onto the sources | `report.mjs --check`, after a passing run (this group's floors, lines) |
| desktop (Rust) | node ×3 | `npm run coverage:desktop`: `cargo test` under cargo-llvm-cov (installed by `taiki-e/install-action`, version pinned; `llvm-tools` from `setup-rust`) | `report.mjs --check` |

The floors are in `scripts/coverage/floors.json`, per suite and, where the tests differ, per OS or
e2e group. They only go up: when coverage rises, the job summary lists the floors the run allows;
raise them in the same pull request to the lowest value across the OSes. An OS with no floors yet
reports without checking. Background in docs/DEVELOPMENT.md ("Coverage").

## Rules

- **No failure is acceptable, and no test is retried.** Every run of every test on every OS must
  pass; one failure is a bug, fixed at the root. Playwright runs with `retries: 0` (every config) and
  `--fail-on-flaky-tests` in every CI invocation, so a config that ever retried could not pass a test
  that failed first. Vitest's `retry` stays 0. `soak.yml`'s report fails on any single failed run;
  `ci-ok` fails on a re-run. Retries exist only for infrastructure that is not a test, each one at
  the place that needs it: apt (`apt-retry.sh`), artifact downloads (`fetch-artifact`: a second try,
  then the REST fallback, each a warning), the pinned
  downloads (`fetch-binaries.mjs`), cache restores (`cache-restore`: one more try after a try that
  timed out or failed), npm's requests (`fetch-retries 4`, `fetch-timeout 60000`, set by `setup`), the wait for github.com on macOS (a step before every checkout of a job that can run on macOS: one VM reached neither github.com nor the cache service for its first minute and lost a release run, another lost a 10x stability job when checkout's three tries could not resolve github.com, run 41283766285), the macOS `.dmg`
  bundling step (hdiutil "Resource busy", `desktop.mjs`), Docker base image pulls
  (`scripts/test/docker/pull.sh`) and the build of a Docker suite's test image: once more after
  60 s with `--no-cache`, with both BuildKit logs printed (`scripts/test/docker/build.sh`). The
  images are the test's scaffolding (a user, sudo, curl, ffmpeg, OBS... from the distribution's
  mirror), and a mirror serving a half-synchronised archive is outside our control: pipeline run
  41273197813 lost `docker / ubuntu:24.04 x64` when `apt-get` exited with 100 within seconds
  (2026-11-01 05:38 UTC). Nothing that runs SwarmCast is retried there: the start script's own
  `apt-get install curl` (`run.sh` part b) runs once.
- **Time limits:** every job has `timeout-minutes` with real headroom over its slowest measured run:
  at least 10 minutes (a job that needs one also waits on GitHub's services: checkout, caches,
  artifacts, its own completion), otherwise 2 to 3 times the slowest run. Its setup steps and long
  test steps have their own, each below the job's and above the slowest run seen (the comment at
  each says by how much). A step that runs out of time fails, and the steps after it that upload
  results and logs still run; a job that runs out is cancelled, and those steps
  (`if: ${{ !cancelled() }}`) do not.
- **Only caches and diagnostics may fail without failing the job.** A cache is a speed-up: every
  cache restore and save is `continue-on-error`; the `actions/cache` restores go through
  `./.github/actions/cache-restore`, which cuts a try off after 90 s and tries once more, then goes
  on without the cache (see "Stalled cache restores" below); and the save steps (`./.github/actions/setup/save`, the
  Playwright browsers) are not even entered on events that save nothing and have a 3-minute
  limit. Uploads of test results, reports and logs, and the job-summary steps, are
  `continue-on-error` with a 5-minute limit. Nothing else is: a test, a build, a check or an
  upload of build artifacts that fails, fails the job. (Two pipelines of one soak batch lost a
  job each to GitHub's "Incident with Actions, Pages, and Webhooks" of 2026-10-30, 17:50 UTC: one
  in `setup/save` with every step skipped, one in the post-job "Cleaning up orphan processes" of
  `ci-ok`, both at a 5-minute job limit.)
- **Test results:** every suite writes its results to its job's summary: Vitest itself (its
  `github-actions` reporter), every other suite through `.github/scripts/test-summary.mjs`, which
  reads the suite's report or the output a step saved with `| tee`. Steps that pipe run with
  `shell: bash`, whose `pipefail` keeps the test's exit status (GitHub's default for a step without a
  shell, `bash -e`, has none). Summary steps are reports: `continue-on-error`, never the verdict.
- **Nothing that ships carries a development dependency or test code.** `.github/scripts/no-dev-deps.mjs`
  fails the build when a package that `package-lock.json` marks `dev`, a package named in any
  workspace's `devDependencies`, an `@types/*` package, or a first-party test file shows up in: the
  server bundle's inputs and run-time requires (`apps/server/dist/meta.json`), the viewer's and the
  panel's module graphs (their Vite builds, and `apps/*/dist` must be exactly those builds), a
  package (`release/staging/<target>`: the files in the server executable's pkg snapshot, no
  `node_modules`, `web/` the checked dist), or a desktop installer (each unpacked: the sidecar's
  snapshot, `web/`, no `node_modules`). It runs in `_build.yml` and `_desktop.yml` before their
  artifacts are uploaded, and in `release.yml` on the signed packages and their archives. Run it
  locally after `npm run build` and `node scripts/build/package.mjs --target <host> --no-archive`:
  `node .github/scripts/no-dev-deps.mjs --server --web --staging release/staging/<host>`.
- **Permissions:** every workflow starts from `contents: read`, plus `actions: read` in those that
  download artifacts (`fetch-artifact`'s REST fallback); a job that needs more says so
  (`codeql.yml`: `security-events: write`; `site.yml` deploy: `pages`, `id-token`; `release.yml`
  publish: `contents`, `id-token`, `attestations`; `stats.yml`: `contents: write` for its branch).
  Checkouts use `persist-credentials: false`. Actions are pinned to a full commit SHA.
- **Secrets:** only release jobs see the updater key. They name the `release` environment
  (deployment rule: tags `v*`), whose secrets no other job can read (docs/RELEASING.md, section 3).
  Pull request runs sign their test builds with a throwaway key. Never reference `secrets.*` outside
  a release job (the other jobs use `github.token`).
- **Caches** are saved on `main` only and restored everywhere, so pull requests reuse `main`'s
  instead of filling the 10 GB repository limit. One exception: the pinned-downloads cache
  (`sc-downloads-*`: the test ffmpeg, MediaMTX, cloudflared) is saved by pull requests too, because
  some publishers are very slow from GitHub's runners (the macOS ffmpeg at 10-30 kB/s): a pull
  request pays one slow download, its later runs restore it. A pull request cannot poison it:
  each entry is a pinned file, and `fetch-binaries.mjs` uses it only when its SHA-256 matches
  `scripts/build/versions.json`.
- **Runner images:** pinned where an image switch must not land in the middle of a change
  (`ubuntu-24.04`; `ubuntu-22.04` for the Linux builds' glibc baseline, retired by GitHub in April
  2027; `macos-15-intel`, the last Intel image, until August 2027); `macos-latest` (macOS 26 on
  Apple silicon) and `windows-latest` (Windows Server 2025) elsewhere. The monthly run is the
  canary for `ubuntu-latest`.
- **Releases are never edited after publishing:** `release.yml` uploads to a draft, checks every
  asset, attests them (`actions/attest`, verify with `gh attestation verify <file> -R
  Lucas-Angelo/swarmcast`) and then publishes the draft.
- **Job names** read `<stage> / <what> (<runner>)` in the checks list.
- **Windows options:** run `pipeline.yml` by hand with `windows-runners` (for example
  `["windows-2022","windows-11-arm"]`) and `windows-suites`, or `screenshots` for the website
  guide's Windows pictures.
