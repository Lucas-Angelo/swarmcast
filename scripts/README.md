# scripts

Build, release, CI and test scripts. SwarmCast ships only as the desktop app ([docs/DESKTOP.md](../docs/DESKTOP.md)):
the start and uninstall scripts of the old script mode were removed in 0.5.1 ([docs/DECISIONS.md](../docs/DECISIONS.md)).

**Build scripts** (`build/`):
- `fetch-binaries.mjs` (`npm run fetch-bins`): downloads MediaMTX and cloudflared for one target into `vendor/<target>/`, checked against the SHA-256 pinned in `versions.json` (`--with-ffmpeg` also bundles ffmpeg, for a packager who accepts the redistribution obligations).
- `package.mjs` (`npm run package`): stages the server of one target in `release/staging/<target>/` (the `@yao-pkg/pkg` executable, MediaMTX, cloudflared, the web pages, licences), which `desktop.mjs` turns into the app's sidecar and resources.
- `checksums.mjs`: writes `SHA256SUMS.txt`.
- `desktop.mjs` (`npm run desktop:build`): the desktop installers of one target from the staged server ([apps/desktop/README.md](../apps/desktop/README.md)); `updater-manifest.mjs` (`npm run desktop:manifest`): the updater's `latest.json`; `deb-version.mjs`: the `X.Y.Z~beta.N` Version field of a pre-release `.deb`.
- `licenses.mjs`: `THIRD_PARTY_LICENSES.txt` (npm production dependencies, MediaMTX, cloudflared, fonts); `crate-licenses.mjs`: the Rust crates of the desktop app, with a licence allowlist (`licenses/` holds the standard texts).
- `update-binaries.mjs`: newer MediaMTX / cloudflared releases within the same major (`--check` reports, without it rewrites `versions.json`); `gen-unicode-tables.mjs`: the chat's Unicode tables (`packages/shared/src/chat/*.generated.ts`) from the data pinned in `unicode-data.json` (`--check` compares); `strip-tags.mjs`: a linear tag stripper used by `crate-licenses.mjs`.

**Release, stats and CI scripts** (used by the workflows):
- `releases/`: `version.mjs` (classifies a release version for `release.yml`: channel, pre-release, Latest; `--on-branch` checks where the tag is), `semver.mjs`, `notes.mjs` (one `CHANGELOG.md` section as release notes), `beta-manifest.mjs` (the beta update feed `updates/beta.json`, built with the website).
- `stats/`: `stats.mjs` and `update.mjs`, the usage numbers from GitHub's public download counters (no telemetry), written to the `stats` branch by `stats.yml`.
- `ci/`: `soak-plan.mjs`, `soak-run.mjs` and `soak-report.mjs`, the stability soak of `soak.yml` (plan in `.github/soak-plan.json`).

**Test harnesses and tools** (`test/`; how to run the suites: [docs/TESTING.md](../docs/TESTING.md)). Some change the machine they run on, so they run only on CI runners or a throwaway VM:

| Path | What | Where it may run |
|---|---|---|
| `lib/` | shared helpers: ports (`ports.mjs`), processes, waits, ffmpeg, loopback | used by the tests |
| `chat/` | chat load bench (`bench.ts`, `bots.ts`, `scenarios.ts`) | anywhere (port 0, no data folder) |
| `surge/` | many people joining or turning P2P on at once (`bench.ts`, `viewers.ts`, `source.ts`, `tunnel.ts`, `scenarios.ts`; [docs/TESTING.md](../docs/TESTING.md#surge-bench)) | anywhere (port 0, no data folder) |
| `quality/` | quality experiments: `server.ts` + `bench.ts`, `simulate-controller.ts`, and by hand `debug-ladder.ts`, `probe-encoders.ts`, `install-ffmpeg.ts <dataDir>`, `menu-check.ts` | anywhere (own ports, temp data folders) |
| `docker/` | Linux suites in Docker ([docker/README.md](test/docker/README.md)) | anywhere with Docker |
| `tunnel-limit/` | measures a real quick tunnel's in-flight limit ([tunnel-limit/README.md](test/tunnel-limit/README.md)) | by hand (uses a real Cloudflare tunnel) |
| `windows/` | Windows app, Direct mode, quality and OBS suites on the staged server (`app.mjs` uses the real `%LOCALAPPDATA%\SwarmCast`) | CI only |
| `desktop/verify.mjs` | desktop installers on a clean machine: installs, autostart, deletes the data folder | CI only |
| `preflight/verify.mjs` | pre-release check of the staged server on a fresh OS (stream, watch, P2P, kick, stop, tunnel) | CI or a throwaway VM |
| `obs-e2e/` | real OBS + real tunnel + real browsers on macOS ([obs-e2e/README.md](test/obs-e2e/README.md)); writes OBS's own settings | a machine whose OBS you may change |

**Docs screenshots** (`docs/`): `screenshots.mjs` (`node scripts/docs/screenshots.mjs`, after `npm run fetch-bins` and `npm run build`; needs ffmpeg and Google Chrome) starts the e2e test server on the ports moved by `SWARMCAST_E2E_PORT_OFFSET` (default 1000, `SCREENSHOTS_OFFSET`), joins a few viewers and regenerates `docs/img/*-en.png` and `*-pt-BR.png` (panel overview, quality, protection, activity; viewer page on desktop and phone; join and "link not valid" pages) for the website (`site/`) and the README. The live link is replaced by a placeholder and the stream key is never shown.
