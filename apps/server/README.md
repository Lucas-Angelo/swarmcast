# @swarmcast/server

The main app (`swarmcast` executable). It starts MediaMTX and cloudflared, serves the viewer pages and HLS on 127.0.0.1:8080, the admin panel on 127.0.0.1:8081, the tracker and the control channel. Design: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- Run from source: `npm run fetch-bins && npm run build && npm run dev` (from the repo root; `npm run dev -- --no-tunnel` for local only). Binaries are taken from `vendor/<os-arch>/` in dev mode, or from `SWARMCAST_BIN_DIR`.
- Tests: `npm test` (unit, `test/unit`), `npm run test:integration` (real MediaMTX + ffmpeg, `test/integration`), `npm run test:e2e` (Playwright, `test/e2e`, config in `playwright.config.ts`).
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
