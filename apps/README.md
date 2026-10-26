# apps

| Folder | What | Built with |
|--------|------|-----------|
| [server/](server/README.md) | The SwarmCast app: orchestration, public server, admin API, tracker, child processes | Node 24, Fastify, TypeScript |
| [viewer/](viewer/README.md) | Pages viewers open (`/join`, `/watch`): player, P2P, integrity checks | Vite, hls.js, p2p-media-loader |
| [admin/](admin/README.md) | Streamer's panel on 127.0.0.1:8081 | Vite, Preact |
| [tray/](tray/README.md) | Tray / menu bar icon helper `swarmcast-tray` (script mode) | Go, fyne.io/systray |
| [desktop/](desktop/README.md) | Desktop app: installers, app window, tray, auto-update around the server | Tauri 2, Rust |

Build all web apps and the server from the repo root with `npm run build`. The tray helper is built separately (`node apps/tray/build.mjs`), the desktop app with `node scripts/build/desktop.mjs` (see [desktop/](desktop/README.md)).
