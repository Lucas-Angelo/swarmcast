# @swarmcast/viewer

Static pages served by the public server: `join.html` (nickname form), `watch.html` (player) and `invalid.html` (expired or invalid link). They contain no inline scripts, so the strict CSP holds.

- Build: `npm run build -w @swarmcast/viewer` → `dist/`, served from `web/viewer` in release packages.
- Tested through the server's Playwright suite (`npm run test:e2e`). `npm run dev -w @swarmcast/viewer` alone has no backend, so run the server for real testing.
- Key files in `src/`:
  - `watch.ts`: hls.js + p2p-media-loader setup, about 14 s behind live, P2P off until the viewer opts in, control channel.
  - `integrity.ts`: verifies the Ed25519-signed manifest and checks every P2P segment's SHA-256.
  - `peer-guard.ts`: closes connections to blocked peers by matching ICE ufrags from tracker signaling.
  - `join.ts`: the nickname form.
