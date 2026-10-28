# Changelog

All notable changes to SwarmCast are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-10-28

A reliability release: viewers no longer get stuck after OBS reconnects, the macOS app no longer crashes on "Update now", and the Windows uninstaller and "Stop everything" clean up completely.

### Fixed

- **Viewers no longer get stuck after OBS reconnects twice within a few seconds.** A very short OBS connection (common on a shaky upload) made the audio and the video count the stream's restarts differently; from then on the player loaded video but never audio and stayed on "Buffering" for every new viewer until the live ended. All of a stream's playlists now share one numbering. The same fix makes a quality added when OBS reconnects (for example 360p) play instead of buffering forever.
- **macOS: the desktop app no longer crashes when "Update now" is clicked right after login.** The app asked its window which page it showed before the first page had loaded; it now keeps track of the page itself.
- **Windows: the desktop app's uninstaller finishes, silently and completely.** Its own clean-up step stopped every program in the install folder, the uninstaller included, so its steps never ran. The uninstall script also starts it like a double-click now, and says why it stopped if it ever does not finish.
- **Windows: closing the start script's window stops SwarmCast.** On some Windows 11 builds the close never reached SwarmCast, which left the live, its ports and the tray icon running. The start script now watches its window and shuts SwarmCast down cleanly when it is gone (`SWARMCAST_NO_WINDOW_WATCH=1` turns this off).
- After a long stall, the video no longer jumps back and waits again: the stall watchdog no longer reloads a player that has just started playing again.
- Viewers using P2P no longer fetch the newest video pieces over HTTPS: every piece is signed before any playlist lists it, so other viewers can share it.
- "Stop everything" right after OBS leaves, or while the qualities restart (OBS reconnecting, a quality dropped under load), no longer leaves the video converter (ffmpeg) running or its files on disk. On Windows, deleting those files is retried while the antivirus or the indexer still holds one, and never makes "Stop everything" fail; stopping waits until the programs are really gone instead of a fixed time.
- Direct mode no longer sends your public IP address to a third party (a DNS-over-HTTPS query) when it checks that the stream address still answers, and no longer waits up to 5 s for that query when offline.

### Changed

- Direct mode picks its port between 20000 and 49151, outside the range where Windows (Hyper-V, WSL, Docker) reserves ports, and holds it with a real listen until the server starts. A taken port is skipped, and the log says whether Windows reserved it or another program uses it. If something fails after the router port was opened, it is closed again.
- Linux: the install guide lists the exact packages the AppImage needs on a minimal system, checked on bare Ubuntu 22.04, Ubuntu 24.04 and Debian 12.
- The desktop build checks that the SwarmCast server inside the Linux `.deb` and AppImage starts, so a broken package cannot be released.

### For contributors / CI

- Every failure keeps its evidence: Playwright reports and traces, server and fake-OBS logs (stream keys masked), Vitest JSON results and process/port dumps from the Windows suites.
- Deterministic tests: every test on its own ports (a per-worker port allocator, port 0 where possible), the fake OBS sends clips encoded once, each E2E test starts from a reset server and waits for a healthy stream (`/health`), polls instead of sleeps, and no serial mode (tests are tagged `@media` or `@ui`).
- One pinned, SHA-256-verified test ffmpeg on every OS, never shipped to streamers.
- apt that cannot hang a job, downloads retried with back-off and abandoned after 30 s without data, a working npm cache, and Ubuntu runners pinned to 24.04.
- New workflows: `soak.yml` (repeats suites and reports flaky checks) and `linux-docker.yml` (the Docker suites and the AppImage minimal-host check); the Windows suites take `--sections` and `--repeat`.
- Desktop builds: the macOS `.dmg` step is retried on its own, update-test builds are lighter, and Rust is pinned.
- CONTRIBUTING.md, a Code of Conduct, issue forms and a pull request template; the release process (branches, rulesets, hotfixes) is documented.
<!-- TODO: add the new pipeline (pipeline.yml) here once it is on release/0.2.2. -->

## [0.2.1] - 2026-10-27

### Changed

