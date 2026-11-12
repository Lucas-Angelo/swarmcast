# CI and release workflows

How SwarmCast's GitHub Actions are put together. The release steps for the maintainer are in
[docs/RELEASING.md](../../docs/RELEASING.md); this page is about the machinery. (It lives here, not in
`.github/README.md`, because GitHub would show that one on the repository's front page.)

## Entry points

| Workflow | Runs on | What |
|---|---|---|
| `pipeline.yml` | pull requests, push to `main`, monthly, by hand (also as a release rehearsal, `release-flavour`), called by `release.yml` | everything that tests the app; its `ci-ok` job is the one required check |
| `release.yml` | push of a `v*` tag | the pipeline in release flavour (desktop installers signed with the updater key), then publish the GitHub release |
| `site.yml` | push to `main` touching the site, after Usage stats, by hand | build and deploy the website (pull requests test it through the pipeline) |
| `codeql.yml` | pull requests and `main` (not docs-only), monthly | code scanning: TypeScript, Rust, the workflows |
| `soak.yml` | the `soak` label on a pull request, by hand once on `main` | repeat suites from `soak-plan.json` and report pass rates; fails on any single failed run |
| `chat-load.yml` | the `chat-load` label on a pull request, by hand once on `main`, monthly | the chat load bench (`scripts/test/chat/bench.ts`, 9 scenarios) on Ubuntu and Windows; the chat and branding property tests at 1,000,000 runs and the exhaustive 24-bit colour sweeps (`fuzz`, `branding-fuzz`) |
| `rendering.yml` | the `rendering` label on a pull request, by hand once on `main`, monthly, a pipeline run with `release-flavour` | the chat corpus and viewer chat UI (`apps/viewer/test/chat`, mock hub) in Chrome, Edge, Firefox and WebKit on Windows, macOS and Ubuntu, plus iPhone and Pixel emulation; a screenshot per engine |
| `devices.yml` | the `devices` label on a pull request, by hand, a pipeline run with `release-flavour` | the viewer in real mobile browsers (`apps/server/test/devices`): Mobile Safari on an iOS Simulator (macOS 26), Chrome on an Android emulator (Ubuntu, KVM); joins `ci-ok` once proven |
| `linux-docker.yml` | weekly, by hand | the Docker suites (`_docker.yml`); pull requests and `main` run them as the pipeline's `docker` stage |
| `real-services.yml` | daily, by hand | the real third-party services the gate never reaches (it uses local stand-ins for Cloudflare, `scripts/test/lib/cloudflare.mjs`, and for ffmpeg's publisher, `scripts/test/lib/ffmpeg-stand-in.mjs`): the staged Linux server's preflight through the real Cloudflare quick tunnel, with the real speed test, blocklists and STUN, and the app's ffmpeg install from its publisher; never a gate, reads no secret, a failure is a summary and a warning, not a red run |
| `stats.yml` | daily, after a release | the public download counters, on the `stats` branch |
| `cache-hygiene.yml` | a pull request closing, after each Pipeline and CodeQL run on `main`, daily, by hand (dry run by default) | deletes Actions caches nobody will restore again, so the repository stays under GitHub's 10 GB cache limit (see "Caches" below) |

Files starting with `_` are reusable workflows (`workflow_call`), the stages of the pipeline.
They have no trigger of their own. There is no `merge_group` trigger: GitHub offers the merge queue to
organization-owned repositories only, and this one belongs to a user.

## The pipeline

```
changes ─┬─ quick ──────────────────────┬─ node ×3, e2e ×9, windows ×4 ──────────────┐
         ├─ build (web + windows pkg) ──┤                                             ├─ ci-ok
         │                              └─ desktop <target> ×5: build ─ clean-machine ┤
         ├─ site (when the site changed) ─────────────────────────────────────────────┤
         └─ docker (when the Docker suites or what they run changed) ─────────────────┘
```

| Stage | File | Jobs | What |
|---|---|---|---|
| changes | `pipeline.yml` + `.github/scripts/changes.sh` | 1 | which parts the change touches: `app`, `site`, `docker`; and that `ci-ok` waits for every job |
| quick | `_quick.yml` | 1 Ubuntu | lint, typecheck, `npm audit`, upstream binaries check, `cargo fmt`; kept about as short as `build` (the unit tests run in `node`), since every test stage waits for both |
| build | `_build.yml` | 1 Ubuntu | `npm run build` → `web-dist`; the staged windows-x64 server (`release/staging/windows-x64`) → `pkg-windows-x64`; both checked for development dependencies first; the Rust crates' artifact when no run saved it yet ("Rust crates") |
| desktop &lt;target&gt;: build | `_desktop.yml`, called once per target | 5 (2 macOS; macos-x64 is cross-built on Apple silicon and tested on Intel; both calls are in the macOS lanes: "macOS concurrency") | macOS/Linux: their staged server → `pkg-<target>`; every target: build A of the update test and the real installers → `desktop-<target>`, `update-test-<target>`; the staged server and the installers checked for development dependencies first |
| desktop &lt;target&gt;: clean-machine | same, after that target's build | 6 (Windows, macOS arm64 + Intel, Ubuntu 22.04, 24.04, 24.04 arm) | preflight (5 images), desktop install/update/uninstall (6), AppImage on a minimal host in Docker (2) |
| node | `_node.yml`, called twice (`node`: Ubuntu, Windows; `node-macos`) | 3 (Ubuntu, macOS, Windows) | unit, integration (`integration` in parallel, then `integration-media`), clippy, `cargo test`, crate licences |
| e2e | `_e2e.yml`, called five times (`e2e`: Ubuntu and the Windows chat UI; `e2e-macos-chat`, `e2e-macos-ui`, `e2e-macos-media`, `e2e-macos-live`: one macOS group each, in the macOS lanes) | 9 (Ubuntu, macOS × `ui`, `chat`, `live`, `media`; Windows chat UI) | Playwright, all three browser projects, in four groups whose greps are exact complements: `chat` is the files in `CHAT_FILES` (chat, moderation, polls, privacy, flood, nickname), `live` the files in `LIVE_FILES` (P2P, adaptive delay, stream start, attack, browser check), `media` the other `@media` tests plus the file(s) in `UI_WITH_MEDIA` (player controls), `ui` the rest, balanced to take about the same time (with the 0.5.x specs p90 10.8-11.9 minutes each on macOS and at most 10.2 on Ubuntu, under a 20-minute hang guard); the `chat` group also runs the viewer chat UI and corpus specs against a mock hub (`apps/viewer/test/chat`, two Playwright workers on every runner: 3-5 minutes on Ubuntu; 5-10 on macOS while its 3 CPUs gave it one), and `chat UI (windows-latest)` runs them in Google Chrome, Microsoft Edge and Firefox on Windows |
| windows | `_windows.yml` | 4 | the Windows suites on the staged server: app, quality, direct, obs |
| site | `_site.yml` | 1 | the website's unit, type, link and browser tests |
| devices | `devices.yml` (`every-event: true`), only with `release-flavour` | 2 (iOS Simulator on `macos-26`, Android emulator on Ubuntu) | the viewer in real mobile browsers; heads macOS lane 1 |
| rendering | `rendering.yml`, only with `release-flavour` | 3 (Windows, macOS, Ubuntu) | the chat corpus and viewer chat UI in every engine, plus phone emulation; heads macOS lane 2 |
| docker | `_docker.yml` (also weekly through `linux-docker.yml`) | 12 (x64 and arm64: build, Ubuntu 22.04/24.04 and Debian 12, OBS, Playwright) | the Linux Docker suites of `scripts/test/docker` on their own staged server and AppImage builds: AppImage on a minimal host, real OBS Studio, the Playwright suite in the Playwright image |
| ci-ok | `pipeline.yml` | 1 | the verdict, and nothing else: one shell step, no checkout, no action, no artifact (each stage's jobs write their own results to their summaries) |

That is 31 jobs for a change to the app (9 on macOS, 6 on Windows), 32 when it also touches the
site, 12 more when it touches the Docker suites or what they run. A release rehearsal runs all of
them plus `devices` and `rendering`: 49 jobs (11 on macOS, 7 on Windows). GitHub Free runs 20 jobs at once,
5 of them on macOS; a pipeline has at most 3 Apple silicon jobs queued or running at once (see "macOS
concurrency" below).
Every call of a stage keeps the stage's name, so the checks read `node / ... (macos-latest)` and
`e2e / <group> (macos-latest)` whichever call ran them.

### What runs where

| Suite | Ubuntu x64 | Ubuntu arm64 | macOS arm64 | macOS Intel | Windows x64 |
|---|---|---|---|---|---|
| lint, typecheck, `npm audit` | 24.04 | | | | |
| unit (Vitest) | 24.04 | | ✓ | | ✓ |
| integration (Vitest, real MediaMTX/ffmpeg) | 24.04 | | ✓ | | ✓ |
| Rust: clippy, `cargo test`, crate licences | 24.04 | | ✓ | | ✓ |
| e2e (Playwright: Chrome, Firefox, WebKit) | 24.04 | Docker (Chromium, Firefox) | ✓ | | |
| viewer chat UI, mock hub | 24.04 (+ phones) | | ✓ (+ phones) | | Chrome, Edge, Firefox |
| Windows suites (app, quality, direct, obs) | | | | | ✓ |
| preflight (staged server: stream, watch, P2P, tunnel) | 22.04, 24.04 | | ✓ | ✓ | ✓ |
| desktop app: install, update, uninstall | 22.04, 24.04 | 24.04 | ✓ | ✓ | ✓ |
| AppImage on a minimal host | 22.04 (+ Docker bases) | 24.04 (+ Docker bases) | | | |
| OBS Studio | Docker | Docker | | | ✓ |
| website | 24.04 | | | | |

"Docker" is the `docker` stage (Ubuntu 22.04, 24.04 and Debian 12 containers on native x64 and arm64
runners, no emulation). The monthly run adds `ubuntu-latest` to the node and e2e jobs as a canary.

**Build once.** `npm run build` runs once per pipeline (`build`), `package.mjs` five times (one
staged server per target) and `tauri build` ten times (A and the real build
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
A release rehearsal (`release-flavour`) builds exactly as a release does (`Cargo.toml`'s profile,
the same bundles, the 45-minute build limit; the step "Build profile (release flavour)" prints the
profile and fails if a `CARGO_PROFILE_RELEASE_*` variable overrides it) but signs with the job's
key pair, as pull requests do.
Both restore `main`'s test-build Rust cache of their target (`setup-rust`'s `cache-as-test-build`:
rust-cache's step alone computes its key with the test profile's two variables, and never saves),
so build A, a test-profile build, compiles only the app's own crate, as in a pull request; the
installers' fat-LTO build compiles what its profile needs (cargo's fingerprints keep the two apart).
Before, a release-flavour key never matched an entry and A compiled every crate: p50 3.6 minutes
on macOS arm64 against 0.9 in a pull request, 3.8 against 0.8 for macos-x64, 4.7 against 1.1 on
Windows, 4.3 against 1.9 and 3.7 against 1.6 on Linux x64 and arm64 (63 to 67 release rehearsals
per target, 2026-11-10 to 11-12; 55 pull request and `main` runs, 2026-11-06 to 11-12).
`desktop.mjs` signs only with a key it is given (`TAURI_SIGNING_PRIVATE_KEY`, or `--release-key`
locally); it never picks up a key file by itself.

**What a change runs** (`.github/scripts/changes.sh`):
- `app` is anything except `docs/`, `site/`, `*.md` and the files only other workflows read (soak,
  Docker suites, CodeQL, stats, Dependabot, issue forms). Without it every app stage is skipped.
- `site` is `site/`, `scripts/releases/` (the beta update feed is built with the site), the screenshots, the brand assets, the shared translations, the actions and
  these workflow files.
- `docker` is `scripts/test/docker/`, `_docker.yml`,
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

### Running it by hand

**Actions → Pipeline → Run workflow**, or `gh workflow run pipeline.yml --ref <branch> -f <input>=<value>`.
A dispatched run runs every stage (`changes.sh --all`: app, site and Docker), whatever the branch
changed. Dispatch it on a `soak/*` marker branch (a commit of its own on top of what you test),
never on `main`'s commit: a failure there shows red on `main`.

| Input | Default | What |
|---|---|---|
| `windows-runners` | `["windows-latest"]` | the Windows suites' runners, a JSON list (for example `["windows-2022","windows-11-arm"]`) |
| `windows-suites` | `["app","quality","direct","obs"]` | the Windows suites to run, a JSON list |
| `screenshots` | `false` | also capture the Windows installer pages and app window for the website guide (artifact only) |
| `release-flavour` | `false` | a release rehearsal that publishes nothing (below) |

**Release rehearsal** (`release-flavour: true`): the run a release makes (`release.yml` calling the
pipeline with `release: true`), without the release. What it adds to a plain dispatch:

- the five desktop targets build in release flavour: `Cargo.toml`'s profile (fat LTO, one
  codegen unit), the same bundles and the release jobs' 45-minute limit, signed with a key pair
  made in the job (`tauri signer generate --ci --password test`), and build A trusts that key;
- `devices` (`devices.yml` with `every-event: true`: iOS Simulator and Android emulator) and
  `rendering` (`rendering.yml`), each at the head of a macOS lane ("macOS concurrency" below);
- `ci-ok` needs them too: it is red if either is skipped, fails or is cancelled.

What it never does: name the `release` environment, read `secrets.*` (the updater key is passed on
only with `release: true`, which only `release.yml` can set), or create a tag, release, draft,
attestation or Pages deployment; its artifacts are the usual 14-day workflow artifacts. It is for
proving a release candidate or the pipeline itself stable, many runs in a row. Start them one
after the other (the next when the last has ended): one run asks for at most three Apple silicon
runners at a time, two at once for six, and GitHub drops a macOS job that waits too long ("macOS
concurrency" below). `devices.yml` and `rendering.yml` take the calling run's own
concurrency group, so runs on the same branch never cancel each other's calls.

### macOS concurrency

A pipeline's nine macOS jobs (eleven in a release rehearsal) run in three lanes chained with `needs`
in `pipeline.yml`, so a run never has more than three Apple silicon jobs queued or running at once,
and none of its jobs waits for a runner behind another of its own: each is asked for only when
the job before it in its lane has ended. A chained call runs whatever the result of the call
before it (not when the run is cancelled), so every check runs as before. `devices` and
`rendering` run only in a release rehearsal; in any other run they are skipped as soon as
`changes` is done, and their lane starts with its next job.

| Lane | Jobs, in order | Pull request, `main`: minutes (p50; max) | Release rehearsal: minutes (p50; max) |
|---|---|---|---|
| 1 | `devices / iOS Safari (Simulator)` (`macos-26`; release rehearsal only), `e2e / ui`, `e2e / media` | 23.6 (26.5) | 31.6 (40.0) |
| 2 | `rendering / macos-latest` (release rehearsal only), `e2e / chat` (with the viewer chat UI), `desktop macos-arm64` (build, clean-machine) | 22.1 (25.1) | 33.1 (37.7) |
| 3 | `node / unit, integration, rust`, `e2e / live`, `desktop macos-x64` (build on Apple silicon, clean-machine on `macos-15-intel`) | 23.5 (26.1) | 29.5 (38.1) |

(2026-11-11, with the fourth e2e group, `live`, and the viewer chat UI on two workers: the 16 pull
request and `main` runs and the 30 release rehearsals of 2026-11-07 to 11-11 whose macOS jobs all
passed, replayed with their own job times and no queue waits. The e2e groups' times are each
run's own test times regrouped, plus the step's and the job's own time; the viewer chat UI's step
is taken at 1/1.7 of its one-worker time, Ubuntu's measured gain at two workers being 1.8.) The
longest lane is p50 24.5 and at most 26.5 minutes on a pull request or `main` (the three-group
layout, replayed the same way: 25.4 and 28.5), and p50 34.5 and at most 40.0 as a release
rehearsal (three groups: 36.9 and 40.7). Were the chat UI no faster at two workers, the longest
lane would be p50 25.6 (pull request) and 40.0 (rehearsal). A release (`release.yml`) builds like
a rehearsal but runs no `devices` or `rendering`: lanes of about 22, 28 and 29 minutes. The Intel
clean-machine runs in lane 3 too, so a run has at most three macOS jobs of any kind at once, two
under the account's five. `devices` and `rendering` lead their lanes because they build what they
test themselves and can start once `changes` is done; their Ubuntu and Windows jobs start then too.
The macOS node job leads lane 3: it needs only `quick` and `build`.

**Wall time.** The critical path is the macOS lanes (the rest of a run ends by about minute 27,
the Docker suites' Playwright jobs last). Of every assignment of the seven jobs to the three lanes,
tried against the jobs' p50 times (pull request and rehearsal together), the layout above is
the fastest but one, 0.1 minute apart; the order inside a lane changes little. The three-group layout before it
(lanes: devices, node, `e2e / chat`; rendering, `e2e / ui`, desktop macos-arm64; desktop
macos-x64, `e2e / media`) took p50 26.6 and at most 30.6 minutes for a whole pull request run and
p50 35.8 and at most 41.3 as a rehearsal (2026-11-08 to 11-10). A cold Rust cache (a `Cargo.lock`
or toolchain change) doubles the two builds.

**Why three** (2026-11-10). In a campaign of release rehearsals started one at a time with
nothing else of the account running, GitHub dropped four Apple silicon jobs in three runs of
seven ("The job was not acquired by Runner of type hosted even after multiple attempts", 15
minutes after it was queued): `rendering / macos-latest` and `e2e / media` in 42846972124, the
macos-x64 build in 42855604890, the macos-arm64 clean-machine in 42868396790. Two of them were
queued while three of the run's Apple silicon jobs ran, a fourth in the four-lane layout. That
fits an effective limit of about three Apple silicon runners under the capacity notice, but does
not prove it: the other two were queued with none and with two of ours running, and in each of
the three runs a job queued after the dropped one got a runner within seconds while the dropped
one went on waiting (`devices` in 42846972124 and 42855604890, `rendering` in 42855604890 and
42868396790). Waits come in steps of about 5, 10 and 15 minutes, as if GitHub tried to place a
queued job again every 5 minutes and dropped it after the third try; 161 of the 188 Apple silicon jobs of the 21 rehearsals started within a minute.
So three lanes do not end the drops, which are GitHub's capacity: they keep a run from asking
for a fourth Apple silicon runner and from queueing a job behind its own. A dropped job still
leaves `ci-ok` red: start a new run. Merging jobs to ask for fewer runners would help less than
it seems: with 4 of 188 placements dropped (2.1 %), a rehearsal's nine Apple silicon jobs lose
it about 18 % of the time and eight would about 16 %, at the price of the checks' names (ten,
with the `live` group since 2026-11-11: about 19 %).

**Before: four lanes** (PR #125, 2026-11-05 to 2026-11-10). `e2e / chat` then `rendering`;
`e2e / media`; node, `e2e / ui`, then `devices`; desktop macos-arm64 then macos-x64. At most four
macOS jobs of a run at once, one runner left for another run's job. Its reasons, still true:

GitHub Free gives the account 5 macOS jobs at once, Apple silicon and Intel together.
In the 2,270 macOS jobs of every workflow that uses macOS (422 Pipeline, Soak, Release,
Rendering, Devices and Chat load runs, 2026-11-01 10:28 to 2026-11-05 17:55 UTC), never more
than 5 ran at once, Intel included, and 5 did in most hours; a queued Apple silicon job that
started while 4 of ours ran did so within 15 s of one of ours ending 62-76 % of the time (a
random moment: 16-26 %). The pipeline used to ask for 7 Apple silicon runners at once (the two
macOS desktop builds once `build` is done, node and the three e2e groups once `quick` is too),
then for the two clean-machines 4 minutes later: 8 jobs, so at least 3 always waited for the
pipeline's own, and longer when a second run (another pull request, a soak batch) was going.

Since 2026-11-02 19:11 UTC, queued Apple silicon jobs carry the notice "Due to capacity
constraints, jobs targeting macOS arm64 runners may experience longer queue times", and GitHub
drops a job it cannot place: "The job was not acquired by Runner of type hosted even after
multiple attempts" (conclusion `cancelled`, no runner, no steps), which leaves `ci-ok` red and
the run lost. 53 jobs were dropped that way (47 in Pipeline runs, 4 in Release, 2 in Soak; 52
`macos-latest`, 1 `macos-15-intel`), each after 15 to 101 minutes in the queue; from
2026-11-04 17:00, 19 of the 72 macOS jobs that waited 15 minutes or more were dropped and none of
the 396 that waited less. Waiting is the risk, and the pipeline made most of its own waiting.
In run 42075942536 (the only run of the repository on macOS then), seven Apple silicon jobs were
queued at 17:36 UTC; three got runners at 17:41, `e2e / media` 3 s after the macos-x64 build
ended (17:45:11) and `e2e / chat` 3 s after node ended (17:46:23); the macos-arm64 build, queued
since 17:36:23, was dropped at 17:51:55.

Not fixed here: in capacity mode GitHub also hands out runners slowly below the limit (in about
half of the minutes in which an Apple silicon job of ours waited over a minute, fewer than 5 of
ours were running; on 2026-11-05 one waited 18 minutes, 15:27-15:45, with none of ours running).
Two runs at once (two pull requests, or one with a soak batch) needed up to 8 runners then (6
Apple silicon now). Four lanes left one runner for another run's job.

Proof of the four lanes (three pipeline runs dispatched one after the other on a `soak/*` marker branch,
2026-11-05, 42081315067, 42089261822 and 42093902489, the first one overlapping the end of a
pull request's run in the old layout): all green, no job dropped, at most 4 macOS jobs of a run
at once, and the account never at 5 while one of their jobs waited, so none waited behind our
own jobs. GitHub's waits stayed: 13 of the 24 macOS jobs started within a minute, the others after
2.5 to 18.2 minutes (most 5-6 minutes), each while 0 to 4 of the account's 5 macOS runners were
busy. Wall times 49, 28 and 30 minutes (the old layout: p50 33, p90 79 over the 58 successful
Pipeline runs of 2026-11-04 and 2026-11-05).

## Shared pieces

| Path | What |
|---|---|
| `.github/actions/setup` | Node.js and `npm ci` with the npm cache (restored through `cache-restore`, saved from `main` only; elsewhere also `main`'s latest entry after a lockfile change), npm's network limits; optional: the pinned test ffmpeg (`FFMPEG_BIN`), the app's pinned ffmpeg archive (`app-ffmpeg`) and the portable OBS zip (`obs-studio`) into the download cache, the download cache, the Tauri tools on Windows (`tauri-tools`) and the job's saved `.deb` set (`apt-debs`, see "Ubuntu packages" below); apt settings that retry |
| `.github/actions/setup/save` | last step of a job: saves the caches it added or changed files in (`.github/scripts/cache-files.mjs`), on `main` only (the download cache also from pull requests; see "Release downloads" below) |
| `.github/actions/cache-restore` | `actions/cache/restore` with a time limit per try (90 s) and one more try after a try that timed out or failed (`.github/actions/cache-restore/restore.mjs`); every `actions/cache` restore goes through it |
| `.github/actions/fetch-remote` | fetches remote actions with git at their pins into `.git/remote-actions/`, 4 tries, so steps run them from there (see "Remote actions" below) |
| `.github/actions/remote-pins` | never runs: the pins (`uses:` lines, bumped by Dependabot) of the remote actions `fetch-remote` fetches |
| `.github/actions/setup-rust` | the toolchain from `apps/desktop/src-tauri/rust-toolchain.toml`, rust-cache (saved on `main` only), the crates of `Cargo.lock` with cargo offline from then on (`cargo-crates`), the Tauri build dependencies on Linux from the saved `.deb` set with apt offline (`apt-debs.sh`) |
| `.github/actions/cargo-crates` | every crate of `apps/desktop/src-tauri/Cargo.lock` into `$CARGO_HOME/registry` from the artifact an earlier run saved, checked against `Cargo.lock`'s SHA-256 values, else from crates.io with tries; then `CARGO_NET_OFFLINE=true` for the job; `cargo-crates/save` (the build stage) saves that artifact once per `Cargo.lock` and toolchain (`.github/scripts/cargo-crates.mjs`; see "Rust crates" below) |
| `.github/actions/get-build` | downloads and unpacks this run's build artifacts |
| `.github/actions/test-images` | the Docker suites' test images of a job, from the artifact an earlier run saved (`.github/scripts/test-images.mjs` finds it), into `SC_TEST_IMAGES`; `test-images/save` uploads the ones a job had to build (see "Test images" below) |
| `.github/actions/fetch-artifact` | `actions/download-artifact` tried twice, diagnostics after each failed try, then a REST API + curl fallback checked against the upload's SHA-256 digest (every download in these workflows goes through it; see "Artifact downloads" below) |
| `.github/actions/upload-build` | one try of `actions/upload-artifact` for an artifact a later job needs; the workflow runs it twice, as two steps with their own time limits, try 2 only after a failed or timed-out try 1, when the artifact service answers again, with `overwrite` (see "Artifact uploads" below) |
| `.github/scripts/apt-debs.sh` | every apt install of a gating Linux job: from the job's saved `.deb` set, checked against its `SHA256SUMS`, with apt offline (the set is its only source); the Ubuntu archive only when the set does not fit the runner image; `install`, `download`, `playwright-deps`, `finish` (see "Ubuntu packages" below) |
| `.github/scripts/apt-retry.sh` | apt with a time limit per try, retries and a mirror switch (`update`, `install`, `download`): `apt-debs.sh`'s cold path, the Docker test images' builds, the soak's `apt` suite |
| `.github/scripts/cache-files.mjs` | which download and Tauri tools cache entries `setup/save` saves: a new one only when the job added files to what it restored or changed one (tested in `scripts/ci/test`) |
| `.github/scripts/changes.sh` | the `changes` job |
| `.github/scripts/media-foundation.ps1` | waits for Media Foundation (Firefox's H.264 on Windows Server), which the first step of a Windows app job starts with DISM, and prints the servicing diagnostics when it fails |
| `.github/scripts/no-dev-deps.mjs` | fails when a development dependency or test code would ship (see Rules) |
| `.github/scripts/npm-network-error.mjs` | tells `setup` whether a failed `npm ci` failed on the network (npm's own errors, or prebuild-install's download in an install script), so it runs once more (tested in `scripts/ci/test`) |
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

### Artifact uploads

Every artifact that a later job downloads goes up through `.github/actions/upload-build`:
`web-dist` and `pkg-windows-x64` (`_build.yml`), `pkg-<target>`, `desktop-<target>` and
`update-test-<target>` (`_desktop.yml`), and `linux-docker-<arch>` (`_docker.yml`). The workflow
runs it as two steps, each with its own `timeout-minutes`:

1. Try 1 (`try: 1`): `actions/upload-artifact` (from the copy `fetch-remote` fetched, as for
   every remote action our actions run). `continue-on-error`, at most 5 minutes.
2. Try 2 (`try: 2`), only when try 1 failed or ran out of time, at most 12 minutes: a warning, what
   the runner's resolver answers for the artifact service's host (`dscacheutil`, `scutil --dns`,
   `getent`, `nslookup`), a wait of at most 300 s until that host takes an HTTPS request (any
   status), 5 s between tries; then `upload-artifact` again with `overwrite: true`. When it works:
   `infra recovery: artifact <name> uploaded on try 2 of 2`, a warning the soak counts.
3. When try 2 fails or runs out of time too, the job fails, and the step after it says why:
   `infra: <name> could not be uploaded in 2 tries ...` (an error titled "Artifact upload
   (infrastructure)"). Only the upload is tried again, never the build.

Why two steps: a step's `timeout-minutes` is the only time limit GitHub Actions puts on an action.
A composite action's own steps cannot have one (the runner's `action_yaml.json` allows `name`,
`id`, `if`, `uses`/`run`, `with`, `env`, `continue-on-error`, `working-directory`, `shell`); they
inherit what is left of the calling step's limit (`ExecutionContext.CreateEmbeddedChild`,
`GetRemainingTimeout`). One step for both tries would let a hung try 1 use up the time of try 2,
and `upload-artifact` is a Node.js action, so no `timeout` command can wrap it. A step that runs
out of time fails ("has timed out after N minutes"), and `continue-on-error` then lets the job go
on with that step's `outcome` at `failure`, which is what starts try 2.

The limits, from the 289 pipeline runs of 2026-11-03 to 11-12 (each step's own time, which
includes the git fetch of `upload-artifact` at a job's first upload):

| Artifact | Size | Uploads | Slowest | p99 |
|---|---|---|---|---|
| `web-dist` | 4 MB | 289 | 4 s | 3 s |
| `pkg-windows-x64` | 88 MB | 289 | 34 s | 14 s |
| `pkg-<target>` (macOS, Linux) | 76-81 MB | 1,146 | 50 s (`pkg-macos-x64`) | 8-13 s |
| `desktop-<target>` | 69-241 MB | 1,431 | 13 s | 8-9 s |
| `update-test-<target>` | 80-226 MB | 1,431 | 18 s | 6-8 s |
| `linux-docker-<arch>` | 335 MB | 435 | 24 s | 7-8 s |

The slowest rate any of them went up at was 1.6 MB/s (`pkg-macos-x64`, 81 MB in 50 s); at that
rate the largest, `linux-docker-<arch>`, takes 3.5 minutes, so 5 minutes per try leaves room over
any upload that was working, while a hung one is cut off long before the job's own limit. Try 2's
12 minutes are its wait (at most 5), the same 5 for the upload, and 2 for a `fetch-remote` that
has to fetch again (4 tries of at most 30 s, when try 1 ended inside it). Each job that uploads
has room for one artifact's two tries at their limits, 17 minutes, over its slowest run:
`_build.yml` 25 minutes (slowest 3.5; 10 before), the desktop builds 45 in both flavours (slowest
9.2 for a test build, 14.8 in release flavour; a test build with a cold Rust cache about twice
its warm p99 of 8.8; 27 before for test builds), `_docker.yml`'s builds 30 (slowest 7.5,
unchanged).

`overwrite: true` on try 2: `upload-artifact` (v7.0.2, `@actions/artifact` 6.3.1) then looks the
name up in the run (`ListArtifacts`) and deletes what it finds before `CreateArtifact`; finding
none is not an error, and a failed delete is only a debug line. Without it, an artifact of that
name already in the run makes `CreateArtifact` fail at once with "(409) Conflict: an artifact with
this name already exists on the workflow run", which `upload-artifact` does not try again. That is
the case of a try 1 that ran out of time after the service had finished the artifact (the bytes
are up only when `FinalizeArtifact` is sent, with their SHA-256). The delete is safe: nothing has
read the artifact yet, since every job that downloads it `needs` this one to end, and the files
have not changed between the tries. A try 1 cut off between `CreateArtifact` and
`FinalizeArtifact` leaves an unfinished artifact; whether `ListArtifacts` lists one (so that
`overwrite` deletes it) is not documented, and no run has shown it yet: a 409 on try 2 would be
that case. Try 1 does not overwrite: an artifact by that name before it would be a mistake in the
workflow, and a failure says so.

Why: release rehearsal 42846972124 lost `desktop macos-arm64 / build (macos-latest)` 10 minutes
into the job, after the installers were built and checked: "Failed to CreateArtifact: Unable to
make request: ENOTFOUND" at 16:04:28 UTC, 30 s after the step started. A macOS VM that cannot
resolve names for a while is known from the start of a job (the wait for github.com before
checkout); this one lost DNS in the middle. How long such a loss lasts varies: about a minute at
the start of a job (run 41283766285), over 3.5 minutes (run 42023369370, where checkout gave up
after the 3-minute wait), and over 8 minutes on an Intel clean-machine (soak run 41994029873:
`ListArtifacts` ENOTFOUND for the artifact service's host from 08:36 to 08:44 UTC, while the blob
host still resolved, so `fetch-artifact`'s tries and REST fallback all failed). The wait saves the
short ones. Then two more, after the first version of `upload-build` (one composite step, both
tries inside, used only by the desktop builds):

- Pipeline run 43232320009 lost `docker / Build linux-arm64` with its build done: its upload was
  a plain `upload-artifact` step, and "Failed to CreateArtifact: Unable to make request:
  ETIMEDOUT" came after 2 min 16 s (a TCP connect that never got an answer). `@actions/artifact`
  throws a network error code (`ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`...) at once, with none of
  its own retries. Now `_build.yml` and `_docker.yml` upload through `upload-build` too.
- Pipeline run 43088776972: `Upload desktop-macos-arm64` took 22 minutes to fail. Each of try 1's
  five `CreateArtifact` requests waited 2 minutes for an HTML error page ("Unexpected token '<'"),
  11 minutes in all; try 2, after the service answered at once, did the same and ended in "(404)
  Not Found: workflow run not found", the run itself gone wrong on GitHub's side. No step had a
  limit: one more hung request and the job's own limit would have been the only one. Now each try
  ends after 5 minutes.

`@actions/artifact`'s own limits, for reading a log: each twirp call (`CreateArtifact`,
`FinalizeArtifact`) is tried 5 times, 8, 12-18, 18-27 and 27-40 s apart, on a 5xx, a 429 or an
unreadable answer, with no time limit on a request; the blob upload fails after 5 minutes without
progress (`ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS`), never for being slow. One try can therefore take
over 20 minutes without hanging, which is why the step limit decides.

The other uploads keep test results, reports, coverage and logs, which no job reads:
`continue-on-error` with a 5-minute limit (Rules), so they never fail a job. The guide
screenshots (`_desktop.yml`, a run by hand with `screenshots`) go through `upload-build`'s two
tries, both `continue-on-error`: no job reads them either. The caches that are artifacts
(`cargo-crates/save`, `test-images/save`) are `continue-on-error` with a 5-minute limit; a job
that does not find them builds or fetches what they hold. `site.yml`'s Pages artifact
(`upload-pages-artifact`, deploys on `main` only) is not part of the pipeline.

### Remote actions

The remote actions our own actions run (setup-node, actions/cache, download-artifact,
upload-artifact, Swatinem/rust-cache) are not downloaded by the runner:
`./.github/actions/fetch-remote` fetches each with git, at its pin, into
`.git/remote-actions/<owner>/<repo>` of the workspace, and the step runs it from there
(`uses: ./.git/remote-actions/Swatinem/rust-cache`, `./.git/remote-actions/actions/cache/save`).
The pins are the `uses:` lines of `.github/actions/remote-pins/action.yml`, a composite action that
never runs (each step is `if: false`), in that format so Dependabot keeps bumping the SHAs and
their `# vX.Y.Z` comments; `scripts/ci/test/fetch-remote.test.ts` fails when one of our actions
uses a remote action directly, when a fetched action has no pin or no fetch step before it, and
when a workflow pins the same repository at another commit.

Why: in 10x stability run 41636784175 (`soak/p10-0.5.0`), `desktop macos-arm64 / build
(macos-latest)` failed in `setup-rust` before any of its steps ran:

```
Prepare all required actions
Getting action download info
Download action repository 'Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0' (SHA:d1527c8f67ef9af357290475d4af4b0fab8f12e0)
##[error]An action could not be found at the URI 'https://codeload.github.com/Swatinem/rust-cache/tar.gz/d1527c8f67ef9af357290475d4af4b0fab8f12e0' (AF6A:3C6DDB:2098B:3F849:6AE9DB6B)
##[error]Failed to download archive '...' after 1 attempts.
```

The commit exists (v2.9.3) and codeload served it again straight after. What the runner does
(actions/runner v2.338.2, the version of that job, `src/Runner.Worker/ActionManager.cs`):

- `DownloadRepositoryArchive` (line 1644) tries 3 times, 10-30 s apart, after a network error, a
  5xx or a 20-minute timeout, but a 404 throws `ActionNotFoundException` at once ("It doesn't make
  sense to retry in this case", line 1691): "after 1 attempts".
- That one function downloads every remote action: the job's own steps in "Set up job"
  (`JobExtension.cs` line 301, `PrepareActionsAsync`) and the steps of a local composite action
  when it starts (`ActionRunner.cs` lines 83-92, "Handle Composite Local Actions"; it cannot be
  done earlier, the composite's `action.yml` is in the repository, which is not checked out yet).
  So moving a `uses:` from a composite action to the job would only move the same single try to
  "Set up job", which fails the job just the same.
- The one download it skips is from the runner image's action archive cache
  (`ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE`, line 1232, a setting of the runner's own environment that
  a workflow cannot set): a few first-party actions at their release commits (actions/action-versions:
  checkout, cache, setup-node, upload-artifact, ...). Swatinem/rust-cache and
  download-artifact at our pins are not in it, and an action bumped to a release
  newer than the image is not either.

A git fetch goes to github.com (like actions/checkout), not codeload, and git checks every object
against its hash, so the copy is exactly the pinned commit (for every pin, the same files as
codeload's tarball). `fetch.mjs` tries 4 times, 5, 10 and 20 s apart, each git command limited to
30 s (a fetch takes 0.7-1.6 s), with a warning for every failed try; an action already fetched in
the job is not fetched again. One that only speeds the job up (actions/cache, rust-cache) is
`optional`: if it cannot be fetched, the caches are skipped with a warning, where the runner's
download failure used to fail the job even though the rust-cache step is `continue-on-error`.
When download-artifact cannot be fetched, `fetch-artifact` goes straight to its REST fallback.
Inside `.git`, the copies are out of the way of everything that reads the workspace (git status
and clean, ESLint, a later checkout). Still downloaded by the runner, so still exposed to a 404:
actions/checkout (it puts `fetch-remote` there in the first place) and actions/upload-artifact,
both in the image's action archive cache at our pins, and, outside the pipeline, the
github/codeql-action, actions/attest and GitHub Pages steps. How often: in the 485 failed jobs of
the 192 failed runs before it (every failed run from 2026-10-25 to 2026-11-03), no action
download had failed.

### AppImage tools

Every job that builds an AppImage runs `scripts/build/desktop.mjs` (`_docker.yml`'s builds, the
Linux builds of `_desktop.yml`, so also `release.yml`), and that runs
`scripts/build/appimage-tools.mjs` before `tauri build`. It writes what the Tauri bundler would
download into its tools folder (`~/.cache/tauri` on the runners): `AppRun-<arch>` and
`linuxdeploy-07333c6-<arch>.AppImage` (`x86_64`, `aarch64`), pinned by SHA-256 in
`scripts/build/versions.json` and downloaded by `fetch-binaries.mjs` (6 tries with back-off,
resume, `SC_DOWNLOAD_CACHE`), plus the AppImage runtime (`LDAI_RUNTIME_FILE`) and an empty,
non-executable `linuxdeploy-plugin-appimage.AppImage` that makes linuxdeploy use its built-in
appimage plugin. AppRun and linuxdeploy (fixed release tags) must arrive or the build stops; the
runtime comes from a rolling `continuous` release, so when no source gives the pinned bytes (all
sources failed, or upstream has a newer build and the `ci-deps` mirror lacks ours) the build gets a
`::warning::` with the cause and goes on as before the pin: appimagetool downloads the runtime
itself and the runtime check is skipped, with a line saying so. Details and the bundler's source
lines: [apps/desktop/README.md](../../apps/desktop/README.md).

Why: in 10x stability run 42000871599 (`soak/p10-0.5.2`), `docker / Build linux-arm64` failed in
"Package, AppImage and a release folder" after `tauri build` had compiled:

```
 Downloading https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-aarch64
 Downloading https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-aarch64.AppImage
failed to bundle project: `http status: 504`
```

tauri-bundler 2.10.4 (in `@tauri-apps/cli` 2.12.4) downloads each missing tool with one GET and no
retry (`src/utils/http_utils.rs`, `download`) and fails the build on any error
(`src/bundle/linux/appimage/linuxdeploy.rs`, `prepare_tools`); a file that exists is used without a
check. The appimage plugin (`continuous`, rebuilt every month) was optional there, and appimagetool,
inside it, downloaded the runtime (also `continuous`) at bundle time with one try as well. Every
AppImage build, the release's too, depended on these downloads from github.com, four per
architecture. Now the bundler's log shows no `Downloading` line, `desktop.mjs` logs where each tool
came from, and it checks that each AppImage starts with the pinned runtime (unless the runtime
fell back, see above).

### Pinned downloads in Docker

The pinned binaries reach a container the way they reach a runner: from the download cache. Of
the `docker` stage's jobs only `Playwright in Docker` downloads one at run time:
`e2e-in-container.sh` runs `fetch-binaries.mjs` (MediaMTX and cloudflared for the container's
architecture). The job runs `./.github/actions/setup` with `downloads: 'true'` and
`npm-ci: 'false'`, which restores the `sc-downloads-Linux-<arch>-ffmpeg-false-for-linux-<arch>-*`
entry (the one the `docker` and desktop builds fill) and sets `SC_DOWNLOAD_CACHE`; `e2e.sh` mounts that folder
into the container as `/dl-cache` and passes `SC_DOWNLOAD_CACHE=/dl-cache`. `fetch-binaries.mjs`
then takes each archive from the cache after checking its SHA-256 against
`scripts/build/versions.json` (`✓ mediamtx v1.21.3: mediamtx_v1.21.3_linux_amd64.tar.gz from the
download cache`), and only on a miss downloads it, from the asset's `mirrors` first when
`versions.json` lists any (MediaMTX and cloudflared have none today), with its tries and back-off.
The job never saves the cache: the builds fetch the same two archives and save them
("Release downloads"). `e2e.sh` prints
`Download cache:` with the folder and its file count (or `none`) before the container starts.

The other Docker suites download nothing pinned at run time: `obs.sh` runs the staged server
from the build's artifact (with `--no-tunnel`), `appimage.sh` runs with `--network none`, and their
images come from saved artifacts ("Test images" below). Inside the Playwright container, the
browsers and `ffmpeg` come with the image (`Dockerfile.e2e`), and `npm ci` (npm's own retries)
is not a pinned file, so the cache does not cover it.

Why: in 10x stability run 42046773993 (`soak/p10-0.5.2b`), `docker / Playwright in Docker x64`
failed in `e2e.sh` at `fetch-binaries`: the job had no download cache, so its only source was
github.com, which answered `HTTP 504` to all six tries in 62 s
(`https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/mediamtx_v1.21.3_linux_amd64.tar.gz`).

**One target per entry.** The first proof run of the mount (`Linux in Docker` 42052312402,
`soak/docker-dl-cache`) showed a second gap. On arm64 the container took both binaries from the
cache (5 files). On x64 the restored entry held 2 files and both binaries were downloaded again,
in the container and in `docker / Build linux-x64` alike. The key was
`sc-downloads-<OS>-<arch>-ffmpeg-<true|false>-<pins>`, and the first job to save it on `main`
after #122 was `build / web + windows-x64 package`, which runs `package.mjs --target windows-x64`
on Linux x64: its entry held the Windows MediaMTX and cloudflared. A key is saved once, and a job
whose exact key is found never saves it again, so every other Linux x64 job without ffmpeg (the
`docker` build, the desktop `linux-x64` build, and now `Playwright in Docker`) found that entry
and downloaded its own binaries from github.com on every run. The key now names the target whose
binaries the job fetches (`-for-<target>-`: `setup`'s `downloads-for` input, or the runner's own
OS and architecture), and the Windows package job passes `downloads-for: windows-x64`. The entries
under the old keys are no longer restored and expire after GitHub's 7 days without use.

### Test images

The Docker suites' test images (`scripts/test/docker/Dockerfile.*`) reach a gating job as
artifacts, never from a registry or a distribution mirror. Each image has a key, a hash of its
Dockerfile, its base (pinned by digest; the Playwright image by its version's tag) and the
architecture (`scripts/test/docker/images.sh`), and its archive is named by it
(`swarmcast-test-obs-latest-x64-<key>.tar.zst`). A job's set of images is one artifact,
`test-images-<arch>-<hash of their file names>` (one AppImage host, the clean-machine job's two,
OBS, the Playwright image):

- `./.github/actions/test-images` (input `images`: `appimage:ubuntu:22.04 appimage:ubuntu:24.04`,
  `obs`, `e2e`) asks the REST API for the artifacts of that name
  (`.github/scripts/test-images.mjs`, 30 s per try, 3 tries) and takes the newest one uploaded by
  a run of this repository on the default branch or on the job's own branch (like a cache scope:
  never a fork's pull request, whose runs upload here too) that does not expire within the hour;
  it downloads it through `fetch-artifact` into `$SC_TEST_IMAGES` and says what it found. A
  failed lookup or download is a miss, never an error.
- The suites `docker load` each archive, check its key label, and run it with
  `docker run --pull never`. A suite that finds no archive for its key builds the image (pull
  and apt with their tries, apt through the runner's own mirror list, the build log printed
  live) and saves it into `$SC_TEST_IMAGES`.
- `./.github/actions/test-images/save`, after the tests, uploads the job's set when the job built
  one of them (`built.txt`), with `compression-level: 0` (zstd already) and `retention-days: 90`.
  Any run saves, pull requests too: the scoping is in the restore.

Both are `continue-on-error` with a time limit (5 minutes; the Playwright image, about 1 GB, 8).
So `main` builds each key once and every run after that, of every branch, restores it; a pull
request that changes a Dockerfile builds its own once. Not the Actions cache: the images weigh
about 3.5 GB per pipeline (both architectures), the caches held 9.6 GB of their 10 GB on
2026-11-10 (GitHub evicts the least recently used entries above that: the Rust caches), and an
entry unused for 7 days is deleted, while the weekly `linux-docker.yml` runs 7 days apart; a
public repository's artifacts have no storage quota and are kept 90 days. Not ghcr.io either:
pushing needs `packages: write`, and a package is free beyond 500 MB only when it is public,
which only the repository owner can switch.

Why: release rehearsal 42757440898 lost four jobs, all in their image builds, while
archive.ubuntu.com answered at 210 kB/s (scripts/test/docker/README.md, "Test images").

### Rust crates

No job that runs cargo asks crates.io: the crates of `apps/desktop/src-tauri/Cargo.lock` reach it
as an artifact, `cargo-crates-<toolchain>-<hash of Cargo.lock>` (about 120 MB: what `cargo fetch
--locked` leaves in `$CARGO_HOME/registry`, the `.crate` files of every target platform and the
sparse index entries the lockfile resolves with), and cargo runs with `CARGO_NET_OFFLINE=true`.

- The build stage (`_build.yml`, `./.github/actions/cargo-crates/save`) looks the artifact up with
  `test-images.mjs`'s rules (the newest of that name from a run of this repository on the default
  branch or on the run's own branch, never a fork's, not about to expire). When there is none (the
  cold path: once per `Cargo.lock` or toolchain change on `main`, again after 90 days), it fetches
  the crates into a cargo home of its own (`cargo-crates.mjs fetch`, below), checks them and uploads
  them, before any cargo job starts. Not fatal: when it fails, each cargo job fetches the crates
  itself.
- `./.github/actions/setup-rust`, after rust-cache, runs `./.github/actions/cargo-crates` in every
  job that runs cargo (the five desktop builds, the node jobs' clippy, `cargo test` under
  cargo-llvm-cov and crate licences, the Docker stage's builds, the soak's Rust and DMG jobs):
  the same lookup (a release's tag counts as its own branch: `main`'s artifact or its own
  run's), the download through `fetch-artifact`, the tar extracted over what rust-cache restored,
  then `cargo-crates.mjs check`: every `.crate` must have the SHA-256 that `Cargo.lock` records
  (cargo checks that when it downloads a crate, not when it finds one in its cache, so a crate
  from the artifact is the one crates.io served), and `cargo metadata --offline` must resolve the
  lockfile for the host. Then `CARGO_NET_OFFLINE=true` goes into the job's environment, after
  rust-cache's step (a `CARGO_*` variable is part of rust-cache's key) and before any cargo
  command. A miss, a failed download or a failed check is a warning, and the crates come from
  crates.io (the cold path); cargo is offline after that too.
- The cold path, `cargo-crates.mjs fetch`: `cargo fetch --locked` (every platform), its output
  printed as it comes, each try cut off after 60 s (a whole fetch took 12 s), at most 3 tries 10
  and 30 s apart, one more only after a network failure or a cut-off try (each keeps what the
  earlier ones downloaded); anything else (a lockfile that needs an update) fails at once. A
  fetch that worked only after failed tries logs `infra recovery:` (docs/TESTING.md, "Infra
  recoveries"). When it fails in a cargo job, the job stops there with the cause.

Why: release rehearsal 42799834042 lost `desktop linux-arm64 / build (ubuntu-22.04-arm)` in its
licence check (`crate-licenses.mjs`, `cargo metadata --locked --filter-platform
aarch64-unknown-linux-gnu`), which had to download every crate: static.crates.io answered
`pxfm 0.1.30` with `206` and a partial body (`x-cache: Hit from cloudfront`), and cargo, which
counts only some answers as spurious, did not try again. Its rust-cache could not have helped:
a release-flavour build has no `CARGO_PROFILE_RELEASE_*` variables, so its key
(`v0-rust-linux-arm64-build-Linux-arm64-0203a50a-...`) never matches the test builds' entry that
`main` saves (`...-2ded1ba8-...`), and nothing saves a release-flavour entry; every rehearsal and
release build downloaded all its crates (372 on linux-x64, 297 on windows-x64 in that run; since
then they restore the test builds' entry, keyed as one: "Desktop builds" above). Nor
does a warm cache keep cargo off the network: rust-cache's clean-up keeps only the index entries
named after a package, so it drops the sparse index's `config.json`, and every cargo command of a
job with a full rust-cache hit printed `Updating crates.io index` and asked index.crates.io
(that run's `node / unit, integration, rust (ubuntu-24.04)`, in clippy). Not the Actions cache
for the crates: the caches held 9.6 of their 10 GB (see "Test images").

### Ubuntu packages

No gating Linux job asks the Ubuntu archive for a package while its saved set fits the runner
image: the Tauri build dependencies (`setup-rust`: the desktop and Docker builds, the node job's
Rust checks), the system libraries of Playwright's Firefox and WebKit (`_e2e.yml`, `rendering.yml`)
and the desktop test's AppImage host libraries and `.deb` dependencies (`_desktop.yml`) come from
the job's saved `.deb` set, installed by `.github/scripts/apt-debs.sh` with apt offline.

- `./.github/actions/setup` (input `apt-debs`, the set's name: `tauri-build`,
  `playwright-<hash of package-lock.json>`, `desktop-test-<target>`) restores the set into
  `$APT_DEBS`: its `.deb` files, `SHA256SUMS` (each file's SHA-256) and `made-on` (the runner image
  it was made on). Key: `apt-debs-v2-<ImageOS>-<arch>-<name>-<ImageVersion>-<hash of SHA256SUMS>`.
  The restore takes the newest entry for this runner image, else the newest for any image, else,
  for a name that ends in a hash, the newest for any hash.
- `apt-debs.sh` checks the set once per job (`sha256sum --check --strict`, and no other `.deb` in
  the folder; a set that does not match is not used, with a warning), then makes it apt's only
  source for the rest of the job: `/etc/apt/apt.conf.d/zzzz-sc-apt-debs` replaces every source
  with one flat repository, `file:$APT_DEBS` (a `Packages` index written from the files and their
  SHA-256), and gives apt a lists folder of its own. Every `apt-get` of the job sees only the set
  and the image, also with sudo and from other tools (Playwright's `install-deps --dry-run`, the
  desktop test's `apt-get install ./*.deb`): no `apt-get update` against the archive, nothing to
  download.
- Whether the set fits is apt's own answer: `apt-get install -s` of the request in that closed
  world. A set made on an older runner image fits unless the new image moved a package the set
  pins (a `-dev` package wants its library at its own version, `libgtk-3-dev` and `libgtk-3-0`);
  nothing on the image is downgraded. Then `apt-get install` from the set, and every named package
  must be installed after it.
- Only a set that does not fit (none saved yet, a runner image that moved such a package, a new
  package in a list) sends the job to the archive, through `apt-retry.sh` (a time limit per try,
  3 tries, another mirror): `apt-get update`, the missing `.deb` files downloaded into the set (apt
  checks each against the archive's signed index), and the request must then fit the closed world
  too. An `apt-get update` that could not fetch the archive's index is a failed try (apt itself
  exits 0 then, with old lists or none). When the archive does not answer, the step fails with
  `apt (infrastructure): ... the Ubuntu archive did not answer`, with the reason the set did not
  fit; nothing is skipped, and nothing is tested without its packages. A request that the archive
  cannot resolve either (a package that does not exist) is an `apt-debs` error instead.
- `./.github/actions/setup/save`, on `main`, saves a new entry only when the job had to fetch
  (`apt-debs.sh finish`): the `.deb` files the job used, plus the rest of the restored set when
  that was made on the same runner image (an older image's leftovers go). Main only, like the Rust
  cache: the set is installed as root, and a release build restores what `main`'s own runs saved.

**Transition from the `.deb` caches before sets.** When no `apt-debs-v2-*` entry restores, setup
also restores the cache the jobs used before (`apt-debs-<name>-<ImageOS>-<ImageVersion>-<arch>`,
its old path `*.deb`): this image's, else the newest for the same OS and architecture
(`apt-debs-<name>-<ImageOS>-2`, so `ubuntu22` never takes `ubuntu22-arm64`'s), and sets
`SC_APT_DEBS_LEGACY` to its key. Those hold the `.debs` a cold job downloaded and no manifest:
`apt-debs.sh` writes `SHA256SUMS` from the files at restore (they come from `main`'s own cache
scope, as the sets do) and uses them only as any set, when apt says they fit; the log and an
`apt (infrastructure)` error name the pre-v2 cache as the origin, and `finish` on `main` saves it
whole as the first set. Every list had one when sets came in (2026-11-11), each for the runner
image version the jobs ran on, and each held every package those jobs' apt installed in the last
green `main` run (51 to 181 per list), so the first runs need no archive either. Remove this step
once `main` has saved a set for every list.

So the archive is asked once per list and runner image change that moves a pinned package, by the
first jobs that need that set, and never by a job whose set fits. Not one producer job per run
(as the crates have): it would need the archive at the same moment as its consumers, so an outage
would fail it too; it would add a job per runner kind (`ubuntu-22.04`, `ubuntu-22.04-arm`,
`ubuntu-24.04`) ahead of the builds; and during a runner image rollout it and its consumers run on
different image versions anyway. A set from the previous image, checked by apt in the closed
world, is the "previous good" without one. Not an artifact either: the sets are small (about
0.45 GB in all), and the Actions cache's prefix restore gives that fallback.

Still reached at job time: the cold path above; the Docker test images' cold builds (inside their
containers: "Test images" above); `devices.yml`'s `gdb` for a crashed emulator's core (diagnostics
after a failure); the soak's `apt` suite, which times the cold path on purpose.

Why: in pipeline run 43034880513 (2026-11-11, from 14:05 UTC) neither azure.archive.ubuntu.com
nor archive.ubuntu.com answered, nor ports.ubuntu.com for arm64 (`Ign` for every `InRelease`, while
packages.microsoft.com did), and every Linux job that runs apt failed with `apt-get update failed
3 times (270 s)`: both Docker stage builds, both Linux desktop builds, the node job, the four
Ubuntu e2e groups and Ubuntu rendering. Each had restored its `.deb` cache for that exact runner
image and still ran `apt-get update` first: the cache was only apt's download folder, and apt
resolves a package against the archive's lists. Nor was a warm job independent of the archive
when it answered: apt fetched whatever the archive had updated since the cache was saved
(3.8 MB of GStreamer in `desktop linux-x64 / build` of run 43017518002), and that cache, saved
once per image, never held it.

### Release downloads

Files downloaded from `github.com/<owner>/<repo>/releases/download/...` while a job runs come from
the Actions cache, are checked against a SHA-256 pin, and are downloaded with tries only on a
cache miss; a job whose download still failed stops at that step with the cause, and no test runs
without what it needs. GitHub's release downloads are a service of their own: on 2026-11-08 they
answered `HTTP 504` for most of an hour, on and off, while githubstatus.com showed every service
as operational, and two pipeline runs of PR #141 (42465017555, 42466842103) went red in many jobs
for that alone. The `ci-deps` mirror (docs/RELEASING.md) is a release of this repository, so the
same outage reaches it. What did work during it: the Actions cache (another service), and the
same files through GitHub's REST API (`/repos/<owner>/<repo>/releases/assets/<id>`, a redirect to
release-assets.githubusercontent.com) while `releases/download/` answered 504 to every try.

**Last source: the GitHub API.** After a file's sources (its mirrors, then the publisher) failed,
`downloadFirst` in `fetch-binaries.mjs` tries each GitHub release URL among them once more
through the API: one lookup of the release by tag, then the asset as `application/octet-stream`,
with the usual tries and the SHA-256 check (`githubApiUrl`). No token, so at most 60 such requests
an hour per address; a refusal only fails that last source. Checked during the outage: the
macOS arm64 cargo-llvm-cov and pkg's macOS arm64 base binary, six 504s from `releases/download/`,
then the API on its first try (63 and 78 s in all), each logged `infra recovery: <url>
downloaded through the GitHub API (...)`.

| What | Where it came from in PR #141 | Now |
|---|---|---|
| MediaMTX, cloudflared, Pebble, the test ffmpeg, the AppImage tools | `fetch-binaries.mjs` from github.com: the `sc-downloads-*` entry restored for macOS arm64 held only the test ffmpeg (below) | the download cache holds what the jobs of its key fetched |
| cargo-llvm-cov | `taiki-e/install-action`, a download from github.com at every run (`curl: (56) ... 504` eleven times, exit 56) | pinned in `scripts/build/versions.json` (`testOnly`, SHA-256 values from install-action's own manifest), `fetch-binaries.mjs --only cargo-llvm-cov`, from the download cache |
| pkg's Node.js base binary | pkg-fetch, one GET to its GitHub release; on the 504 it compiled Node.js from source, which failed after 7 minutes (`make: *** [Makefile:143: node] Error 2`) | `scripts/build/pkg-base.mjs` before pkg runs: from the download cache, else `fetch-binaries.mjs`'s download (6 tries), checked against pkg-fetch's own SHA-256; a failure stops `package.mjs` with the reason, and pkg-fetch's dry run must say it will use that file, so it never downloads nor compiles |
| NSIS and its Tauri plugin (Windows desktop build) | `tauri build`, one GET each to `tauri-apps/binary-releases` and `tauri-apps/nsis-tauri-utils`, at every run | the Tauri CLI's tools folder (`%LOCALAPPDATA%\tauri`) restored from `sc-tauri-tools-*` (setup's `tauri-tools`), saved from `main` |

**The download cache saved what the first job had.** The key was
`sc-downloads-<OS>-<arch>-ffmpeg-<true|false>-for-<target>-<pins>`. An entry is saved once and a
job that restores its exact key never saves it again, so the first job to save a key decided what
every later job got. In run 42439987029 on `main` (the `versions.json` change for Pebble),
`desktop macos-arm64 / clean-machine` (ffmpeg for its preflight, nothing else) saved the macOS arm64
entry first, 28 MB with the test ffmpeg only; 70 s later `node / unit, integration, rust
(macos-latest)` could not save its fuller copy ("Unable to reserve cache ..., another job may be
creating this cache"). From then on the node and e2e jobs restored that exact key and downloaded
MediaMTX, cloudflared and Pebble from github.com at every run, until github.com answered 504. The
pkg cache (`sc-pkg-<OS>-<arch>-<lockfile>`) had the same flaw across targets: the `linux-x64`
desktop build restored its exact key and still had to download `node-v24.22.1-linux-x64` (the
Windows package job, which packages windows-x64 on Linux x64, shares that key).

Now `setup` records the files the restore brought, with their SHA-256 (`.github/scripts/cache-files.mjs
list`), and `setup/save` saves a new entry only when the job added files to them or changed one,
under `<prefix><pins>-<run id>-<hash of that list>` (`cache-files.mjs plan`). Content counts, not
only names: the download cache names its files by SHA-256, but the Tauri tools folder does not,
and a Tauri CLI update that pins another `nsis_tauri_utils.dll` makes `tauri build` download it
again over the old one. The restore takes the
newest entry for the current pins (`<prefix><pins>-`), else the newest of older pins (after a pin
change `fetch-binaries.mjs` deletes what is no longer pinned and downloads only the changed
files). The Windows quality and OBS suites have families of their own (`-app-ffmpeg-`,
`-obs-studio-`, setup's `app-ffmpeg` and `obs-studio`): they restore their own newest entry the
same way, else the plain entry's, for the current pins first. An entry holds what its job restored plus what it added, so a job that needs less (the
preflight's ffmpeg) adds nothing and saves nothing, and never replaces a fuller entry; a job that
failed before its downloads saves nothing either. Two jobs that add files at the same time each
save their own entry, and the next job that needs more adds the rest. pkg's base binary lives in
the same folder (`pkg-<sha256>-node-<version>-<platform>-<arch>`, pruned by `pkg-base.mjs`), so
the `sc-pkg-*` cache is gone, and the desktop builds and the soak's DMG job pass
`downloads-for: <target>` (macos-x64 is built on Apple silicon). `cache-hygiene.yml` deletes
the older entries of a key once a newer one is restored instead ("Caches").

**Jobs stop at the failed download.** `fetch-binaries.mjs` adds an `::error title=fetch-binaries::`
annotation with the cause, and the steps that run after a failed step on purpose (`!cancelled()`,
so one suite's failure does not hide another's results) now also need the steps they depend on:
the integration tests need `fetch-bins` (they failed with "cloudflared was not found at
.../vendor/macos-arm64/cloudflared" and "spawn .../pebble ENOENT"), the Rust steps need
`setup-rust` and `cargo test` needs cargo-llvm-cov (`_node.yml`), the viewer chat UI needs the e2e
step to have run (`_e2e.yml`), and the clean-machine checks need the job's setup and their
artifacts (`_desktop.yml`). A source that works only after failed tries logs
`infra recovery: <url> downloaded on try <n>` (docs/TESTING.md, "Infra recoveries").

Still downloaded from github.com at job time: on a cold cache (the first job after a pin, Tauri CLI
or pkg change, once per key), the `ci-deps` mirror and publisher URLs behind `fetch-binaries.mjs`
(with the API as their last source), and NSIS (one try each, by `tauri build`; a cold
`sc-tauri-tools-*` entry, then the build fails on a 504 as before).
Outside our control: github/codeql-action downloads its CodeQL bundle when the runner image's
copy is not the version it is linked to ("Unable to download and extract CodeQL CLI: Unexpected
HTTP response: 504" in the same outage, `codeql.yml`, not a required check). Not GitHub: the
WebView2 bootstrapper `tauri build` takes from go.microsoft.com, Playwright's browsers (their CDN,
cached on Linux), Rust toolchains (static.rust-lang.org), npm packages (the registry, `npm ci`'s
retry). Rust crates come from crates.io only on their cold path ("Rust crates" above).

## Caches

GitHub gives the repository 10 GB of Actions caches. Over that, it evicts the least recently used
entries, so a job can find `main`'s npm or Rust cache gone and do the whole download or compile
again (a cold run). The Docker suites' test images are artifacts, not caches, for that reason
("Test images" above). What is saved, all from `main` unless noted:

| Cache | Saved by | Entries | Size |
|---|---|---|---|
| `v0-rust-<target>-build-*` | `setup-rust` in the five desktop test builds (`_desktop.yml`); also restored, never saved, by the release-flavour builds | 5 | 0.41-0.69 GB each, 2.84 GB |
| `v0-rust-checks-node-*` | `setup-rust` in the Rust checks (`_node.yml`), per OS | 3 | 0.62-0.99 GB each, 2.42 GB (before `CARGO_PROFILE_DEV_DEBUG=0`) |
| `sc-downloads-*` | `setup/save`: the pinned downloads (on Linux also the AppImage tools, about 21 MB per architecture; with pkg's Node.js base binary in the jobs that package, 40-50 MB), per OS and with/without ffmpeg (pull requests too); one target per entry (`-for-<target>-`); the Windows quality and OBS suites have their own (`-app-ffmpeg-`: the app's ffmpeg zip, 0.17 GB more; `-obs-studio-`: the portable OBS zip, 0.22 GB more), which start from the plain entry until they exist; a new entry per run that added or changed files ("Release downloads"); also restored, never saved, by `Playwright in Docker` ("Pinned downloads in Docker") | 9 | about 1.3 GB |
| `node-cache-*-npm-*` | `setup` (`actions/cache` in `lookup-only` mode, its post step), per OS | 5 | 0.40 GB |
| `apt-debs-v2-*` | `setup/save`: the saved `.deb` sets (`apt-debs.sh`), per runner image OS, architecture and list, a new entry only when a job had to add to one ("Ubuntu packages") | 7-8 | about 0.45 GB |
| `ms-playwright-*` | `_e2e.yml`: Firefox and WebKit for Playwright | 1 | 0.21 GB |
| `sc-tauri-tools-*` | `setup/save` in the Windows desktop build: NSIS and its Tauri plugin ("Release downloads") | 1 | about 0.005 GB |
| `codeql-trap-*` | CodeQL's TRAP cache for JavaScript, one per analysed commit | 1 | 0.02 GB |

That is 7.2 GB on `main` in steady state (measured from the listing of 2026-11-01; GitHub counts
them as 6.7 GiB), about 6.4 GB once the Rust checks' caches are saved without debug info (a third
smaller: 1.77 GB to 1.19 GB for their target folder, measured on macOS). Every Rust entry is
needed: each pipeline restores all eight (one per job and target); none is saved outside `main`.

**`cache-hygiene.yml`** (`scripts/ci/cache-hygiene.mjs`, tested in `scripts/ci/test`) deletes what
nobody restores again, and prints each deletion with its reason and the size before and after:

- when a pull request closes, its caches (`refs/pull/<n>/merge`, `/head`); the sweep also catches
  any left behind (a fork's pull request, whose token cannot delete);
- the caches of a branch that no longer exists;
- on `main`, superseded entries. A family is the key with its hashes and versions taken out
  (`node-cache-Linux-x64-npm-*`, `v0-rust-checks-node-Linux-x64-*-*`, `codeql-trap-1-*-javascript-*`).
  It never deletes an entry whose key holds a hash of current `main`'s inputs (the same `hashFiles()`
  the workflows compute: the npm cache's three files, `package-lock.json`,
  `scripts/build/versions.json`, and `main`'s commit for CodeQL) and is the newest of its family
  with that hash (the download and Tauri tools caches save one entry per run that added or changed files,
  and the restore takes the newest), the newest
  or the most recently used entry of a family, nor an older entry still used after the newest was
  saved, within 24 hours (a run of an older commit, a pull request on an older base, a runner
  image version still being rolled out). An older entry last used before the newest was saved is
  superseded: a Rust or CodeQL cache rolls over that way (the run that saves the new entry
  restored the old one by prefix, then nothing does).

The sweep runs after every Pipeline and CodeQL run on `main` (once their caches are saved),
daily, and by hand: run `cache-hygiene.yml` from the Actions tab, with `dry-run` (the default) to
see the plan in the job's log and summary without deleting anything. It deletes only when it runs
from `main`'s own workflow file; from any other ref it is always a dry run.

Known limit: a `Cargo.lock` or toolchain change saves new entries for all eight Rust jobs in one
pipeline run (4-5 GB) while the old ones still exist; until the sweep after that run deletes the
old ones, the total can pass 10 GB and GitHub evicts the least recently used entries, which the
next run on `main` saves again.

**Incident (2026-11-01).** The caches had reached 10.94 GB in 95 entries: nine Rust entries on
`main` (one a superseded duplicate for macos-x64), npm and pkg entries for two old lockfiles next
to the current one, the `.deb` cache for three old lockfiles, 17 CodeQL TRAP caches (one per
commit on `main`), the npm caches of closed pull requests (#45, #46, #47, #53: 0.9 GB; setup-node
saved them because a pull request that changes a lockfile misses `main`'s key) and the Go caches
of deleted branches. In 10x stability run 41283774499, `desktop macos-x64 / clean-machine
(macos-15-intel)` found `main`'s npm entry but its download from the cache service stalled at 0 bytes
and was aborted ("npm cache is not found", setup-node took 126 s); `npm ci --prefer-offline` then
went to the registry on the slow Intel VM and the setup step ran out of time after 352 s in
`npm ci` (in 20 other runs that step took 24-61 s). The first sweep deletes 50 entries (3.3 GB):
the closed pull requests' and deleted branches' caches and every superseded entry on `main`.
Since then pull requests restore `main`'s npm cache without saving one (`setup`; restores have a time limit, see "Stalled cache restores"), and the Rust
checks build without debug info (`_node.yml`).

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
`actions/cache`'s own restore code (its `restore-only` entry point, in the copy it fetches with
git at the pin, see "Remote actions") as a child process, cuts a try off after 90 s (kills the
process group, so its `tar` too, and clears what the try may have half-extracted), and tries
once more after a try that timed out or failed; a plain miss is not retried. The npm cache is no
longer setup-node's: `setup` restores it with the same key and path (so existing entries keep
working) and saves it from `main` with `actions/cache` in `lookup-only` mode (its post step saves
when `main` has no entry for the key). And `setup` sets npm's `fetch-timeout` (the idle limit of
its connections) to 60 s and `fetch-retries` to 4 for the job, and runs `npm ci` once more after a
network error npm's own retries did not get past (npm does not retry a download that broke off
mid-transfer), or a failed download of prebuild-install in an install script
(`.github/scripts/npm-network-error.mjs`); any other `npm ci` failure fails the step.
Worst case for one stalled cache in `setup`: 2 x 90 s, then a cold `npm ci` (at most 47 s
measured, plus a minute per stalled request), about 5 minutes over a 24-61 s warm setup, under
the step's 8-minute limit. Not covered: the restore built into Swatinem/rust-cache
(`setup-rust`), which cannot be wrapped; `setup-rust`'s step limit applies to them.

Proved on `soak/cache-stall-sim` (Ubuntu, `iptables`): the cache's storage blocked for the first
100 s, setup took 114 s (try 1 cut off at 90 s, try 2 restored in 12 s; 12 s without a block, run
41294776882); blocked for good, 191 s (both tries cut off, then a cold `npm ci`); and with a 60 s
disruption of the registry during `npm ci` (one in five connections stops after 100 kB), a plain
`npm ci` failed with `ETIMEDOUT` after 110 s while `setup` took 201 s and passed (both restores cut
off, `npm ci` failed on `ETIMEDOUT`, the second run took 5 s; run 41295992201).

**Install scripts that download (2026-11-03).** `npm ci` on `main` after #102 (pipeline run
41664754395, `desktop macos-x64 / clean-machine (macos-15-intel)`) failed in node-datachannel's
install script: its prebuild-install download of the native binary from GitHub stopped at its 30 s
limit ("prebuild-install warn install Request timed out"), the build from source it falls back to
failed ("prebuild ERR! build TypeError: expected first argument to be an array") after installing
the package's own development dependencies for 3 minutes, and the step's pattern knew npm's errors
only. The npm cache would not have helped: prebuild-install keeps what it downloads in
`<npm cache>/_prebuilds` (npm hands install scripts `npm_config_cache`), which the npm cache
holds per OS and CPU, but #102 changed `setup/action.yml`, part of the key, and `main` restores
only its exact key, so its first run was cold. node-datachannel is a native WebRTC addon that only
bittorrent-tracker's client loads (through @thaunknown/simple-peer and webrtc-polyfill); SwarmCast
runs `bittorrent-tracker/server` and viewers use their browser's WebRTC, so nothing ever loaded it.
It is now a local stand-in (`apps/server/shims/node-datachannel`, an npm override like the `ip`
shim) that throws when loaded, so no install script in our lockfiles downloads anything, and
`scripts/ci/test/install-scripts.test.ts` fails on a new package with an install script until it
is looked at. The prebuild-install pattern stays for the next one.

## Coverage

Measured in the test steps that already run the suites (no extra test runs), on every OS that runs
them. Each job writes its coverage table (with the floors) into its job summary and uploads the
reports (lcov, json-summary, HTML) as `coverage-*` artifacts, kept 14 days.

| Suite | Jobs | How | Floors checked by |
|---|---|---|---|
| unit | node ×3 | `npm run coverage:unit`: Vitest, V8 | Vitest, in the test step |
| integration | node ×3 | `npm run coverage:integration`: Vitest, V8 (the code the tests run in-process) | Vitest, in the test step (this OS's floors) |
| e2e server | e2e ×4 | `NODE_V8_COVERAGE` on the Playwright step; `scripts/coverage/e2e-server.mjs` keeps the e2e server's files, c8 maps them onto the sources | `report.mjs --check`, after a passing run (this group's floors, lines) |
| desktop (Rust) | node ×3 | `npm run coverage:desktop`: `cargo test` under cargo-llvm-cov (pinned in `scripts/build/versions.json`, from the download cache: "Release downloads"; `llvm-tools` from `setup-rust`) | `report.mjs --check` |

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
  the place that needs it: apt, only when a job's saved `.deb` set does not fit its runner image (`apt-retry.sh` through `apt-debs.sh`; "Ubuntu packages" above), artifact downloads (`fetch-artifact`: a second try,
  then the REST fallback, each a warning), the uploads of artifacts a later job needs (`upload-build`:
  a second try, each try a step with its own time limit, the second when the artifact service
  answers again, a warning; "Artifact uploads" above), the remote actions our steps run (`fetch-remote`: a git
  fetch, 4 tries, each failed one a warning; the runner's own download stops at a 404, run
  41636784175), the pinned
  downloads (`fetch-binaries.mjs`; also the AppImage tools, through `appimage-tools.mjs`, so the
  Tauri bundler downloads nothing without a retry: run 42000871599, "AppImage tools" above; in the Playwright container from the download cache, "Pinned downloads in Docker" above), cache restores (`cache-restore`: one more try after a try that
  timed out or failed), npm's requests (`fetch-retries 4`, `fetch-timeout 60000`) and `npm ci` once more after a network error, npm's or a prebuild-install download's (`setup`, `npm-network-error.mjs`), the wait for github.com on macOS (a step before every checkout of a job that can run on macOS: one VM reached neither github.com nor the cache service for its first minute and lost a release run, another lost a 10x stability job when checkout's three tries could not resolve github.com, run 41283766285), the macOS `.dmg`
  bundling step (hdiutil "Resource busy", `desktop.mjs`), and, only when a Docker test image has
  no saved artifact yet ("Test images" above), its base image pull
  (`scripts/test/docker/pull.sh`) and its build: apt through `apt-retry.sh`, and the whole build
  once more after 60 s with `--no-cache` (`scripts/test/docker/build.sh`). The images are the
  test's scaffolding (a user, sudo, curl, ffmpeg, OBS... from the distribution's mirror), and a
  mirror serving a half-synchronised archive is outside our control: pipeline run 41273197813
  lost `docker / ubuntu:24.04 x64` when `apt-get` exited with 100 within seconds (2026-11-01
  05:38 UTC). Nothing that runs SwarmCast is retried there.
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
  limit. Uploads of test results, reports, coverage and logs, and the job-summary steps, are
  `continue-on-error` with a 5-minute limit. Nothing else is: a test, a build, a check or an
  upload of an artifact a later job needs that fails, fails the job (that upload after two tries,
  each with its own time limit, its failure named `infra:`; "Artifact uploads"). (Two pipelines of one soak batch lost a
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
  staged server (`release/staging/<target>`: the files in the server executable's pkg snapshot, no
  `node_modules`, `web/` the checked dist), or a desktop installer (each unpacked: the sidecar's
  snapshot, `web/`, no `node_modules`). It runs in `_build.yml` and `_desktop.yml` before their
  artifacts are uploaded, so the release publishes only checked installers. Run it locally after
  `npm run build` and `node scripts/build/package.mjs --target <host>`:
  `node .github/scripts/no-dev-deps.mjs --server --web --staging release/staging/<host>`.
- **Permissions:** every workflow starts from `contents: read`, plus `actions: read` in those that
  download artifacts (`fetch-artifact`'s REST fallback); a job that needs more says so
  (`codeql.yml`: `security-events: write`; `cache-hygiene.yml`: `actions: write` to delete caches; `site.yml` deploy: `pages`, `id-token`; `release.yml`
  publish: `contents`, `id-token`, `attestations`; `stats.yml`: `contents: write` for its branch).
  Checkouts use `persist-credentials: false`. Actions are pinned to a full commit SHA (those run
  from a git fetch, in `.github/actions/remote-pins/action.yml`; a new one of our actions that
  needs a remote action fetches it with `fetch-remote`, see "Remote actions").
- **Secrets:** only release jobs see the updater key. They name the `release` environment
  (deployment rule: tags `v*`), whose secrets no other job can read (docs/RELEASING.md, section 3).
  Pull request runs and release rehearsals (`release-flavour`) sign their builds with a throwaway key. Never reference `secrets.*` outside
  a release job (the other jobs use `github.token`).
- **Caches** are saved on `main` only and restored everywhere, so pull requests reuse `main`'s
  instead of filling the 10 GB repository limit (budget and clean-up: "Caches" above). One exception: the pinned-downloads cache
  (`sc-downloads-*`: the test ffmpeg, MediaMTX, cloudflared, Pebble, cargo-llvm-cov, the AppImage tools, pkg's Node.js
  base binary) is saved by pull requests too, because
  some publishers are very slow from GitHub's runners (the macOS ffmpeg at 10-30 kB/s): a pull
  request pays one slow download, its later runs restore it. A pull request cannot poison it:
  an entry saved by a pull request is restored only by that pull request's runs (GitHub scopes a
  cache to the ref that saved it; other refs see only their own and the default branch's), and
  each entry is a pinned file that `fetch-binaries.mjs`, `appimage-tools.mjs` and `pkg-base.mjs`
  use only when its SHA-256 matches its pin (`scripts/build/versions.json`, pkg-fetch's own
  list). The caches that are not checked when used (Rust's, and the Tauri tools with the NSIS
  that builds the Windows installer) are saved from `main` only: a release build (a `v*` tag)
  restores `main`'s entries, which only workflows running `main`'s own code write.
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
  guide's Windows pictures ("Running it by hand" above, with `release-flavour`).
