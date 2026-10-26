# SwarmCast Desktop (installer + app window + auto-update)

Status: in development on branch `feat/desktop-app`. This document is the design and the
contract between the desktop shell (`apps/desktop`, Rust/Tauri) and the server (`apps/server`).

## Goals

- A real installer per OS (Windows `.exe` setup, macOS `.dmg`, Linux `.deb` + `.AppImage`) that a lay
  person double-clicks. No terminal, no questions besides the OS's own install screens.
- SwarmCast opens as an app window (not a browser tab) showing the existing admin panel, with a tray /
  menu bar icon.
- "Start with the computer" option, **off by default**.
- OBS-style updates: the app finds the latest **stable** release, and after one click on "Update" it
  downloads, verifies, installs and reopens by itself. Settings are never lost.
- The script mode (`scripts/start-*.{sh,command,ps1}`) keeps working unchanged for advanced users and
  servers. Both modes run the same server binary and share the same data folder.
- Viewers are not affected: they keep watching in their browser.

## Why Tauri (and not Electron)

The server already embeds its own Node 24 (pkg). Electron would add a second Node plus a full Chromium
(~150 MB more per OS) just to draw one window. Tauri v2 (stable since Oct 2024) uses the OS webview
(WebView2 on Windows 10/11, WKWebView on macOS, WebKitGTK on Linux), adds ~10 MB, and ships the pieces we
need as maintained, audited plugins: native installers (NSIS/DMG/DEB/AppImage), tray, single instance,
signed updater, dialogs. Pinned to 2.x minors/patches (3.x is alpha).

## Layout

```
apps/desktop/
  package.json            (workspace: tauri CLI pinned, scripts)
  splash/                 (local page shown while the server starts / on errors / during updates)
  src-tauri/
    Cargo.toml, tauri.conf.json, Info.plist, capabilities/, icons/
    src/main.rs, sidecar.rs, protocol.rs, tray.rs, updater.rs, i18n.rs, ...
    windows/hooks.nsh     (NSIS install/uninstall hooks)
scripts/build/desktop.mjs (stage sidecar + resources from release/staging/<target>, run `tauri build`)
```

## Names and locations

| | Value |
|---|---|
| Product name | `SwarmCast` |
| Identifier | `io.github.lucas-angelo.swarmcast` |
| App executable | Windows `SwarmCast.exe`, macOS `SwarmCast.app/Contents/MacOS/SwarmCast`, Linux `swarmcast-desktop` |
| Server sidecar | `swarmcast-server[.exe]` = the same pkg binary the scripts install as `swarmcast` |
| Resources | `bin/` (mediamtx, cloudflared; no Go tray helper), `web/viewer`, `web/admin`, licenses |
| Windows install dir | `%LOCALAPPDATA%\Programs\SwarmCast` (per user, no admin prompt) |
| Data dir (unchanged) | `%LOCALAPPDATA%\SwarmCast`, `~/Library/Application Support/SwarmCast`, `~/.local/share/swarmcast` |

The data dir holds config, secrets, logs, ffmpeg (`tools/`) and `system-check.json`. Installing,
updating and uninstalling the app never touches it, except the uninstaller's optional "delete app data"
checkbox. Script mode and desktop mode share it.

## Shell ↔ server protocol

The shell starts the sidecar as:

```
swarmcast-server --desktop
```

with environment:

| Variable | Meaning |
|---|---|
| `SWARMCAST_DESKTOP_EXE` | Absolute path to start the desktop app (AppImage: `$APPIMAGE`). Used for autostart entries. |
| `SWARMCAST_BIN_DIR` | Folder with mediamtx / cloudflared (already supported). |
| `SWARMCAST_WEB_DIR` | Folder containing `viewer/` and `admin/` (new). |
| `SWARMCAST_DESKTOP_VERSION` | Version of the shell. |
| `SWARMCAST_LOCALE` | OS locale (`pt-BR`, `en-US`…), for server-side texts. |
| `SWARMCAST_NO_FFMPEG_INSTALL` | `1` skips the automatic ffmpeg download of the first start (tests/CI only). |
| `SWARMCAST_TEST_LOGIN_FILE` | Tests/CI only: the server also writes the panel login URL (`ready.adminUrl`) to this file, owner-only, so `scripts/test/desktop/verify.mjs` can call the admin API of an app it did not start itself. |