- **The delay behind live adapts to each viewer's connection.** With "Stable", the player starts about 20 s behind live as before, then drifts down to about 10–12 s on a steady connection (playing at most 5 % faster for a while, never jumping) and grows towards 30 s on shaky mobile data or after pauses, so the video pauses less. After a pause it moves back at once, inside that same pause, instead of pausing again later. "Lower delay" adapts between 6 and 10 s. The player looks at how fast video pieces arrive compared with how long they play, how steady the bandwidth is, pauses, whether the buffer keeps up with the live edge, and whether pieces came from other viewers (P2P); it never goes past what the server keeps of the stream (`MAX_PLAYER_DELAY_S`). Details: [docs/QUALITY.md](docs/QUALITY.md#adaptive-delay).
- Viewers see their delay next to the status ("~14 s behind live", with a tooltip), and the panel's viewers table shows each viewer's delay.

### Fixed

- The gentle catch-up after stalls (`maxLiveSyncPlaybackRate`) never ran: hls.js only uses it in low-latency mode. The new delay controller drives the playback speed itself.
- The panel's "PC check" in Portuguese showed some values in English ("free", "installed", "reachable"…); they are translated now.
- The Linux `.deb` listed `libwebkit2gtk-4.1-0` and `libayatana-appindicator3-1` twice in its dependencies.
- The Linux install guide says that the AppImage needs the usual desktop libraries (fonts, OpenGL) and that minimal installs should use the `.deb`.

## [0.2.0] - 2026-10-26

The desktop app release: SwarmCast now installs like any other app, opens in its own window and updates itself. The website is the single guide for streamers.

### Added

