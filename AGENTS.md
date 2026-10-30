# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Copilot…) and the people who work with them.
Short on purpose: it links to the docs for depth. When a doc and the code disagree, the code wins; fix
the doc in the same pull request.

## Boundaries

- **Always:** keep the promises of §1; isolate every local run (§5); write English and Brazilian
  Portuguese text together; fix causes, not symptoms; run lint, typecheck and the tests of what you
  touched before pushing (§4, §7); update the docs your change makes wrong.
- **Ask the maintainer first:** anything on GitHub that deletes, hides or is hard to undo (branches, tags,
  releases, closing pull requests or issues, dismissing alerts, settings, rulesets, environments,
  secrets), tagging a release, and any new runtime dependency, outbound request or third-party service.
- **Never:** touch the maintainer's SwarmCast data, OBS, `/Applications`, the updater signing key or ports
  31935/38180/38181; force-push or rewrite pushed history; add AI or tool attribution anywhere; retry,
  skip or weaken a test to get green; commit secrets, stream keys, live links, tokens, real IPs or
  personal paths; add telemetry, accounts, paid services or hard-coded colours.

## 1. What SwarmCast is

A free, open-source (MIT) app for non-technical streamers: OBS streams to SwarmCast on the streamer's own
computer, and members watch in any browser through a secret link (no app, no account), help each other
with optional P2P, talk in a moderated chat and see the streamer's own page ("Your page"). Desktop app for
Windows x64, macOS (Apple silicon, Intel) and Linux (x64, arm64); website and the only streamer guide:
<https://lucas-angelo.github.io/swarmcast/>. The repository is public: whatever you push is public.

Promises no change may break ([CONTRIBUTING.md](CONTRIBUTING.md), "Ground rules"):

- **Free, no accounts:** no paid service and no sign-up, for streamers or viewers.
- **No telemetry:** the app never reports to the project (usage numbers come only from GitHub's public
  download counters); viewer pages contact only their own origin and STUN (GIFs only if the streamer turns
  them on and the viewer agrees).
- **Private by default:** members-only links, the stream key and viewers' data stay protected (§9).
- **Lay users:** plain, short words; errors say what to do next; installers and scripts never ask questions.
- **Two languages:** every text in the panel, viewer pages, desktop app, installers and website is in
  English and Brazilian Portuguese. Code, comments, commits and developer docs are English.
- **Sober look:** Forest & Cream ([assets/brand/README.md](assets/brand/README.md)), colours only through
  the `--sc-*` tokens, flat and calm; no purple or indigo, no neon, glows or gradients.

## 2. Architecture

1. OBS publishes RTMP to `127.0.0.1:1935` (only `live/<stream key>`); MediaMTX (child) makes fMP4 HLS on
   `127.0.0.1:8888`.
2. The server's `HlsOrigin` polls it (~1 s), keeps each segment in memory with its SHA-256 and signs a
   manifest (Ed25519); an optional ffmpeg ladder adds lower renditions.
3. The public server (`127.0.0.1:8080`) serves `/join`, `/watch`, `/hls/*` (session cookie, global upload
   limiter) and one WebSocket per viewer, `/control`, which also carries the P2P tracker and the chat.
4. **Secure mode** (default): a Cloudflare quick tunnel (`cloudflared` child, outbound only, ~120 viewers).
   **Direct mode** (opt-in): the streamer's IP, one port mapped by our UPnP-IGD/NAT-PMP client, a Let's
   Encrypt IP certificate or a self-signed one.
5. Viewers play with hls.js + p2p-media-loader; P2P is opt-in WebRTC (STUN only), and each segment from a
   peer is checked against the signed hashes before it plays.
6. The streamer's panel is on `127.0.0.1:8081` only (per-run token via `/auth/<token>`, state over `/ws`).

The desktop app is a Tauri shell running the same server as a sidecar (`swarmcast-server --desktop`, JSON
lines on stdio prefixed `@@swarmcast`); it shows the panel and updates itself from signed `latest.json`
feeds. Script mode installs the same executable with the start scripts and a Go tray helper.

Where to start reading:

- **Server** `apps/server/src` (Node 24, Fastify 5): `main.ts` (flags) → `app.ts` (wiring) → `core/live.ts`
  (start/stop, link, state); `public/server.ts` + `public/security.ts` (viewer routes, CSP), `access/`,
  `hls/`, `control/`, `tracker/`, `chat/`, `branding/`, `security/` (attack detector, proof-of-work,
  blocklists), `quality/`, `direct/`, `tunnel/`, `process/children.ts`, `desktop/`, `admin/*`.
