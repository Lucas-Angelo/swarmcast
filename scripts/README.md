# scripts

**Start scripts** (script mode; most streamers use the desktop app instead, [docs/DESKTOP.md](../docs/DESKTOP.md)). Each one checks the computer, installs or updates for the current user without admin rights, verifies SHA-256, updates atomically with rollback, and starts SwarmCast. They are published as release assets.

| File | Platform |
|------|----------|
| `start-windows.ps1` | Windows (PowerShell; also `irm …/start-windows.ps1 \| iex`) |
| `start-windows.cmd` | Windows double-click wrapper for the `.ps1` |
| `start-macos.command` | macOS double-click (published also as `start-macos.sh` for `curl \| bash`) |
| `start-linux.sh` | Linux |

Flags: `--no-tunnel`, `--install-only`, `--smoke-test`, `--skip-speedtest`, `--no-ffmpeg`, `--ask`, `--yes`, `--help` (PowerShell also accepts `-NoTunnel`, `-NoFfmpeg`, `-Ask`, `-Yes`, …).

**No questions by default.** The users are not technical, so the scripts never wait for input in normal runs: a computer below the minimum gets a ⚠ warning (also in `install.log`) and the setup continues. `--ask` restores the old "Continue anyway? (y/N)" question; `--yes` answers it (kept so existing automation with `--yes`/`-Yes` keeps working). On Linux, missing `curl`/`tar` still need `sudo` (an OS requirement): the script says why in one sentence right before the password prompt. On errors the window stays open with what to do and "Press Enter to close" (the `.cmd` and `.command` wrappers), the only key the setup ever waits for.

**Video converter (ffmpeg).** After installing SwarmCast, the scripts read `binaries.json` (a release asset generated from `build/versions.json` by `build/binaries-json.mjs`, listed in `SHA256SUMS.txt`; the installer zips carry it too), download the pinned ffmpeg for the OS/arch **from its publisher**, verify its SHA-256 and install it into `<data>/tools/ffmpeg/` with a `PIN` stamp (`<version> <sha256>`) and `SOURCE.txt`. It lives outside `app/`, so updates do not download it again; a new pin downloads it once. Offline, a checksum mismatch, a missing `binaries.json` (older release) or `--no-ffmpeg` only skip it with a note: SwarmCast works with the original quality, and the panel keeps an "Install the video converter" button. SwarmCast never redistributes ffmpeg.

**Resilience.** Network calls keep their retries (2 s, 4 s, 8 s). Every local step (unpacking, the new-version check, the atomic swap/renames that antivirus scanners can briefly lock, the ffmpeg download+verify/unpack/copy, file writes) retries up to 3 times after 2 s, 5 s and 10 s, each attempt logged. If SwarmCast exits with an error within 10 s of starting it is started again (same waits); if that version was installed by this run, the previous version is put back first and started, with a one-sentence note. Only when the retries are exhausted does the script stop with a plain error.

**`<data>/system-check.json`.** The report the scripts print, saved atomically for the panel's first-run tutorial: `{ "version": 1, "at", "os", "arch", "results": [{ "id": "os|ram|cpu|upload|download|disk|ports|obs|github|release", "status": "ok|warn|fail|skipped", "value", "min", "recommended", "detail" }], "uploadMbps", "downloadMbps", "viewerEstimate", "belowMinimum": [ids] }`. Values are English; the panel translates by id and status.

Install source, first match wins (the script prints which one it uses):
1. `SWARMCAST_RELEASE_URL`, when set.
2. A **local bundle**: `SHA256SUMS.txt` and this platform's `SwarmCast-v*-<os>-<arch>.<zip|tar.gz>` in the script's own folder, as in the extracted `SwarmCast-vX.Y.Z-<target>-installer.zip`. Same SHA-256 check, atomic swap, rollback and "Already up to date" logic; the user's files are never deleted, and an older bundle never downgrades a newer install. The default URL is still checked once (no retries) for a newer version; being offline, or an HTTP 401/403/404 answer, is not an error (the bundle is used). On macOS the quarantine attribute is removed from the package only after it is verified. Piped runs (`curl | bash`, `irm | iex`) have no script folder and skip this.
3. The default release URL (`https://github.com/Lucas-Angelo/swarmcast/releases/latest/download`). Releases: [docs/RELEASING.md](../docs/RELEASING.md).