- **Desktop app** (Tauri 2, [docs/DESKTOP.md](docs/DESKTOP.md)) for Windows (`.exe` setup, per user, no admin prompt), macOS (`.dmg`, Apple silicon and Intel) and Linux (`.deb` and `.AppImage`, x64 and arm64), in English and Brazilian Portuguese. It opens the panel in its own window (with a splash page while SwarmCast starts and clear errors when it cannot), shows a tray / menu bar icon (Open, Start / Stop live, Check for updates, Export logs, Quit), asks before closing during a live, and runs the same server as the start scripts, sharing the same data folder and settings.
- **One-click updates in the desktop app**: it looks for a new stable version 10 s after starting and every 6 hours (plus "Check for updates"), shows the release notes, and after "Update now" downloads, verifies the signature, installs and reopens by itself. Settings are kept; if anything fails, the current version keeps working.
- **"Start with the computer"** in the desktop app (off by default): opens SwarmCast in the tray when you sign in, without a window and without turning the live on.
- Panel "Desktop app" card (start with the computer, version, check for updates) and an update banner with progress; on the first start of the desktop app, the computer check and the video converter install run in the background with progress, automatic retries and "Try again".
- **Website** for streamers and viewers (<https://lucas-angelo.github.io/swarmcast/>, English and Brazilian Portuguese, GitHub Pages from `site/`): a landing page, a download page that picks the right installer for your computer, install guides with the Windows/macOS warnings, OBS, going live, P2P, protection, direct mode, updates, uninstall and troubleshooting. It replaces the old Markdown tutorials; the offline guide in the installer zips is generated from the same pages, and the panel has a "Help" link to it. Usage numbers on the site come only from GitHub's public download counters (no telemetry).
- **Website link previews and SEO**: a link to the site pasted in WhatsApp, Discord, Telegram, X, Facebook, LinkedIn or iMessage shows a large preview card in the page's language; every page has its own title, description, canonical URL, language alternates and Open Graph / Twitter tags, the home pages carry structured data (JSON-LD), and there is a `robots.txt` and a bilingual "page not found" page.
- **OBS guide with real screenshots** (English and Portuguese, OBS shown in each language): stream the same scene to Twitch (or any platform) and SwarmCast with the Multiple output plugin, or a different scene (e.g. a movie in a browser window) with Aitum Vertical.
- **Illustrated usage guides** (English and Portuguese, the app shown in each language): installing on Windows and macOS, the first run and its tutorial, going live, kicking and new links, qualities, P2P, protection, start with the computer, updates, sending your logs and the viewer pages, each step with an annotated screenshot of the real 0.2.0 app (live links, stream keys and user names hidden), plus a Quick start page.
- **Forest & Cream brand**: the "broadcasting bee" symbol, wordmark, app and tray icons, favicons, a mascot, and one set of design tokens (light and dark) shared by the panel, the viewer pages, the desktop app and the website ([assets/brand/](assets/brand/README.md)).
- **Problem report → Export logs** (panel, and the tray in the desktop app): saves a zip to your Downloads folder with the last days of logs, app and system details and the settings, anonymised (IP addresses and nicknames replaced by labels; never the stream key, the live link, tokens or secrets). "Show in folder" opens it.
- English and Brazilian Portuguese for the panel and the viewer pages (from the browser language; `?lang=en|pt-BR` overrides and is remembered). Server texts carry stable codes so clients translate them.
- Tooltips (accessible (i) buttons that work with mouse, keyboard and touch) on every button, value and setting.
- Panel: "Activity" console (in-memory, last 500 lines, secrets and IPs scrubbed) with filters, copy and clear; OBS status pill and a hint while waiting for OBS; auto-stop countdown; Discord message language selector; warning when OBS keyframes are more than 3 s apart; setting to show or hide the viewer count.
- Viewer page: "Go live" button, viewer count badge.
- Attack protection ("Protection" card): an attack detector (requests, joins, refused joins, 429s, WebSocket upgrades, connections, TLS errors, distinct IPs; adaptive thresholds with hysteresis) with automatic reactions: a self-hosted proof-of-work browser check on join (ALTCHA protocol, "Checking your browser…"), temporarily stricter join limits, an optional automatic new link, and in Direct mode an automatic switch back to Secure mode (or Stop everything if that fails). Optional "Turn everything off if an attack is detected".
- Free public IP blocklists (Spamhaus DROP/DROPv6, FireHOL level1; no account), cached in the data folder and refreshed daily; refusals are counted in the panel and logged only as a network prefix.
- Panel settings for "Max viewers at once" and "Sessions per browser".
- Quality for viewers: viewers get a quality menu (Auto/1080p/720p/480p/360p) and a "Stable / Lower delay" switch (Stable, about 20 s behind live, is the default). The panel's "Quality for viewers" card shows what this PC can do (video converter, graphics-chip encoder or CPU fallback, estimated cost, renditions, upload budget per rendition), a "Stream in multiple qualities" switch with rendition checkboxes, and turns it on automatically when the PC supports it; the streamer's own choice is kept. PCs without a graphics-chip encoder get one small rendition only if a short CPU test shows clear headroom (at most 1 core). While live, renditions are dropped automatically if the converter falls behind or the CPU saturates, so OBS is never starved.
- The start scripts download the video converter (ffmpeg) from its publisher, verify it and keep it in `<data>/tools/ffmpeg` (`--no-ffmpeg` / `-NoFfmpeg` to skip). Releases publish the pins as `binaries.json`; the installer zips include it.
- The start scripts save their computer check to `<data>/system-check.json`, retry failed steps (2 s, 5 s, 10 s), and go back to the previous version if a new one does not start.
- Releases also publish the desktop installers, their update signatures (`.sig`) and the updater manifest `latest.json`; the release is published only after the full test suites pass.
- Licences: the desktop app's `THIRD_PARTY_LICENSES.txt` also lists the Rust crates it is built from (Tauri and its plugins, …), with their licence texts; the build stops if one has no licence or one outside the allowed list. The Fredoka and Inter font licences ship next to the fonts in the panel, the viewer pages and the website.

### Changed

- **Twice the audience on the free tunnel.** We measured that a Cloudflare quick tunnel counts every open WebSocket against its 200-requests-in-flight limit, so with two sockets per viewer it filled up at about 100 viewers. Viewers now keep one WebSocket (the P2P tracker rides on the control connection), and the tunnel holds about 120 viewers with room for the video. "Max viewers at once" now starts at 120 (a saved 500, the old default, becomes 120 once), and the panel warns when the tunnel gets close to its limit, counting open connections and requests. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#quick-tunnel-limit-measured-2026-10-26); measuring tool: `scripts/test/tunnel-limit/`.
- The panel and the viewer pages use the new brand: flat Forest & Cream look in light and dark, the real logo and mascot, Inter for text and Fredoka for the wordmark (all self-hosted).
- The browser check on join is on by default and done once per browser: a signed cookie remembers it (30 days on a fixed address; once per live with the free quick tunnel, whose address changes every live). It is asked again only when an attack needs a stronger check. Configs from v0.1.0 that saved the old default (`false`) are switched on once; turning it off afterwards is kept. The join page shows a progress bar while it checks.
- Logs: one file per day (`<data>/logs/swarmcast-YYYY-MM-DD.log`, cut at 5 MB), kept for 14 days by default (3 to 90 in Problem report → Advanced) and under 100 MB in total. The old `swarmcast.log` is removed by the same retention.
- The uninstall scripts also remove the desktop app, its shortcuts and its "start with the computer" entry (Windows: through the app's own uninstaller; macOS: only a `SwarmCast.app` with SwarmCast's bundle id; Linux: AppImages and menu entries, and they print the `apt remove` command for the `.deb`).
- The panel's "not authorized" page explains that the panel only opens from the SwarmCast app on this computer and how to reopen it, in English or Portuguese, with the brand.
- The start scripts never ask questions in the terminal: below the minimum they warn and continue. `--ask` / `-Ask` restores the question; `--yes` / `-Yes` still works.
- The header button is now "Turn on SwarmCast" (it starts SwarmCast, not OBS).
- "Help the stream (P2P)" is off by default; viewers can turn it on (and it stays on for them). The explanation moved into its tooltip.

### Fixed

- **P2P could freeze playback for good.** With the ladder on, the audio playlist covered only 20 s while the Stable profile plays 20 s behind live; a P2P request for a segment that had just left the playlist never started and never timed out, and hls.js recovery kept jumping outside the audio window. Now every playlist covers the furthest player delay plus a margin (derived from one shared constant), segments needed soon are fetched over HTTPS when no peer delivers them in time, slow peers are dropped, and a stall watchdog restarts loading by itself. The panel also has "Allow P2P for viewers" to turn P2P off for everyone at once.
- Panel login works on the first try from the desktop app and the browser: `/auth/<token>` sets the cookie and opens the panel from its own page instead of a redirect, so the `SameSite=Strict` cookie is always sent.
- Quitting while SwarmCast is still starting is immediate: the tunnel start, the speed test, the first-run check and the video converter download are cancelled instead of being waited for.
- Linux: the "start with the computer" entry is skipped once the app is removed (`TryExec`), instead of failing at every login.
- The panel page (`index.html`) is never cached, so the browser or the app window always loads the panel of the version that is running after an update.

### Security

- Desktop updates are signed (Ed25519) and verified before they are installed; the version inside the signature must match, so an old signed package cannot be passed off as a newer one, and `http://` update addresses are refused.
- The desktop app's window only keeps the panel's own address inside the app (other links open in the browser), and only its local splash page can talk to the app.
- The panel login page never repeats the token, is never cached and sends no referrer.
- Exported logs are anonymised: IP addresses and nicknames become per-export labels (an HMAC with a random salt), and secrets, the live link, tokens, PEM blocks, tunnel host names and the home folder are removed.

## [0.1.0] - 2026-10-25

First public release.

### Added

- Members-only live link per stream: viewers can only watch through the current secret
  link, which changes for every new stream.
- Nickname join: viewers pick a nickname to enter, and the host sees who is watching.
- Kick a viewer, or generate a new link that cuts off everyone holding the old one.
- Signed SHA-256 manifest of the HLS segments, so the player verifies every segment it plays.
- Optional viewer-to-viewer P2P delivery (WebRTC) that offloads the host's upload; segments
  received from peers are validated against the manifest hashes before playback.
- Remove a viewer from the P2P swarm manually, plus automatic removal of peers that
  repeatedly send segments failing the hash check (they keep watching from the server).
- Upload limit: cap the bandwidth SwarmCast uses for viewers.
- Cloudflare quick tunnel by default: a public HTTPS link with no port forwarding or account.
- Optional direct mode: automatic port mapping via UPnP/NAT-PMP and Let's Encrypt
  certificates for the public IP address.
- Tray / menu bar icon (Windows, macOS, Linux) with quick access to the panel and status.
- Periodic upload speed test with an estimate of how many viewers the connection can serve.
- One-script install, update and start for Windows, macOS and Linux; release archives
  ship with a `SHA256SUMS.txt` file and pinned, checksum-verified MediaMTX and cloudflared.

[Unreleased]: https://github.com/Lucas-Angelo/swarmcast/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Lucas-Angelo/swarmcast/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Lucas-Angelo/swarmcast/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Lucas-Angelo/swarmcast/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lucas-Angelo/swarmcast/releases/tag/v0.1.0
