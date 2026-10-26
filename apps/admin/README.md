# @swarmcast/admin

The streamer's panel (Preact). It is served only on 127.0.0.1:8081 and opened through `/auth/<token>` by the app or tray icon.

- Build: `npm run build -w @swarmcast/admin` → `dist/`, served from `web/admin` in release packages.
- `src/App.tsx` is the whole UI:
  - start/stop with visible steps, live link + Discord message, OBS server/key;
  - viewers (Kick, Remove from P2P), speed test and capacity, settings;
  - the Direct mode dialog.
- `src/QualityCard.tsx`, `src/Security.tsx`, `src/Activity.tsx` and `src/onboarding/` (first-run tutorial) are the other cards.
- `src/DesktopCard.tsx` + `src/desktop.ts`: only in the desktop app (`GET /api/desktop` answers `{ desktop: false }` in script mode and they stay hidden): the "Desktop app" card (start with the computer, version, check for updates) and the update banner at the top.
- `src/api.ts` handles JSON requests and the live state WebSocket (`/ws`: state snapshots, activity log, and `desktop` messages in the desktop app). Types come from `@swarmcast/shared` (`AdminState`, `DesktopInfo`).