- **Viewer** `apps/viewer` (plain TypeScript + Vite; `join.html`, `watch.html`, `invalid.html`):
  `src/join.ts`, `pow.ts`, `watch.ts`, `integrity.ts`, `peer-guard.ts`, `chat/`, `branding/`.
- **Panel** `apps/admin` (Preact + Vite): `src/main.tsx` → `App.tsx`; one file or folder per card
  (`QualityCard.tsx`, `Security.tsx`, `chat/`, `branding/`, `onboarding/`…); `api.ts` (REST and `/ws`).
- **Shared** `packages/shared/src` (used as source, no build): `schemas.ts` (zod wire types),
  `constants.ts`, `i18n/`, `chat/` (Unicode pipeline, nicknames, protocol), `branding/`, `mux.ts`.
- **Desktop** `apps/desktop/src-tauri` (Rust, Tauri 2): `src/main.rs` → `shell.rs` (state machine),
  `sidecar.rs`, `protocol.rs`, `updater.rs` (stable + beta feeds, never a downgrade), `window.rs`.
- **Packaging:** `apps/server/build.mjs` (esbuild bundle) → `scripts/build/package.mjs` (@yao-pkg/pkg
  executable with Node 24; MediaMTX and cloudflared pinned by SHA-256 in `scripts/build/versions.json`;
  ffmpeg is never shipped) → `scripts/build/desktop.mjs` (installers).

Diagrams and verified facts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); per-area docs in §10.

## 3. Repository layout

| Path | What |
|---|---|
| `apps/server`, `apps/viewer`, `apps/admin` | server, viewer pages, streamer's panel (npm workspaces) |
| `apps/desktop`, `apps/tray` | desktop app (`src-tauri/` Rust shell, `splash/`, mock server in `test/`); Go tray helper |
| `packages/shared` | schemas, constants, i18n, chat and branding logic, shared brand CSS (`web/`) |
| `site/` | website and guides (Astro Starlight; own `package-lock.json`, not a workspace) |
| `scripts/` | `start-*` / `uninstall-*` (release assets), `build/`, `releases/`, `stats/`, `ci/` (soak), `docs/`, `test/` (system harnesses) |
| `docs/`, `assets/brand/` | developer docs ([index](docs/README.md)); logo, icons, mascot, fonts, tokens |
| `.github/` | `workflows/` (`pipeline.yml` + reusable `_*.yml`), `actions/`, `scripts/`, `soak-plan.json` |
| `.claude/skills/`, `.claude/agents/` | Claude Code testing skill and test agent (the rest of `.claude/` is ignored) |

## 4. Setup and everyday commands

Node 24 (`.nvmrc`). Desktop: Rust 1.99.1 (`apps/desktop/src-tauri/rust-toolchain.toml`) and the Tauri
prerequisites. Tray: Go (`go.mod` 1.23, CI 1.27.x). Integration and e2e: ffmpeg (on `PATH` or `FFMPEG_BIN`)
and Google Chrome. Run from the repository root.

| Command | What |
|---|---|
| `npm ci && npm ci --prefix site` | install (`npm test` includes `site/test/unit`, which needs the site's packages) |
| `npm run lint && npm run typecheck` | ESLint, then `tsc --noEmit` in every workspace |
| `npm test` | Vitest unit tests (`apps/*/test/unit`, `packages/*/test`, `scripts/*/test`, `site/test/unit`) |
| `npm run build` | shared → viewer → admin → server, into `apps/*/dist` |
| `npm run fetch-bins` | MediaMTX and cloudflared for this OS into `vendor/<os>-<arch>/` (download, SHA-256 checked) |
| `npm run test:integration` | real MediaMTX + ffmpeg; after `fetch-bins` and `build` |
| `npm run test:e2e` | Playwright on Chrome, Firefox, WebKit (`--grep @ui` / `@media`); after `fetch-bins` and `build`; `npx playwright install firefox webkit` once |
| `npx playwright test -c apps/viewer/test/chat/playwright.config.ts` | viewer chat UI against a mock hub; after `npm run build -w @swarmcast/viewer` |
| `npm run desktop:test` | `cargo test`; in `apps/desktop/src-tauri` also `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings` |
| `cd site && npm run build && npm run check` | website build (fails on a broken link) and types; `npm run test:e2e` for its browser tests |
| `npm run dev -w @swarmcast/server -- --no-tunnel --no-tray --no-autostart` | the app from source (data in `.cache/dev-data`), after `build`, with the environment of §5 (arguments reach the server only through `-w`) |

Before pushing: `npm run lint && npm run typecheck && npm test` plus the suites of what you touched. Flags,
environment variables, `config.json` and the version policy: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md);
packages and installers: [apps/desktop/README.md](apps/desktop/README.md).

