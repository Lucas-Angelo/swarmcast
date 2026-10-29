# CI and release workflows

How SwarmCast's GitHub Actions are put together. The release steps for the maintainer are in
[docs/RELEASING.md](../../docs/RELEASING.md); this page is about the machinery. (It lives here, not in
`.github/README.md`, because GitHub would show that one on the repository's front page.)

## Entry points

| Workflow | Runs on | What |
|---|---|---|
| `pipeline.yml` | pull requests, merge queue, push to `main`, monthly, by hand, called by `release.yml` | everything that tests the app; its `ci-ok` job is the one required check |
| `release.yml` | push of a `v*` tag | the pipeline in release flavour, then sign and publish the GitHub release |
| `site.yml` | push to `main` touching the site, after Usage stats, by hand | build and deploy the website (pull requests test it through the pipeline) |
| `codeql.yml` | pull requests and `main` (not docs-only), monthly | code scanning: TypeScript, Go, Rust, the workflows |
| `soak.yml` | the `soak` label on a pull request, by hand once on `main` | repeat suites from `soak-plan.json` and report pass rates and flakes |
| `linux-docker.yml` | weekly, pull requests touching the Docker suites | start script, package, AppImage and OBS on Ubuntu 22.04/24.04 and Debian 12, x64 and arm64 |
| `stats.yml` | daily, after a release | the public download counters, on the `stats` branch |

Files starting with `_` are reusable workflows (`workflow_call`), the stages of the pipeline.
They have no trigger of their own.

## The pipeline

```
changes ─┬─ quick ──────────────────────┬─ node ×3, e2e ×4, windows ×5 ──────────────┐
         ├─ build (web + windows pkgs) ─┤                                             ├─ ci-ok
         │                              └─ desktop <target> ×5: build ─ clean-machine ┤
         └─ site (when the site changed) ─────────────────────────────────────────────┘
```

| Stage | File | Jobs | What |
|---|---|---|---|
| changes | `pipeline.yml` + `.github/scripts/changes.sh` | 1 | which parts the change touches: `app`, `site`, `scripts` |
| quick | `_quick.yml` | 1 Ubuntu | lint, typecheck, unit tests, `npm audit`, upstream binaries check, the streamer guides, tray cross-builds and `go vet`, `cargo fmt` |
| build | `_build.yml` | 1 Ubuntu | `npm run build` → `web-dist`; the windows-x64 package and a "newer" one → `pkg-windows-x64` |
| desktop &lt;target&gt;: build | `_desktop.yml`, called once per target | 5 (2 macOS; macos-x64 is cross-built on Apple silicon and tested on Intel) | macOS/Linux: their package → `pkg-<target>`; every target: build A of the update test and the real installers → `desktop-<target>`, `update-test-<target>` |
| desktop &lt;target&gt;: clean-machine | same, after that target's build | 6 (Windows, macOS arm64 + Intel, Ubuntu 22.04, 24.04, 24.04 arm) | preflight (5 images), desktop install/update/uninstall (6), AppImage on a minimal host in Docker (2) |
| node | `_node.yml` | 3 (Ubuntu, macOS, Windows) | unit (macOS, Windows), integration (`integration` in parallel, then `integration-media`), clippy, `cargo test`, crate licences; the start and uninstall scripts when they changed (here, not in clean-machine, which is on the critical path) |
| e2e | `_e2e.yml` | 4 (Ubuntu, macOS × `ui`, `media`) | Playwright, all three browser projects; `media` is the `@media` tests, `ui` the rest, plus the `@media` file(s) in `MEDIA_WITH_UI` to balance the two |
| windows | `_windows.yml` | 5 | the Windows suites: installer, app, quality, direct, obs |
| site | `_site.yml` | 1 | the website's unit, type, link and browser tests and the streamer guides |
| ci-ok | `pipeline.yml` | 1 | the verdict, plus the Windows suites' summary table |

That is 27 jobs for a change to the app (7 on macOS), 28 when it also touches the site. GitHub
Free runs 20 jobs at once, 5 of them on macOS.

**Build once.** `npm run build` runs once per pipeline (`build`), `package.mjs` six times (two
Windows packages, one per macOS and Linux target) and `tauri build` ten times (A and the real
build per target). Every test job downloads those artifacts, so all of them test the same bytes.
The artifacts are tar files, because `upload-artifact` drops the executable bit;
`.github/actions/get-build` downloads and unpacks them. They are kept 3 days for pull requests and 14 days
otherwise.

**Desktop builds.** A (`0.0.0-test.1`) is a `--fast` build that accepts `http://` update URLs and
trusts the key that signed the real build. The clean-machine test updates A to the real installers
through a `latest.json` it writes and serves on `127.0.0.1`. Pull requests and `main` build the
release profile without LTO and with 16 codegen units (`CARGO_PROFILE_RELEASE_*`, so the
`tauri bundle` step that retries the macOS `.dmg` still finds the binary) and sign with a key pair
made in the job. A release builds with `Cargo.toml`'s profile (fat LTO) and the real updater key.

**What a change runs** (`.github/scripts/changes.sh`):
- `app` is anything except `docs/`, `site/`, `*.md` and the files only other workflows read (soak,
  Docker suites, CodeQL, stats, Dependabot, issue forms). Without it every app stage is skipped.
- `site` is `site/`, the screenshots, the brand assets, the shared translations, the actions and
  these workflow files.
- `scripts` is `scripts/` (not `scripts/ci` or `scripts/test/docker`), the actions and the
  node workflow (where those tests run): the install-script tests run only then, as before.
- Monthly, by hand and on a release, everything runs. When git cannot tell (a new branch, a force
  push), everything runs too.

**`ci-ok`** runs with `if: always()`. It is red when a stage failed or was cancelled, when
`changes` did not succeed, or when a stage that the change needs was skipped (for example after an
upstream failure). It is green with every stage skipped for a docs-only change, within a minute.
Branch protection requires only this check, so the stages can change without touching the
ruleset (docs/RELEASING.md, section 2).

**Concurrency.** A newer push to a pull request cancels its running pipeline. Runs on `main`, tags,
schedules and releases are never cancelled.

## Shared pieces

| Path | What |
|---|---|
| `.github/actions/setup` | Node.js and `npm ci` with the npm cache; optional Go, the pinned test ffmpeg (`FFMPEG_BIN`), the download caches and a `.deb` cache (`apt-debs`); apt settings that retry |
| `.github/actions/setup/save` | last step of a job: saves the caches it filled, on `main` only |
| `.github/actions/setup-rust` | the toolchain from `apps/desktop/src-tauri/rust-toolchain.toml`, rust-cache (saved on `main` only), the Tauri build dependencies on Linux |
| `.github/actions/get-build` | downloads and unpacks this run's build artifacts |
| `.github/scripts/apt-retry.sh` | apt with a time limit per try, retries and a mirror switch; `install`, `download`, `playwright-deps` |
| `.github/scripts/changes.sh` | the `changes` job |
| `.github/soak-plan.json` | what `soak.yml` repeats |

## Rules

- **Permissions:** every workflow starts from `contents: read`; a job that needs more says so
  (`codeql.yml`: `security-events: write`; `site.yml` deploy: `pages`, `id-token`; `release.yml`
  publish: `contents`, `id-token`, `attestations`; `stats.yml`: `contents: write` for its branch).
  Checkouts use `persist-credentials: false`. Actions are pinned to a full commit SHA.
- **Secrets:** only release jobs see the updater key. They name the `release` environment
  (deployment rule: tags `v*`), whose secrets no other job can read. Pull request runs sign their
  test builds with a throwaway key.
- **Caches** are saved on `main` only and restored everywhere, so pull requests reuse `main`'s
  instead of filling the 10 GB repository limit. One exception: the pinned-downloads cache
  (`sc-downloads-*`: the test ffmpeg, MediaMTX, cloudflared) is saved by pull requests too, because
  some publishers are very slow from GitHub's runners (the macOS ffmpeg at 10-30 kB/s): a pull
  request pays one slow download, its later runs restore it. A pull request cannot poison it:
  each entry is a pinned file, and `fetch-binaries.mjs` uses it only when its SHA-256 matches
  `scripts/build/versions.json`.
- **Releases are never edited after publishing:** `release.yml` uploads to a draft, checks every
  asset, attests them (`actions/attest`, verify with `gh attestation verify <file> -R
  Lucas-Angelo/swarmcast`) and then publishes the draft.
- **Retries** are for the network, not for tests: apt, downloads and the macOS `.dmg` step
  (hdiutil "Resource busy") retry; a flaky test is fixed, not rerun.
- **Job names** read `<stage> / <what> (<runner>)` in the checks list.
- **Windows options:** run `pipeline.yml` by hand with `windows-runners` (for example
  `["windows-2022","windows-11-arm"]`) and `windows-suites`, or `screenshots` for the website
  guide's Windows pictures.