`--desktop` implies `--no-open` and `--no-tray`, keeps the parent watch, and also exits cleanly when
stdin closes. Messages are JSON, one per line. As in script mode, the server turns the live on at
start (waiting for OBS, off again by itself after the auto-stop time) unless the shell also passes
`--no-autostart` (a good fit for `--background`).

Desktop mode refuses to run next to another SwarmCast (the start scripts do not): if a SwarmCast panel
answers on the configured panel port, or the RTMP port is busy, it sends `fatal` and exits 1 before
`ready`.

**Server → shell** (stdout lines starting with `@@swarmcast ` followed by JSON; every other stdout line is
an ordinary log line the shell copies to `logs/desktop.log`):

| Message | When |
|---|---|
| `{"type":"ready","adminUrl":"http://127.0.0.1:8081/auth/…","version":"0.2.0"}` | Admin panel is up. Sent once. |
| `{"type":"state","state":"off\|waiting\|live","tooltip":"…","canStart":b,"canStop":b,"phase":"off\|starting\|waiting-obs\|live\|stopping","viewers":n}` | On every change (same fields as the Go tray helper + `phase`, `viewers`). |
| `{"type":"fatal","code":"…","message":"…"}` | Startup failed, then exits 1. `code`: `already-running` (another SwarmCast answers on the panel port, e.g. started from a terminal), `ports-busy` (the RTMP port, or all 20 panel ports, used by another program), `startup-failed` (anything else, e.g. a broken `config.json`). `message` is English. |
| `{"type":"update-check"}` | Panel button "Check for updates". |
| `{"type":"update-install"}` | Panel button "Update now". |

**Shell → server** (stdin):

| Message | Effect |
|---|---|
| `{"type":"click","id":"start\|stop\|quit"}` | Same as the tray helper clicks. `quit` = stop everything and exit 0. |
| `{"type":"quit"}` | Stop everything and exit 0. |
| `{"type":"update","status":"none\|available\|downloading\|installing\|error","current":"…","version":"…","notes":"…","progress":0..1,"error":"…"}` | Update status, shown in the panel (banner, progress, errors). |