## 5. Safety when running things locally

The maintainer's computer runs a real SwarmCast and OBS. Nothing you run may touch them.

- **Data:** packaged builds (start scripts, desktop app) use the real data folder
  (`~/Library/Application Support/SwarmCast`, `%LOCALAPPDATA%\SwarmCast`, `~/.local/share/swarmcast`); a run
  from the source checkout defaults to `<repo>/.cache/dev-data`. Anything packaged you start gets
  `SWARMCAST_DATA_DIR="$(mktemp -d)"` (or `--data-dir`), and log exports `SWARMCAST_DOWNLOADS_DIR`.
- **No pop-ups:** `SWARMCAST_NO_OPEN=1` (no browser; server and desktop shell) and `SWARMCAST_NO_NOTIFY=1`.
- **Hands off:** OBS and its settings, `/Applications` and `~/Applications`, login and autostart items, the
  router (tests use the mock IGD). Never run the start or uninstall scripts or the installers on the host;
  their harnesses (`scripts/test/run.sh`, `scripts/test/uninstall.sh`) isolate themselves.
  `scripts/test/windows/`, `desktop/verify.mjs` and `preflight/verify.mjs` change the machine (CI or a
  throwaway VM only), and `obs-e2e/` rewrites OBS's own settings ([scripts/README.md](scripts/README.md)).
- **Processes:** stop only the PIDs you started; never `pkill` / `killall` SwarmCast, MediaMTX, cloudflared,
  ffmpeg or OBS.
