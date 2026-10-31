# @swarmcast/server

The main app (`swarmcast` executable). It starts MediaMTX and cloudflared, serves the viewer pages and HLS on 127.0.0.1:8080, the admin panel on 127.0.0.1:8081, the tracker and the control channel. Design: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- Run from source: `npm run fetch-bins && npm run build && npm run dev` (from the repo root; `npm run dev -w @swarmcast/server -- --no-tunnel` for local only: from the root, arguments reach the server only through `-w @swarmcast/server`). A source run keeps its data in `<repo>/.cache/dev-data` (ignored by git), never in the real data folder of the computer; `--data-dir DIR` or `SWARMCAST_DATA_DIR` picks another one (`runDataDir` in `core/paths.ts`). Binaries are taken from `vendor/<os-arch>/` in dev mode, or from `SWARMCAST_BIN_DIR`; the web pages from `apps/{viewer,admin}/dist`, `web/` next to the executable, or `SWARMCAST_WEB_DIR` (a folder with `viewer/` and `admin/`).
- Two ways to run it, same binary and data folder:
  - **Script mode** (`scripts/start-*`): opens the panel in the browser and shows the Go tray helper.
  - **Desktop mode** (`--desktop`, started by the desktop app in `apps/desktop`): no browser, no tray helper; it talks to the app over stdio (one JSON message per line: `@@swarmcast {…}` lines on stdout for `ready` / `state` / `fatal` / `update-check` / `update-install` / `export-logs`, commands on stdin) and quits when stdin closes. It refuses to start next to another SwarmCast (`fatal` with code `already-running` or `ports-busy`). On its first start (and after an app update) it runs the start scripts' system check in TypeScript and installs ffmpeg with retries (`SWARMCAST_NO_FFMPEG_INSTALL=1` skips that). The panel shows a "Desktop app" card (start with the computer, updates). Contract: [docs/DESKTOP.md](../../docs/DESKTOP.md). Try it by hand: `node --import tsx apps/server/src/main.ts --desktop --no-tunnel`, then type `{"type":"quit"}`.
- Logs and diagnostics (`<data>/logs/`):
  - `swarmcast-YYYY-MM-DD.log`: the server's pino JSON lines, MediaMTX / cloudflared / ffmpeg output included (they are logged through pino, not to their own files). A new file every local day; cut at 5 MB while running into `.1` … `.5` (the newest part is `.1`), by renaming and `reopen()`ing the sync destination inside `write()`, so no line is lost or interleaved (`core/log-files.ts`). Older versions wrote `swarmcast.log`; it is kept until the retention removes it.
  - `desktop.log*`: written by the desktop app (2 MB, two old files).
  - Retention (`diagnostics/diagnostics.ts`): at start and once a day, log files and old exports in `<data>/exports` older than `diagnostics.logRetentionDays` in config.json (3 to 90, default 14; panel: Problem report → Advanced) are deleted, then the oldest until the folders are under 100 MB. Files being written are never deleted.
  - **Export logs** (panel "Problem report" card, `POST /api/diagnostics/export`, rate-limited, admin auth + CSRF rules; desktop tray `export-logs`): the server writes `SwarmCast-logs-<version>-<YYYYMMDD-HHmm>.zip` (fflate, plain deflate) to the user's Downloads folder (Windows Known Folder from the registry, then `%USERPROFILE%\Downloads`; `~/Downloads`; XDG `XDG_DOWNLOAD_DIR`), else `<data>/exports`, and answers with the path; `POST /api/diagnostics/reveal` opens it with `explorer /select,`, `open -R` or `xdg-open <dir>`. `SWARMCAST_DOWNLOADS_DIR` overrides the folder (tests). Contents: `logs/` (last 14 days: server, desktop, children), `about.txt` (versions, OS, CPU/RAM, mode, binaries, ffmpeg, uptime, live phase, quality settings), sanitised `config.json`, `system-check.json`, `activity.txt`. Never `secrets.json`, `state.json`, signing keys, the live link, the stream key or tokens.
  - Anonymisation (`diagnostics/anonymize.ts`): every line goes through `scrub()` again plus exact matches of the app's secrets (stream key, live link and its token, panel token, session/peer ids), PEM blocks, quick-tunnel host names and the home folder (`~`). IPv4/IPv6 addresses (except loopback) and nicknames become `ip-<8 hex>` / `viewer-<8 hex>`: an HMAC-SHA256 with a random salt made for each export, so a value keeps one label inside one export only. "Include full IP addresses" (off by default) keeps the IPs.
- Tests: `npm test` (unit, `test/unit`), `npm run test:integration` (real MediaMTX + ffmpeg, `test/integration`; `desktop.test.ts` drives `--desktop` as a fake desktop app), `npm run test:e2e` (Playwright, `test/e2e`, config in `playwright.config.ts`).
- Key files in `src/`:
  - `main.ts`: CLI flags, signals, smoke test.
  - `app.ts`: wiring; `core/config-store.ts` is the one writer of `config.json` (never the run's fallback ports or `--no-tunnel`).
  - `core/live.ts`: start/stop steps, link rotation, admin state.
  - `public/server.ts`: join flow, `/hls/*`, WebSocket upgrades.
  - `access/access.ts`: links, tickets, sessions, kicks.
  - `hls/`: origin cache, playlists, signed manifest, upload limiter.
  - `tracker/tracker.ts` and `control/control.ts`.
  - `media/mediamtx.ts`: generated MediaMTX config.
  - `tunnel/`: quick, none and external providers.
  - `process/children.ts`: child processes and the reaper.
  - `direct/`: UPnP-IGD, NAT-PMP, ACME IP certificates.
  - `chat/`: the chat hub, batcher, buckets, flood detector and event-loop guard ([docs/CHAT.md](../../docs/CHAT.md)); panel API in `admin/chat-routes.ts`.
  - `branding/`: "Your page": store, image validator, viewer and panel routes, link-preview page ([docs/BRANDING.md](../../docs/BRANDING.md)).
  - `security/`: attack detector, shield and reactions, proof-of-work, `sc_verified`, public blocklists ([docs/SECURITY_RESEARCH.md](../../docs/SECURITY_RESEARCH.md)); `access/own-connection.ts` keeps P2P off for viewers on the streamer's own connection.
  - `quality/`: ffmpeg ladder, encoder probe, load guard, upload controller ([docs/QUALITY.md](../../docs/QUALITY.md)); `speedtest/`: the speed test.
  - `diagnostics/`: log retention, "Export logs" and the anonymiser (above).
  - `core/`: also `config.ts` (`config.json` schema and migrations), `paths.ts` (data, binaries and web folders), `secrets.ts`, `logger.ts`, `messages.ts` (coded texts that clients translate) and `exec.ts` (runs the OS's command-line tools: netsh, reg, tar…).
  - `admin/server.ts` and `tray/tray.ts`.
  - `desktop/`: desktop mode: `protocol.ts` (stdio messages, pure), `desktop.ts` (stdio loop), `bridge.ts` (state for the panel), `autostart.ts` ("Start with the computer": Windows Run key via `reg.exe`, macOS LaunchAgent, XDG autostart), `system-check.ts` and `first-run.ts` (first start), `preflight.ts` (already running?). Panel API in `admin/desktop-routes.ts`.
