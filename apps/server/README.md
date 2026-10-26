# @swarmcast/server

The main app (`swarmcast` executable). It starts MediaMTX and cloudflared, serves the viewer pages and HLS on 127.0.0.1:8080, the admin panel on 127.0.0.1:8081, the tracker and the control channel. Design: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- Run from source: `npm run fetch-bins && npm run build && npm run dev` (from the repo root; `npm run dev -- --no-tunnel` for local only). Binaries are taken from `vendor/<os-arch>/` in dev mode, or from `SWARMCAST_BIN_DIR`; the web pages from `apps/{viewer,admin}/dist`, `web/` next to the executable, or `SWARMCAST_WEB_DIR` (a folder with `viewer/` and `admin/`).
- Two ways to run it, same binary and data folder:
  - **Script mode** (`scripts/start-*`): opens the panel in the browser and shows the Go tray helper.
  - **Desktop mode** (`--desktop`, started by the desktop app in `apps/desktop`): no browser, no tray helper; it talks to the app over stdio (one JSON message per line: `@@swarmcast {…}` lines on stdout for `ready` / `state` / `fatal` / `update-check` / `update-install`, commands on stdin) and quits when stdin closes. It refuses to start next to another SwarmCast (`fatal` with code `already-running` or `ports-busy`). On its first start (and after an app update) it runs the start scripts' system check in TypeScript and installs ffmpeg with retries (`SWARMCAST_NO_FFMPEG_INSTALL=1` skips that). The panel shows a "Desktop app" card (start with the computer, updates). Contract: [docs/DESKTOP.md](../../docs/DESKTOP.md). Try it by hand: `node --import tsx apps/server/src/main.ts --desktop --no-tunnel`, then type `{"type":"quit"}`.
- Tests: `npm test` (unit, `test/unit`), `npm run test:integration` (real MediaMTX + ffmpeg, `test/integration`; `desktop.test.ts` drives `--desktop` as a fake desktop app), `npm run test:e2e` (Playwright, `test/e2e`, config in `playwright.config.ts`).
- Key files in `src/`:
  - `main.ts`: CLI flags, signals, smoke test.
  - `app.ts`: wiring.
  - `core/live.ts`: start/stop steps, link rotation, admin state.
  - `public/server.ts`: join flow, `/hls/*`, WebSocket upgrades.
  - `access/access.ts`: links, tickets, sessions, kicks.
  - `hls/`: origin cache, playlists, signed manifest, upload limiter.
  - `tracker/tracker.ts` and `control/control.ts`.
  - `media/mediamtx.ts`: generated MediaMTX config.
  - `tunnel/`: quick, none and external providers.
  - `process/children.ts`: child processes and the reaper.
  - `direct/`: UPnP-IGD, NAT-PMP, ACME IP certificates.
  - `admin/server.ts` and `tray/tray.ts`.
  - `desktop/`: desktop mode: `protocol.ts` (stdio messages, pure), `desktop.ts` (stdio loop), `bridge.ts` (state for the panel), `autostart.ts` ("Start with the computer": Windows Run key via `reg.exe`, macOS LaunchAgent, XDG autostart), `system-check.ts` and `first-run.ts` (first start), `preflight.ts` (already running?). Panel API in `admin/desktop-routes.ts`.
