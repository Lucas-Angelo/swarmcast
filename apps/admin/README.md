# @swarmcast/admin

The streamer's panel (Preact), in English and Brazilian Portuguese, on the Forest & Cream brand (`@swarmcast/shared/web/brand.css`, brand tokens only). It is served only on 127.0.0.1:8081 and opened through `/auth/<token>` by the desktop app, the tray icon or the start script; without that per-run token the server answers with a "not authorized" page that explains how to reopen it.

- Build: `npm run build -w @swarmcast/admin` → `dist/`, served from `web/admin` in release packages.
- `src/App.tsx` is the whole UI:
  - start/stop with visible steps, live link + Discord message, OBS server/key;
  - viewers (Kick, Remove from P2P), speed test and capacity, settings;
  - the Direct mode dialog.
- `src/QualityCard.tsx`, `src/Security.tsx`, `src/Activity.tsx`, `src/DiagnosticsCard.tsx` (Problem report: export logs, log retention) and `src/onboarding/` (first-run tutorial) are the other cards.
- `gate.html` + `src/gate.css`: a build-only entry. It makes the small stylesheet (and favicon link) of the pages the server writes before the panel is open, the sign-in hop and "not authorized" (`apps/server/src/admin/gate.ts`); the server reads the hashed names from `dist/gate.html`.
- Caching: `index.html` is sent with `Cache-Control: no-store`, the content-hashed `/assets/*` files with a one-year `immutable` cache.
- `src/DesktopCard.tsx` + `src/desktop.ts`: only in the desktop app (`GET /api/desktop` answers `{ desktop: false }` in script mode and they stay hidden): the "Desktop app" card (start with the computer, version, check for updates) and the update banner at the top.
- `src/api.ts` handles JSON requests and the live state WebSocket (`/ws`: state snapshots, activity log, and `desktop` messages in the desktop app). Types come from `@swarmcast/shared` (`AdminState`, `DesktopInfo`).
