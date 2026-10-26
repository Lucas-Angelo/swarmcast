# apps

| Folder | What | Built with |
|--------|------|-----------|
| [server/](server/README.md) | The SwarmCast app: orchestration, public server, admin API, tracker, child processes | Node 24, Fastify, TypeScript |
| [viewer/](viewer/README.md) | Pages viewers open (`/join`, `/watch`): player, P2P, integrity checks | Vite, hls.js, p2p-media-loader |
| [admin/](admin/README.md) | Streamer's panel on 127.0.0.1:8081 | Vite, Preact |
| [tray/](tray/README.md) | Tray / menu bar icon helper `swarmcast-tray` | Go, fyne.io/systray |

Build all web apps and the server from the repo root with `npm run build`. The tray helper is built separately (`node apps/tray/build.mjs`).
