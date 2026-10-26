# Changelog

All notable changes to SwarmCast are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Website for streamers and viewers (<https://lucas-angelo.github.io/swarmcast/>, English and Brazilian Portuguese, GitHub Pages from `site/`): download with OS detection, install guides with the Windows/macOS warnings, OBS, going live, P2P, protection, direct mode, updates, uninstall, FAQ. It replaces `docs/TUTORIAL_EN.md` and `docs/TUTORIAL_PT-BR.md`; the offline guide in the installer zips is generated from the same pages. The panel has a "Help" link to it. Usage numbers on the site come only from GitHub's public download counters (no telemetry).
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

### Changed

- The browser check on join is on by default and done once per browser: a signed cookie remembers it (30 days on a fixed address; once per live with the free quick tunnel, whose address changes every live). It is asked again only when an attack needs a stronger check. Configs from v0.1.0 that saved the old default (`false`) are switched on once; turning it off afterwards is kept. The join page shows a progress bar while it checks.
- The start scripts never ask questions in the terminal: below the minimum they warn and continue. `--ask` / `-Ask` restores the question; `--yes` / `-Yes` still works.

- The header button is now "Turn on SwarmCast" (it starts SwarmCast, not OBS).
- "Help the stream (P2P)" is on by default; a viewer who turns it off keeps it off. The explanation moved into its tooltip.

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

[Unreleased]: https://github.com/Lucas-Angelo/swarmcast/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Lucas-Angelo/swarmcast/releases/tag/v0.1.0
