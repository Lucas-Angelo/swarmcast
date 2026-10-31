# Design decisions

An index of the decisions SwarmCast is built on: what was decided, the reason in one line, and the
document that explains it. The reasons and the evidence stay in the linked sections; this page only
helps you find them before you change something that was chosen on purpose.

When you make a decision that someone could otherwise undo by accident, explain it in the document of
its area and add a row here in the same pull request.

## Product

| Decision | Why | Details |
|---|---|---|
| Free, no accounts, no telemetry; usage numbers only from GitHub's public download counters | the promises to streamers and viewers | [CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules-for-changes), [RELEASING.md §6](RELEASING.md#6-github-pages-and-usage-numbers) |
| Every text in English and Brazilian Portuguese; installers and scripts never ask questions | the users are not technical, many are in Brazil | [CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules-for-changes), [scripts/README.md](../scripts/README.md) |
| The website is the only guide for streamers and viewers; the offline guide in the installer zips is generated from it | one place to edit, both always say the same | [site/README.md](../site/README.md), [RELEASING.md §5](RELEASING.md#5-what-a-release-publishes) |
| Forest & Cream palette, colours only through the brand tokens, no purple | calm and trustworthy, kept apart from other brands | [assets/brand/README.md](../assets/brand/README.md#palette-forest--cream-chosen), [site/DESIGN.md](../site/DESIGN.md) |

## Runtime and packaging

| Decision | Why | Details |
|---|---|---|
| One executable built with `@yao-pkg/pkg` (embedded Node 24), not Node SEA | SEA is still in active development and untested upstream on macOS x64 | [ARCHITECTURE.md](ARCHITECTURE.md#packaging) |
| A reaper child (`swarmcast --reaper`) kills the children if the app dies, instead of Job Objects or `PR_SET_PDEATHSIG` | works from a single executable without native addons | [ARCHITECTURE.md](ARCHITECTURE.md#live-lifecycle) |
| Own Go tray helper (fyne.io/systray) for script mode | no maintained cross-platform tray library for Node | [ARCHITECTURE.md](ARCHITECTURE.md#verified-facts-2026-10-25) |
| Desktop app on Tauri 2, not Electron, around the same server | the server already embeds Node; Tauri uses the OS webview and adds ~10 MB | [DESKTOP.md](DESKTOP.md#why-tauri-and-not-electron) |
| Release profile keeps `panic = "unwind"` plus a hook that aborts on any Rust panic | WebKit's Objective-C exceptions must be catchable on macOS | `apps/desktop/src-tauri/Cargo.toml`, `src/main.rs` |
| ffmpeg is never shipped: each computer downloads the pinned build from its publisher and checks its SHA-256 | licence obligations of redistribution | [DEVELOPMENT.md](DEVELOPMENT.md#configuration) ("ffmpeg licensing"), [QUALITY.md](QUALITY.md) |
| Third-party binaries pinned by SHA-256; npm `^` ranges with an exact lockfile; majors upgraded by hand | no surprise major release breaks a build | [DEVELOPMENT.md](DEVELOPMENT.md#version-policy) |
| A run from the source checkout keeps its data in `<repo>/.cache/dev-data` | development never touches the real SwarmCast data of the computer | `apps/server/src/core/paths.ts`, [apps/server/README.md](../apps/server/README.md) |

## Streaming and network

| Decision | Why | Details |
|---|---|---|
| Standard fMP4 HLS (not LL-HLS) with 2 s segments; the default "Stable" player starts 20 s behind live and adapts per viewer between 10 and 30 s | stability from a bigger buffer, not longer segments; segments can travel between peers before they are needed | [QUALITY.md](QUALITY.md#summary-of-decisions), [QUALITY.md](QUALITY.md#adaptive-delay) |
| Extra qualities from one ffmpeg process SwarmCast manages (GPU encoder, or one small CPU rendition), not OBS multitrack or MediaMTX `runOnReady` | OBS multitrack works only on the main output and MediaMTX serves one video track; one managed process keeps the renditions aligned and within the reaper's reach | [QUALITY.md](QUALITY.md#2-multi-quality-options) |
| Cloudflare quick tunnel by default, `maxViewers` 120 | no account or domain needed; the measured in-flight limit holds about 120 viewers | [ARCHITECTURE.md](ARCHITECTURE.md#quick-tunnel-limit-measured-2026-10-26) |
| One WebSocket per viewer: the tracker rides inside `/control`; WebSockets, not SSE | quick tunnels count every open socket and do not support SSE | [ARCHITECTURE.md](ARCHITECTURE.md#network-services) |
| P2P is opt-in, STUN only (no TURN), and every peer segment is checked against an Ed25519-signed SHA-256 manifest | viewers' IPs and the stream's integrity | [ARCHITECTURE.md](ARCHITECTURE.md#viewer), [THREAT_MODEL.md](THREAT_MODEL.md#residual-risks-accepted) |
| Direct mode is opt-in and never automatic: one random port, Let's Encrypt IP certificate, own UPnP-IGD and NAT-PMP clients | it exposes the streamer's IP | [ARCHITECTURE.md](ARCHITECTURE.md#direct-mode-opt-in), [SECURITY_RESEARCH.md](SECURITY_RESEARCH.md#3-if-direct-mode-is-used-anyway-honest-limits) |
| Own minimal ACME client (RFC 8555), not a library | Let's Encrypt IP certificates need IP identifiers and ACME profiles, which the common Node library did not support; it is tested against Pebble | `apps/server/src/direct/acme.ts`, [ARCHITECTURE.md](ARCHITECTURE.md#verified-facts-2026-10-25) |

## Code

| Decision | Why | Details |
|---|---|---|
| Pure dependency injection: constructor options wired in one composition root (`apps/server/src/app.ts`), no DI container | the object graph stays small and explicit; tests pass fakes through the same options | [ARCHITECTURE.md](ARCHITECTURE.md#components), [apps/server/README.md](../apps/server/README.md) |
| Own typed i18n (`packages/shared/src/i18n`), not i18next or FormatJS | small, runs under the strict CSP, the key set is type-checked in both languages and shared by the server, viewer pages and panel | [packages/shared/README.md](../packages/shared/README.md) |

## Security and privacy

| Decision | Why | Details |
|---|---|---|
| Everything binds 127.0.0.1; the panel is never tunnelled and needs a per-run token | nothing listens publicly in the default mode | [THREAT_MODEL.md](THREAT_MODEL.md#mitigations) |
| No IP bans: kicks block the device cookie, and "Generate new link" closes the rest | mobile CGNAT puts many members behind one IP | [ARCHITECTURE.md](ARCHITECTURE.md#access-control) |
| Self-hosted proof-of-work (altcha-lib, no widget), remembered per browser | raises the cost of scripted joins without a third party | [SECURITY_RESEARCH.md](SECURITY_RESEARCH.md#implemented-attack-detection-reactions-proof-of-work-blocklists) |
| Strict CSP without inline code or `unsafe-eval`; zod runs jitless | XSS defence in depth | `apps/server/src/public/security.ts`, `packages/shared/src/zod-config.ts` |
| Binaries are not code-signed by default; desktop updates are always signed with the updater key | certificates cost money every year; updates must still be trusted | [RELEASING.md §7](RELEASING.md#7-code-signing-optional-paid), [DESKTOP.md](DESKTOP.md#updates) |

## Chat and "Your page"

| Decision | Why | Details |
|---|---|---|
| The chat rides on `/control` with its own frame budget and at most 5 % of the upload cap | it must never cost the video or a tunnel slot | [CHAT.md](CHAT.md#flood-protection-and-the-video-budget) |
| Untrusted text only through `textContent` after a shared Unicode pipeline; links are never clickable | other viewers' devices must not freeze or crash | [CHAT.md](CHAT.md#unicode-pipeline), [THREAT_MODEL.md](THREAT_MODEL.md#chat-v040) |
| Nicknames: one alphabet, no emoji or invisible characters, unique by confusable skeleton | nicknames are public in the chat | [CHAT.md](CHAT.md#nicknames-rules-v2) |
| GIFs off by default; the streamer's own key; each viewer agrees before contacting the provider | the provider sees viewers' IPs | [CHAT.md](CHAT.md#gifs) |
| "Your page" is members-only, sent as `Cache-Control: private`; pictures re-encoded by the panel's canvas | privacy of the streamer's identity and of metadata | [BRANDING.md](BRANDING.md#decisions) |

## Process

| Decision | Why | Details |
|---|---|---|
| Trunk-based flow: short branches, squash merges only, `ci-ok` the only required check | one maintainer, a readable `main`, a ruleset that does not change with the stages | [RELEASING.md §2](RELEASING.md#2-branches-pull-requests-and-protection), [workflows README](../.github/workflows/README.md#the-pipeline) |
| Build once per pipeline, test the same bytes everywhere | what is tested is what ships | [workflows README](../.github/workflows/README.md#the-pipeline) |
| Tests: 0 % failures in 100 % of runs on every OS, no retries anywhere; retries only for network steps | a test that passes sometimes is a failing test | [TESTING.md](TESTING.md), [workflows README](../.github/workflows/README.md#rules) |
| Every version ships as at least two betas first; published releases are never changed | installed apps update by themselves | [RELEASING.md §4](RELEASING.md#4-ship-a-release) |
| CI downloads slow third-party files from byte-identical copies in the `ci-deps` pre-release | some publishers are very slow from GitHub's runners | [RELEASING.md §8](RELEASING.md#8-mirrored-ci-dependencies-ci-deps) |
| Media Foundation on the Windows Server runners is enabled with DISM, not `Install-WindowsFeature` | Server Manager scans every feature twice (2-3.5 minutes of CPU-bound servicing work, once more than 14); DISM takes 6-18 s | `.github/scripts/media-foundation.ps1` |