Tests: `bash scripts/test/run.sh` (macOS/Linux) and `scripts\test\run.ps1` (Windows PowerShell 5.1) run the scripts against a fake release on 127.0.0.1 (`test/make-fake-release.mjs`, which also writes `binaries.json` and a fake ffmpeg archive), including local bundle, ffmpeg (install, same pin, new pin, checksum mismatch, `--no-ffmpeg`, offline zip), no-questions/`--ask`, transient unpacking failure, crash-on-start rollback and `system-check.json` cases. Test-only hooks: `SWARMCAST_TEST_BELOW` (pretend a check is below the minimum) and `SWARMCAST_TEST_FAIL_ONCE=extract` (fail one step once). `start-linux.sh` and `start-macos.command` share most of their functions byte for byte: a change to one goes into both, and `test/test/start-scripts.test.ts` (part of `npm test`) fails when a function outside its OS-specific list differs.

**Uninstall scripts.** `uninstall-windows.cmd` (+ `.ps1`), `uninstall-macos.command` and `uninstall-linux.sh` are published as release assets and shipped in each installer zip. Double-click, no questions by default: they find the data folder (same rules as the start scripts, including `SWARMCAST_HOME`), stop the SwarmCast processes whose executable lives inside it (graceful first, forced after ~10 s; nothing outside the data folder is touched), run `swarmcast --cleanup` (removes a router port mapping a crash left in `state.json`), then delete the data folder, retrying busy files and listing anything that could not be removed. A folder with no SwarmCast files in it, the home folder and system folders are refused. Flags: `--keep-settings` (keeps `config.json` and `secrets.json`, so the stream key stays the same), `--ask` (confirm first), `--yes` (no-op), `--help`; PowerShell also accepts `-KeepSettings`, `-Ask`. They also remove the desktop app (docs/DESKTOP.md) and its "start with the computer" entry: Windows runs the app's own NSIS uninstaller silently (found by the HKCU Uninstall entry whose DisplayName is SwarmCast, run as `/S _?=<dir>` so the wait is real), then removes leftovers, its Start menu / desktop shortcuts, the `Run` value and `%LOCALAPPDATA%\io.github.lucas-angelo.swarmcast` (WebView2 data); macOS removes `SwarmCast.app` from /Applications and ~/Applications only when its CFBundleIdentifier is SwarmCast's (an /Applications the user may not change is reported, never sudo), the LaunchAgent (+ `launchctl bootout`) and the app's caches / WebKit data; Linux removes `SwarmCast*.AppImage` in ~/Applications, ~/Downloads and ~/.local/bin, the `*swarmcast*.desktop` menu entries that start them, the XDG autostart entry and the app's data / cache folders, and prints `sudo apt remove swarmcast-desktop` when that package is installed. Desktop processes (app, `swarmcast-server`, its mediamtx / cloudflared) are stopped only when they run from those folders; the app's `swarmcast-server --cleanup` is used when there is no script-mode `swarmcast`. OBS is never changed. Tests: `bash scripts/test/uninstall.sh` and `scripts\test\uninstall.ps1`.

**Build scripts** (`build/`):
- `fetch-binaries.mjs` (`npm run fetch-bins`): downloads MediaMTX and cloudflared for one target into `vendor/<target>/`, checked against the SHA-256 pinned in `versions.json` (`--with-ffmpeg` also bundles ffmpeg, for a packager who accepts the redistribution obligations).
- `binaries-json.mjs`: writes `binaries.json`, the pins of the tools SwarmCast does not ship (`"bundle": false`, i.e. ffmpeg), one asset per line so the bash scripts can read it without `jq`. The release workflow publishes it and puts it in the installer zips.
- `package.mjs` (`npm run package`): builds the per-platform release package.
- `archive.mjs`: creates the `.zip` or `.tar.gz`.
- `checksums.mjs`: writes `SHA256SUMS.txt`.
- `guide-html.mjs`: renders the website's guide pages (`site/src/content/docs/`, list in `site/offline-guide.json`) to the self-contained HTML guides shipped in the installer zips (no dependencies). Edit the site pages, never the generated HTML.
- `desktop.mjs` (`npm run desktop:build`): the desktop installers of one target from a staged package ([apps/desktop/README.md](../apps/desktop/README.md)); `updater-manifest.mjs` (`npm run desktop:manifest`): the updater's `latest.json`; `deb-version.mjs`: the `X.Y.Z~beta.N` Version field of a pre-release `.deb`.
- `licenses.mjs`: `THIRD_PARTY_LICENSES.txt` of a package (npm production dependencies, MediaMTX, cloudflared, the tray helper, fonts); `crate-licenses.mjs`: the Rust crates of the desktop app, with a licence allowlist (`licenses/` holds the standard texts).
- `update-binaries.mjs`: newer MediaMTX / cloudflared releases within the same major (`--check` reports, without it rewrites `versions.json`); `gen-unicode-tables.mjs`: the chat's Unicode tables (`packages/shared/src/chat/*.generated.ts`) from the data pinned in `unicode-data.json` (`--check` compares); `strip-tags.mjs`: a linear tag stripper used by `guide-html.mjs` and `crate-licenses.mjs`.