- **Ports:** never bind, probe or kill 31935/38180/38181 (the maintainer's demo) or the defaults
  1935/8080/8081/8888. Tests listen on port 0 or use `scripts/test/lib/ports.mjs`. The e2e suite takes
  38080–38082, 38888 and 39935 plus `SWARMCAST_E2E_PORT_OFFSET`: one offset per concurrent run, never 100
  (it lands on the demo); check first with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- **Temporary files** go in `mktemp -d` folders or your session scratchpad, never in tracked paths or `$HOME`.
- **Updater key:** `~/.tauri/swarmcast-updater.key` and `.password` are the real release key: never read,
  copy, print, commit or build with them. Local desktop builds sign with a throwaway key, as `_desktop.yml`
  does: `node node_modules/@tauri-apps/cli/tauri.js signer generate --ci --password test --write-keys "$T/k"`,
  then `TAURI_SIGNING_PRIVATE_KEY="$(cat "$T/k")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test`. Builds with
  `--insecure-updates` are for local tests, never published.

## 6. Code conventions

- **TypeScript:** strict ESM (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`); relative imports end in `.js`, `import type` for types, `node:` built-ins; no
  `any`; unused names start with `_`. No formatter: follow `.editorconfig` and the code around you. Files
  `kebab-case.ts`, components `PascalCase.tsx`, constants `UPPER_SNAKE` with their unit
  (`PLAYLIST_WINDOW_S`), i18n keys dotted camelCase (`err.rtmpBusy`).
- **Comments** say why (a constraint, a measured fact, a browser quirk) and name the doc section they rely
  on; `/** */` on exported functions; Rust uses `//!` and `///`. Keep pure logic apart from wiring and
  inject the clock and IO (`now: () => number`) so it can be tested.
- **Validation:** a zod 4 schema for every request body, WebSocket message, file and config (wire types in
  `packages/shared/src/schemas.ts`, `config.json` in `apps/server/src/core/config.ts`); a shared module
  that builds schemas imports `./zod-config.js` first (jitless zod: browsers run it under a CSP without
  `eval`). A new config default or meaning bumps `CONFIG_VERSION` with a step in `migrateConfig`.
- **i18n:** keys and English in `packages/shared/src/i18n/en.ts`, the same keys in `pt-BR.ts` (type-checked;
  `apps/server/test/unit/i18n.test.ts` checks placeholders); `{name}` params, `{ one, other }` plurals; the UI
  calls `t()`. The server sends `CodedText` (`coded()` / `CodedError`, `apps/server/src/core/messages.ts`) and
  API errors `{ error, code?, params? } satisfies ApiErrorBody`, so clients translate by `code`. Desktop
  texts: `src-tauri/src/i18n.rs`. Each site page in `site/src/content/docs/` has a twin under `pt-br/`.
- **Logging:** pino (`apps/server/src/core/logger.ts`), `log.info({ fields }, 'plain lowercase message')`,
  errors as `{ err: err.message }`. Never log chat text, stream keys, links, tokens or IPs (redaction is a
  safety net, not a licence).
- **Panel (Preact):** function components with `preact/hooks`, `class=`, state from the `/ws` snapshot and
  calls through `api.ts`, exhaustive `Record<State, MessageKey>` label maps, `Info` tooltips,
  `useLayoutEffect` for anything measured or drawn.
- **DOM and CSS:** no inline scripts or `style=` (CSP; use `style.setProperty`); untrusted text (chat,
  nicknames, branding) only via `textContent` / text nodes, never `innerHTML` (ESLint enforces it in the
  `chat/` and `branding/` folders); no `v`-flag regex literals in viewer code; colours only from `--sc-*`
  tokens (`packages/shared/web/brand.css`).
- **Rust:** pinned toolchain, `cargo fmt`, clippy `-D warnings` with `clippy.toml`'s disallowed methods; keep
  `panic = "unwind"` and `abort_on_panic` (see `Cargo.toml`); tests in `#[cfg(test)] mod tests` per module.
- **Generated files** (regenerate and commit, never edit): `packages/shared/src/chat/*.generated.ts`
  (`node scripts/build/gen-unicode-tables.mjs`), `assets/brand/tokens.*` (`assets/brand/tools/palettes.py`),
  desktop icons (`npm run desktop:icons`), `docs/img/*.png` (`node scripts/docs/screenshots.mjs`),
  `site/public/og/*.png` (`npm run og` in `site/`); the offline guide comes from the site pages.

## 7. Testing

**The bar: 0 % failures in 100 % of runs, on every OS.** Retries are forbidden everywhere: `retries: 0` in
every Playwright config, no `--retries`, no Vitest `retry`, no `toPass` or retry loops around a step, no
re-running a job or workflow to get green. A single failure anywhere (CI, soak or local) is a bug, never "a
flake": find its cause in the product or the test, with evidence, and fix it at the root.

- Arrange / Act / Assert; no fixed waits (wait for the real condition or control the clock); no masking
  (longer timeouts, `skip`, weaker assertions, `force: true`); a bug fix comes with a test that fails without it.
- Independent, parallel-safe (own temp folder, port 0, restore what you change) and cross-OS by design.
- One green run proves nothing; stability is measured with the soak (`soak.yml`, `.github/soak-plan.json`).
- Everything else (suites, commands, flake catalogue, CI process): the testing skill
  [`.claude/skills/swarmcast-testing/SKILL.md`](.claude/skills/swarmcast-testing/SKILL.md) (plain Markdown,
  any agent can follow it), [docs/TESTING.md](docs/TESTING.md), and the agent
  `.claude/agents/swarmcast-test-engineer.md`.

## 8. Git, pull requests, CI and releases

- **Flow** ([docs/RELEASING.md](docs/RELEASING.md) §2): a short-lived branch from `main` (`feat/`, `fix/`,
  `docs/`, `ci/`, `chore/`), one topic per pull request, the template filled in. Squash merges only; the
  title becomes the commit on `main`: `type(scope): summary`, at most 72 characters
  ([CONTRIBUTING.md](CONTRIBUTING.md#pull-request-titles)); release pull requests are `SwarmCast vX.Y.Z`.
- **Changelog:** a change users notice adds a line under `## [Unreleased]` in `CHANGELOG.md`, written for
  streamers (it becomes the release notes); anything else gets the `skip-changelog` label.
- **History:** never force-push, rebase or amend what is pushed; update a branch by merging `main` into it;
  never push to `main`.
- **No attribution:** no `Co-Authored-By` lines for tools, no "Generated with…", no session links, in
  commits, pull requests, comments, release notes, code or docs. Commit as the person you work for (the
  maintainer's agents: his GitHub noreply identity, as in `git log`).
- **CI:** `.github/workflows/pipeline.yml` is the one entry point; its `ci-ok` job is the only required
  check of the ruleset "main: nothing red lands" (pull requests only, squash only, `ci-ok` green on a
  branch up to date with `main`, no force-push, no deletion, no bypass). Details:
  [.github/workflows/README.md](.github/workflows/README.md).
- **Watch** every job (not only `ci-ok`), every comment and review thread, and new CodeQL and Dependabot
  alerts while CI runs (`gh pr checks <n> --watch`, `gh run view <id> --log-failed`). **Merge** only when
  asked, with every check green on the exact head (`gh pr merge <n> --squash --match-head-commit <sha>`).
  `main` is never red.
- **Alerts:** fix CodeQL and Dependabot alerts at the root; dismissing one needs a verified justification
  and the maintainer's OK. Dependabot batches minor and patch updates weekly; majors are upgraded by hand.
- **Workflows:** `permissions: contents: read` by default, actions pinned to a full commit SHA (with a
  `# vX.Y.Z` comment), `persist-credentials: false`, secrets only in release jobs, retries only for network
  steps. Never dispatch soak or pipeline runs on `main`'s commit (a failure shows red on `main`): use a
  marker commit on a `soak/*` branch.
- **Releases** (only when the maintainer asks; [docs/RELEASING.md](docs/RELEASING.md) §4): a new minor
  ships as a beta first, `vX.Y.Z-beta.N` tagged on the head of its green release pull request
  (`release/X.Y.Z`, not merged yet) and verified ("Verify a beta"); only then `vX.Y.Z`, tagged on `main`
  after `SwarmCast vX.Y.Z` is squash-merged. Patch releases may skip the beta. A published release is never
  changed: a mistake ships as the next version.

## 9. Security

- Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (chat threats T1–T15, branding B1–B16, accepted risks)
  and [docs/SECURITY_RESEARCH.md](docs/SECURITY_RESEARCH.md) before changing access control, sessions,
  `/control`, the tracker, chat, branding, Direct mode, the CSP or the updater. Vulnerabilities are reported
  privately ([SECURITY.md](SECURITY.md)), never in a public issue.
- Everything binds `127.0.0.1`; the panel is never tunnelled and checks `Host`, `Origin` and its per-run
  token; WebSocket `Origin` must match `Host`; `X-Forwarded-For` is never read.
- CSP: viewer pages in `apps/server/src/public/security.ts` (`viewerCsp`), panel in
  `apps/server/src/admin/server.ts`: `script-src 'self'`, no inline code, no `unsafe-eval`. Never loosen it
  for a feature; the viewer CSP is the same with and without branding.
- Integrity: segment hashes go into the Ed25519-signed manifest and every P2P segment is checked before it
  plays (`apps/viewer/src/integrity.ts`); nothing from peers or viewers is trusted.
- Joins: 256-bit link secret, ticket cookie + 303, 10-minute sessions, rate limits, public IP blocklists
  and the ALTCHA proof-of-work browser check (`apps/server/src/security/`, `apps/viewer/src/pow.ts`).
- Secrets: `secrets.json` (stream key, signing keys) is mode 0600 and never logged; the updater key lives
  only in CI secrets and the maintainer's `~/.tauri/` (§5); log exports are anonymised
  (`apps/server/src/diagnostics/anonymize.ts`).

## 10. Where to find more

Index: [docs/README.md](docs/README.md). Read the doc of the area before changing it:

| Changing | Read |
|---|---|
| setup, flags, environment, `config.json`, version policy | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), [CONTRIBUTING.md](CONTRIBUTING.md) |
| media path, access control, tunnel, Direct mode, packaging | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| something that looks odd but may be on purpose | [docs/DECISIONS.md](docs/DECISIONS.md) (decisions, reasons, links) |
| anything security-relevant | [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), [docs/SECURITY_RESEARCH.md](docs/SECURITY_RESEARCH.md) |
| chat; "Your page" | [docs/CHAT.md](docs/CHAT.md); [docs/BRANDING.md](docs/BRANDING.md) |
| player, quality ladder, ffmpeg, upload budget | [docs/QUALITY.md](docs/QUALITY.md) |
| desktop shell, installers, updates | [docs/DESKTOP.md](docs/DESKTOP.md), [apps/desktop/README.md](apps/desktop/README.md) |
| tests | [docs/TESTING.md](docs/TESTING.md), [the testing skill](.claude/skills/swarmcast-testing/SKILL.md) |
| CI; releases and repository settings | [.github/workflows/README.md](.github/workflows/README.md); [docs/RELEASING.md](docs/RELEASING.md) |
| website and guides; brand | [site/README.md](site/README.md), [site/DESIGN.md](site/DESIGN.md); [assets/brand/README.md](assets/brand/README.md) |
| scripts; one component | [scripts/README.md](scripts/README.md); its `README.md` (`apps/*`, `packages/shared`) |