Stdin EOF also means quit. The shell waits up to 35 s for the sidecar to exit after `quit`, then kills it
(the server's reaper still cleans its children).

Notes:
- Protocol lines are always whole lines; log lines (pino JSON and a few human lines) never contain the
  prefix. The `ready` line carries the per-run panel token: do not copy protocol lines to
  `desktop.log` (the server's own human lines omit the token and the live link in desktop mode).
- `state` is also re-sent every 15 s when the viewer count changed (sessions can time out without a
  phase change).
- Unknown or invalid stdin lines are ignored (logged). `update` fields are validated; long texts are
  cut (notes 20 000 characters) and `progress` is clamped to 0..1. Lines over 256 KB are ignored.
- The panel's "Quit SwarmCast" button also makes the server stop everything and exit 0 by itself.

## Shell behaviour

- **Single instance**: opening the app again shows and focuses the existing window.
- **Startup**: window shows the local splash ("Starting SwarmCast…") → on `ready` it navigates to
  `adminUrl`. If the sidecar exits before `ready`, it is restarted up to 3 times (2 s, 5 s, 10 s); then the
  splash shows the error with "Try again" and "Open logs folder". A `fatal` message is never retried: the
  splash shows the localized text for its `code` (the server's English `message` for unknown codes) with
  "Try again". A server that stayed up for 60 s gets a fresh set of restarts when it crashes later; an
  exit with code 0 after `ready` (the panel's "Quit SwarmCast") closes the whole app.
- **Login**: the admin cookie is `SameSite=Strict`, and WebKit does not send it on the `/auth/<token>` →
  `/` redirect when the navigation started from the splash (another site), so the first panel load can be
  "not authorized" although the cookie is stored. For the first 3 panel loads after `ready` the shell
  checks for the panel's root element (`#app`) and, when it is missing, opens `adminUrl` again from the
  panel's own origin, which works. (`SameSite=Lax` on that cookie would make this unnecessary.)
- **`--background`** (used by autostart): start with the window hidden, tray only (macOS: no Dock icon
  while the window is hidden), and pass `--no-autostart` to the server so the live does not turn on at
  every login.
- **Window close**: phase `off` (or no server running) → quit. Otherwise (starting, waiting for OBS,
  live, stopping) a native dialog: "The live is on. Closing stops it for everyone." [Stop and quit]
  [Keep running in the tray]. Tray "Quit" and the app menu's Quit (Cmd+Q) ask the same. SIGTERM / SIGINT /
  SIGHUP (logout, `kill`) quit without asking. Quitting shows "Closing SwarmCast…" while the server stops.
  Without a tray icon (Linux desktop without an AppIndicator host) "keep running" minimizes instead.
- **Tray / menu bar**: icons off / waiting / live (from `apps/tray/icons`), localized tooltip from
  `phase` + `viewers`; menu: Open SwarmCast, Start live, Stop live (enabled from `canStart` /
  `canStop`), Check for updates, Quit. Windows / Linux: left click opens the window; macOS: the menu.
  Tray clicks are sent as `click` start / stop; Quit is handled by the shell (it sends `quit`).
- **Links**: anything that is not the splash or the admin origin opens in the default browser
  (navigation, `window.open`, and `target=_blank` links, which a small injected script turns into a
  navigation so WebKit's pop-up rules do not drop them). Only http(s) and mailto are opened; other schemes
  are blocked. `SWARMCAST_NO_OPEN=1` logs the URL instead (tests).
- **IPC**: only the local splash page has IPC (three commands: status, Try again, Open logs folder,
  ACL-checked through `capabilities/main.json`, which has no `remote` entry). The remote admin origin gets
  none; the panel talks to the server, and the server to the shell over stdio.
- **Language**: shell texts (splash, tray, dialogs, installer) in English and pt-BR from the OS locale.
  The webview must report the OS language in `navigator.language` (macOS: `CFBundleLocalizations` en,
  pt-BR in Info.plist; Windows WebView2: `--lang=<locale>`), so the panel's existing detection works.
- **Logs**: `<data>/logs/desktop.log`: the server's stdout/stderr lines except protocol lines, and the
  shell's own lines (`[desktop]`). Rotated at 2 MB, two old files kept (`desktop.log.1`, `.2`).
- **Process tree**: Windows: the server runs in a Job object with KILL_ON_JOB_CLOSE and without a
  console window, so killing the shell kills the server and everything it started. macOS / Linux: the
  server's parent watch and stdin EOF; after the 35 s grace the shell SIGKILLs the server only, and the
  server's reaper kills its children.

## Autostart ("Start with the computer", default off)

Implemented in the server (`apps/server/src/desktop/autostart.ts`), so the panel toggle and the state
live with the rest of the settings. Only offered when `SWARMCAST_DESKTOP_EXE` is set. The OS entry is the
source of truth (read back on every request):

| OS | Entry |
|---|---|
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `SwarmCast` = `"<exe>" --background` |
| macOS | `~/Library/LaunchAgents/io.github.lucas-angelo.swarmcast.plist` (`RunAtLoad`, args `<exe> --background`) |
| Linux | `~/.config/autostart/swarmcast.desktop` (`Exec="<exe>" --background`) |

Panel API (admin auth like the other routes):

- `GET /api/desktop` → `{ desktop: true, version, serverVersion, autostart: { supported, enabled, stale?, error? },
  update, updateChecking, systemCheck }`, or `{ desktop: false }` in script mode (the panel then hides
  everything desktop-related). `version` is `SWARMCAST_DESKTOP_VERSION` (else the server's), `update` the
  last `update` message from the shell (or null), `updateChecking` is true from "Check for updates" until
  the shell answers (at most 60 s), `systemCheck` is `idle | running | done | failed` (first start).
- `PUT /api/desktop/autostart {enabled}` → same object; writes or removes the entry and reads it back.
- `POST /api/desktop/update/check` / `POST /api/desktop/update/install` → same object; send
  `update-check` / `update-install` to the shell. The panel asks for confirmation first when the live is on.
- The same object is pushed on the panel WebSocket as `{ "type": "desktop", … }` whenever it changes.

Uninstallers remove the entry. Turning it off on macOS only deletes the plist (no `launchctl bootout`:
when the app was started by that agent, bootout would kill it).

## Updates

- Tauri updater plugin, Ed25519 (minisign) signatures. Public key in `tauri.conf.json`; the private key
  is a GitHub Actions secret (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), never
  committed. A download whose signature does not match is refused.
- Endpoint: `https://github.com/Lucas-Angelo/swarmcast/releases/latest/download/latest.json`
  (`/latest` never returns pre-releases, so only stable versions are offered). Tests override it with
  `SWARMCAST_UPDATE_URL`. It is the main repository's latest release: until a release ships
  `latest.json` (v0.1.0 has no desktop artifacts) it answers 404 and the app just says it is up to date.
- When: 10 s after start, then every 6 h, plus tray / panel "Check for updates". Automatic checks are
  silent when there is nothing new or the check fails (offline); a manual check says "You have the latest
  version" or shows the error. 404 (no release with `latest.json` yet) and a manifest without this
  platform count as "no update".
- Found an update: native dialog "SwarmCast X is available (you have Y)" with the release notes,
  [Update now] [Later]; the panel shows the same as a banner. If the live is on, the dialog says updating
  stops it and "Later" is the default. Automatic checks show the dialog once per version (the banner
  stays); manual checks always show it. The panel's "Update now" (`update-install`) installs directly.
- `requireSignedVersion` is on: the version inside the signature (written by the Tauri CLI at build
  time) must match the manifest, so an old signed package cannot be served as a newer version.
- `http://` update URLs are refused unless the app was built with the `insecure-updates` Cargo feature
  (`desktop.mjs --insecure-updates`, local update tests only).
- Update now: send `update` `downloading` to the panel, stop the sidecar cleanly (so `installing` never
  reaches the panel) → splash "Downloading the update… 42%" → verify signature → install → reopen by
  itself. Windows: NSIS in passive mode, which relaunches the app (with a fresh environment). macOS:
  replace the .app; Linux AppImage: replace the file; `.deb`: tauri-plugin-updater (≥ 2.10, we use 2.14)
  runs `dpkg -i` through pkexec, a zenity/kdialog password prompt or sudo, so `.deb` installs update in
  place too (the manifest needs `linux-<arch>-deb` entries, written by `updater-manifest.mjs`). On macOS /
  Linux the shell relaunches itself with a tiny `sh` that waits for the old pid to exit (frees the
  single-instance lock) and keeps the environment. `<data>/run/desktop-updated` makes the relaunched app
  show its window even if it had been started with `--background`. Download retried 3 times (2 s, 5 s,
  10 s), not for signature errors; on failure the current version keeps working (sidecar restarted, the
  panel gets `update` `error` after `ready`) and a dialog says "try again later".
- Settings survive by design (separate data dir). Tests compare config/secrets before and after, and the
  first-run tutorial must not show again.
- Release workflow produces the updater artifacts (`*.sig`) and `latest.json`.

## First run in desktop mode

The installers of script mode run a system check and install ffmpeg before starting the app. In desktop
mode the server does it on first start (no `system-check.json`, or a different app version):

- **System check** in TypeScript (`apps/server/src/desktop/system-check.ts`), same ids, thresholds and
  `system-check.json` schema as the scripts, so the onboarding tutorial shows it unchanged. The file gets
  two optional fields the scripts do not write: `appVersion` (decides "another version") and
  `source: "desktop"`. The ports SwarmCast itself is using count as free; `github` is checked once
  (`unreachable (not needed)` is a warning, as with a local bundle); `release` is
  `v<version> (desktop app)`. The speed test reuses the server's startup speed test (skipped when speed
  tests are off in `config.json`). The tutorial shows "Checking your computer…" meanwhile and reloads
  when it is done.
- **ffmpeg**: automatic `installFfmpeg()` (existing, pinned + SHA-256), first try plus 3 retries after
  2 s, 5 s and 10 s (phase `retrying` in between); progress in the panel (quality card and tutorial);
  failures are not fatal (original quality only) and the panel offers "Try again".

## Installers

- **Windows (NSIS)**: per-user, English / Português (Brasil) by OS language, WebView2 bootstrapper
  embedded, Start menu + desktop shortcuts, "Run SwarmCast" on the last page. Tauri's own template with
  hooks only (`apps/desktop/src-tauri/windows/hooks.nsh`): the template's per-user default folder is
  `%LOCALAPPDATA%\SwarmCast` (our data dir), so a `MUI_CUSTOMFUNCTION_GUIINIT` function moves the
  default to `%LOCALAPPDATA%\Programs\SwarmCast` before the first page, and the pre-install hook does the
  same for silent installs. Hooks: before install, the template's "SwarmCast is running" prompt, then stop
  anything still running from the install dir (the server, mediamtx, cloudflared; ffmpeg dies with the
  shell's Job object); before uninstall (not on updates), run `swarmcast-server --cleanup` (router port)
  and remove the HKCU Run value `SwarmCast`; after uninstall, remove the data dir only if "delete app
  data" was ticked (never on updates).
- **macOS (DMG)**: drag to Applications. Ad-hoc signed (`signingIdentity: "-"`): the bundler signs the
  app and the sidecar; `desktop.mjs` ad-hoc signs MediaMTX / cloudflared in Resources when they carry no
  valid signature (cloudflared ships its own). No hardened runtime (nothing to notarize without a paid
  account, and Node's JIT would need extra entitlements). Minimum macOS 13.5 (Node 24's minimum). No paid
  Apple certificate, so the first open needs System Settings → Privacy & Security → "Open Anyway"
  (documented in the guide with screenshots).
- **Linux**: `.deb` (depends on `libwebkit2gtk-4.1-0`, `libayatana-appindicator3-1`) and `.AppImage`,
  x64 and arm64. The app binary is `swarmcast-desktop` and the sidecar `/usr/bin/swarmcast-server`
  (Tauri puts `externalBin` next to the app); resources in `/usr/lib/SwarmCast/`. Removing the `.deb`
  does not touch `~/.config/autostart/swarmcast.desktop` (a root package script should not edit home
  folders); the server should write `TryExec=` in that file so a removed app is simply skipped.
- No paid code signing: Windows shows SmartScreen "More info → Run anyway" once (documented).

## Testing

| Where | What |
|---|---|
| Unit (vitest, cargo test) | protocol encode/decode, autostart entry generation per OS, system check thresholds, i18n completeness, update state |
| Integration (vitest) | real server with `--desktop` driven by a fake shell over stdio: ready, state, start/stop, quit, stdin EOF, fatal on busy ports |
| macOS (local + CI arm64/x64) | build `.app`/`.dmg`, install, launch, panel, tray, close dialog, autostart on/off, update vA→vB from a local endpoint with config kept, uninstall |
| Linux (Docker, CI x64) | Ubuntu 22.04/24.04, Debian 12: install `.deb`/run AppImage under Xvfb, panel through the admin API, autostart file, AppImage update, uninstall |
| Windows (CI) | NSIS silent install, launch, panel through the admin API, Job object (killing the app ends the server), autostart key, update vA→vB with config kept, uninstall, nothing left running |

CI: `.github/workflows/desktop.yml` runs `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test`
on each OS, builds the installers for every target (windows-x64, macos-arm64, macos-x64 on the Intel
image, linux-x64 and linux-arm64 on Ubuntu 22.04 for an older glibc) and runs
`scripts/test/desktop/verify.mjs` on each OS: install (NSIS `/S`, `.dmg` → `~/Applications`, `.deb` and the
AppImage), launch, panel login (admin API), autostart on/off, kill (the server and tools go too), quit,
the NSIS uninstaller / `apt remove` and `scripts/uninstall-*`, and an update from test build A
(0.0.0-test.1) to B (0.0.0-test.2) served on 127.0.0.1, with config and secrets kept. A and B are built
with `--insecure-updates --updater-pubkey` and a key pair generated in the job. Only `release.yml` passes
the real `TAURI_SIGNING_PRIVATE_KEY` and publishes the tested installers, their `.sig` files and
`latest.json`; other builds of the real installers have no updater artifacts.
