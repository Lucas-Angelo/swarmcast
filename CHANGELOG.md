# Changelog

All notable changes to SwarmCast are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-26

The desktop app release: SwarmCast now installs like any other app, opens in its own window and updates itself. The website is the single guide for streamers.

### Added

- **Desktop app** (Tauri 2, [docs/DESKTOP.md](docs/DESKTOP.md)) for Windows (`.exe` setup, per user, no admin prompt), macOS (`.dmg`, Apple silicon and Intel) and Linux (`.deb` and `.AppImage`, x64 and arm64), in English and Brazilian Portuguese. It opens the panel in its own window (with a splash page while SwarmCast starts and clear errors when it cannot), shows a tray / menu bar icon (Open, Start / Stop live, Check for updates, Export logs, Quit), asks before closing during a live, and runs the same server as the start scripts, sharing the same data folder and settings.
- **One-click updates in the desktop app**: it looks for a new stable version 10 s after starting and every 6 hours (plus "Check for updates"), shows the release notes, and after "Update now" downloads, verifies the signature, installs and reopens by itself. Settings are kept; if anything fails, the current version keeps working.
- **"Start with the computer"** in the desktop app (off by default): opens SwarmCast in the tray when you sign in, without a window and without turning the live on.
- Panel "Desktop app" card (start with the computer, version, check for updates) and an update banner with progress; on the first start of the desktop app, the computer check and the video converter install run in the background with progress, automatic retries and "Try again".
- **Website** for streamers and viewers (<https://lucas-angelo.github.io/swarmcast/>, English and Brazilian Portuguese, GitHub Pages from `site/`): a landing page, a download page that picks the right installer for your computer, install guides with the Windows/macOS warnings, OBS, going live, P2P, protection, direct mode, updates, uninstall and troubleshooting. It replaces the old Markdown tutorials; the offline guide in the installer zips is generated from the same pages, and the panel has a "Help" link to it. Usage numbers on the site come only from GitHub's public download counters (no telemetry).
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
- "Help the stream (P2P)" is on by default; a viewer who turns it off keeps it off. The explanation moved into its tooltip.

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

[Unreleased]: https://github.com/Lucas-Angelo/swarmcast/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lucas-Angelo/swarmcast/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lucas-Angelo/swarmcast/releases/tag/v0.1.0