**Release, stats and CI scripts** (used by the workflows):
- `releases/`: `version.mjs` (classifies a release version for `release.yml`: channel, pre-release, Latest; `--on-branch` checks where the tag is), `semver.mjs`, `notes.mjs` (one `CHANGELOG.md` section as release notes), `beta-manifest.mjs` (the beta update feed `updates/beta.json`, built with the website).
- `stats/`: `stats.mjs` and `update.mjs`, the usage numbers from GitHub's public download counters (no telemetry), written to the `stats` branch by `stats.yml`.
- `ci/`: `soak-plan.mjs`, `soak-run.mjs` and `soak-report.mjs`, the stability soak of `soak.yml` (plan in `.github/soak-plan.json`).

**Test harnesses and tools** (`test/`; how to run the suites: [docs/TESTING.md](../docs/TESTING.md)). Some change the machine they run on, so they run only on CI runners or a throwaway VM:

| Path | What | Where it may run |
|---|---|---|
| `run.sh`, `run.ps1`, `uninstall.sh`, `uninstall.ps1` (+ `make-fake-release.mjs`, `serve.mjs`) | the start and uninstall scripts against a fake release on 127.0.0.1 | anywhere (temp folders, fake HOME for the uninstallers) |
| `lib/` | shared helpers: ports (`ports.mjs`), processes, waits, ffmpeg, loopback | used by the tests |
| `chat/` | chat load bench (`bench.ts`, `bots.ts`, `scenarios.ts`) | anywhere (port 0, no data folder) |
| `quality/` | quality experiments: `server.ts` + `bench.ts`, `simulate-controller.ts`, and by hand `debug-ladder.ts`, `probe-encoders.ts`, `install-ffmpeg.ts <dataDir>`, `menu-check.ts` | anywhere (own ports, temp data folders) |
| `docker/` | Linux suites in Docker ([docker/README.md](test/docker/README.md)) | anywhere with Docker |
| `tunnel-limit/` | measures a real quick tunnel's in-flight limit ([tunnel-limit/README.md](test/tunnel-limit/README.md)) | by hand (uses a real Cloudflare tunnel) |
| `windows/` | Windows installer, app, Direct mode, quality and OBS suites (`app.mjs` installs into the real `%LOCALAPPDATA%\SwarmCast`) | CI only |
| `desktop/verify.mjs` | desktop installers on a clean machine: installs, autostart, deletes the data folder | CI only |
| `preflight/verify.mjs` | pre-release check of a real release on a fresh OS | CI or a throwaway VM |
| `obs-e2e/` | real OBS + real tunnel + real browsers on macOS ([obs-e2e/README.md](test/obs-e2e/README.md)); writes OBS's own settings | a machine whose OBS you may change |

**Docs screenshots** (`docs/`): `screenshots.mjs` (`node scripts/docs/screenshots.mjs`, after `npm run fetch-bins` and `npm run build`; needs ffmpeg and Google Chrome) starts the e2e test server on the ports moved by `SWARMCAST_E2E_PORT_OFFSET` (default 1500), joins a few viewers and regenerates `docs/img/*-en.png` and `*-pt-BR.png` (panel overview, quality, protection, activity; viewer page on desktop and phone; join and "link not valid" pages) for the website (`site/`) and the README. The live link is replaced by a placeholder and the stream key is never shown.
