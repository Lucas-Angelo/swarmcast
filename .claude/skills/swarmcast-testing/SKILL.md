---
name: swarmcast-testing
description: How to write, fix, run and prove tests in SwarmCast (Vitest unit and integration, Playwright e2e, Rust, system harnesses, soak, coverage, CI). Use before adding or changing any test, when a test is flaky, when CI is red, or when asked whether something is stable.
---

# Testing SwarmCast

SwarmCast must work for lay users on macOS (arm64, x64), Windows and Linux (x64, arm64). A test that
passes sometimes is a failing test. Main is protected: nothing lands unless every check is green.

## The rules (non-negotiable)

1. **Arrange / Act / Assert.** Inside a test body the only comments are `// Arrange`, `// Act`,
   `// Assert` (use the ones that apply; long e2e flows repeat `// Act` / `// Assert`). Explanations
   live in the file header, in well-named helpers and constants, and in helper JSDoc.
2. **No fixed waits.** Never `waitForTimeout`, `sleep`, `setTimeout` to "let it settle". Wait for the real
   thing: a web-first assertion, `expect.poll` on the real condition, the response / WebSocket frame /
   process exit / port / log line, or control time (`vi.useFakeTimers()`, injected clocks,
   Playwright `page.clock`). Only a window the test MEASURES (e.g. "play 20 s, count stalls") uses real
   time, as a named constant.
3. **No gambiarras.** Never: raise a timeout to hide slowness, `retries`/`toPass` around a flaky step,
   `skip`/`fixme` a flake, weaken or delete an assertion, `force: true` or `dispatchEvent` instead of a real
   user action, swallow errors. Find the cause. If a check truly cannot hold somewhere, prove it with data
   and scope it explicitly (see chat-flood on macOS).
4. **An illogical test points at the code.** If a test needs contortions (internals, mocking the world,
   sleeps), refactor the product: inject the clock/IO, split the function, remove the hidden dependency.
   Test behaviour, not implementation (Khorikov).
5. **Reuse.** One fixture/helper/builder per concept (Playwright `test.extend`, the unit `helpers.ts`,
   e2e `fixtures.ts`). Search before writing a new helper.
6. **Independent and parallel-safe.** Unique temp dirs (`fs.mkdtemp`), port 0, no order dependence. The
   e2e server is shared by the whole run: every test restores what it changes. A port needed before its
   server starts comes from `allocPorts()` (20000-31999) or `FIXED_PORTS` (10000-19999), never from an
   OS ephemeral range (Linux 32768-60999, macOS/Windows 49152-65535; `scripts/test/lib/ports.mjs`).
7. **Cross-OS by design.** `path.join`, no CRLF assumptions, case-insensitive file systems, Windows file
   locks (close handles before deleting), no POSIX signals on Windows (taskkill trees), bind 127.0.0.1,
   pin TZ/locale, compare timing against a baseline from the same run (CI VMs, macOS above all, are
   slow and noisy), engines and fonts differ per OS.

## Where tests live and how to run them

| Kind | Tool | Where | Command |
|---|---|---|---|
| Unit (server, viewer, admin, shared, scripts) | Vitest | `apps/*/test`, `packages/shared/test`, `scripts/**/test` | `npm test` |
| Integration (real server, ffmpeg, MediaMTX) | Vitest | `apps/server/test/integration` | `npm run fetch-bins && npm run build && npm run test:integration` |
| Server e2e | Playwright (chromium=Chrome on CI, firefox, webkit) | `apps/server/test/e2e` | `npm run test:e2e` (`--grep @ui` / `@media`) |
| Viewer chat UI + corpus rendering | Playwright, mock hub | `apps/viewer/test/chat` | `npx playwright test -c apps/viewer/test/chat/playwright.config.ts` |
| Website | Vitest + Playwright | `site/test` | see `site/package.json` |
| Desktop shell | `cargo test` | `apps/desktop/src-tauri/src` `#[cfg(test)]` | `cd apps/desktop/src-tauri && cargo test` |
| System (Windows app/Direct/quality/OBS, Docker x64/arm64, clean machine, apt, DMG) | harnesses | `scripts/test/**` | CI only (`pipeline.yml`), see docs/TESTING.md |
| Chat load | bench | `scripts/test/chat` | `node --import tsx scripts/test/chat/bench.ts --scenario all` |
| Coverage | Vitest v8 + c8 + cargo-llvm-cov | floors in `scripts/coverage/floors.json` | `npm run coverage` (`coverage:unit`, `:integration`, `:e2e`, `:desktop`) |
| Real phones (Safari iOS Simulator, Chrome Android Emulator) | WebDriver / Playwright android | `apps/server/test/devices`, `.github/workflows/devices.yml` | see docs/TESTING.md |

Safety when running locally: `SWARMCAST_NO_OPEN=1`, temp data dirs, `SWARMCAST_E2E_PORT_OFFSET=<n>`;
never touch `~/Library/Application Support/SwarmCast`, OBS, `/Applications` or ports 31935/38180/38181.

## The bar: 0 % failures in 100 % of runs, no retries

Every run of every test on every OS passes. A single failure anywhere (CI, soak, local) is a bug to fix at
the root, never "a flake". Retries are off everywhere (`retries: 0` in every Playwright config, no
`--retries`, no re-running a job to get green, no `toPass` loops).

## Proving stability (not "it passed once")

- One green run proves nothing. Use the soak: `.github/workflows/soak.yml` with a plan
  (`.github/soak-plan.json` or inline JSON via workflow_dispatch). Each entry: `suite`, `os`, `jobs`,
  `repeat`, `args`, `label`. E2E repeats use `--repeat-each` with `--fail-on-flaky-tests`.
- The requirement is zero failures in every run. Repetition is how we gather evidence: the more clean
  runs, the stronger it is (N clean runs bound an unseen failure rate at ~3/N), but no number of runs
  makes a single failure acceptable.
- Before merging a risky change: targeted soak of the touched suites on every OS, then full pipelines
  repeatedly on a marker commit (an empty commit on a `soak/*` branch so results never attach to main's
  or the PR's SHA).
- Never dispatch soak/pipeline runs on main's SHA: their failures show as red on main.
- Soak concurrency keeps one pending run per ref: a second dispatch cancels the pending one. Combine
  plans into one dispatch.

## Flake families already found (and the right fix)

| Symptom | Cause | Fix |
|---|---|---|
| Click "did not change the checkbox" / click did nothing | layout shift between actionability check and click (a row added above, a canvas resized after paint) | wait for the state that causes the shift (`panelShows`), or fix the product so it does not shift (size in markup, `useLayoutEffect`) |
| Canvas read before drawn | drawing in `useEffect` (after paint) | draw in `useLayoutEffect` |
| Value read right after "ready" is missing | the next message arrives as its own stdout line / WS frame | `expect.poll` on it |
| First test of a fresh browser times out | engine cold start (system font fallback, the new binary read from disk; not Defender, whose real-time protection is off on the runners) | `globalSetup` warms every engine; per-process font warm-up before the page under test |
| Frame timing too slow on macOS Chrome | software raster on GPU-less VM | measure main-thread frame work (message from a rAF callback), not two rAFs |
| Player stalls ~3 s on macOS Chrome even without load | runner noise | same-run baseline comparisons; stall comparison not on darwin, data in the spec |
| Bench "every message reaches everyone" failed | scenario ran at the budget edge | give the scenario the headroom its claim assumes |
| Artifact download failed after 5 retries | GitHub artifact service | `.github/actions/fetch-artifact` (3 tries, 30 s/90 s) |
| Watch never enabled on a join page that looks ready | one of its scripts failed to load (net::ERR_NO_BUFFER_SPACE on a Windows runner): the browser never runs it nor asks again | the page reloads itself (startup guard, the one hash-allowed inline script); harnesses type the nickname only once Watch is enabled |
| Join never posted / click did nothing | a status line above the button hid itself mid-click and moved the button (press on the button, release elsewhere, click on the ancestor) | never move a control after it appears (status below the button, page shown only when ready); Playwright checks the hit target only on press |
| Watch page froze 2-7 s in layout (chat not visible within 5 s), on the first run of a fresh Windows runner only, in two workers' browsers at once | the machine's first load of system fonts (the corpus's CJK/Indic fallbacks) holds up every process's font lookups; Chrome's renderer lays text out with a blocking call to the browser's font service (trace: one Arial match 1.8 s) | globalSetup renders what the specs render (the watch page with the whole corpus) before any test |
| Two workers' first Firefox on Windows: 15.8 s to launch, the warm-up's first `goto` never loaded in 30 s, 14 s to close, about 9 min into the job; the next two Firefox fine (soak 41543430258) | a few minutes after a job starts, Windows updates Defender's signatures (MpSigStub, AM_Delta, MsMpEng at 100-560 MB/s, real-time protection off or not): for 30-90 s a write to C:, the runner's capped network disk, takes 0.3-0.9 s. Firefox's main thread commits its new profile's SQLite databases (Gecko profile: 2.8 s in `INSERT INTO moz_bookmarks`), and the profile was in %TEMP% on C: | every browser profile on the runner's local disk D: (`browserTempOnWorkDisk`, scripts/test/lib/browser-temp.mjs, called by both Playwright configs and the Windows harness; the app under test keeps the machine's own TEMP through bareEnv). Shown by cold Firefox in a loop through that window, with per-drive disk counters and the busiest processes sampled: 15 slow launches of 3306, all inside the window (soak 41564352271) |
| Firefox page froze 0.3-2.4 s while loading, on Windows, in any test (no failure yet; tests 3.5-4.5 s instead of ~1 s) | every test is a new browser context, so the page's first `localStorage` call is the origin's first visit: Firefox blocks it until its quota-manager thread has written and flushed the origin's new storage, behind the deletions of the contexts that just closed (profile: `Storage.setItem` waiting, that thread in `FlushFileBuffers`) | the page helpers open an empty page of the origin and touch `localStorage` first (`firstVisit`, watch-page.ts) |
| First Firefox test of a worker: chat rendered but "not visible" after 5 s; requests of the page answered 6 s late (Windows) | a new browser's first page loads make Firefox's parent main thread create the profile's history/bookmarks database (flushed SQLite writes) and its font data (DirectWrite), 0.5-3.5 s within 7 s of launch, while Playwright and the page's network wait on that thread | a worker-scoped auto fixture renders the watch page with the corpus in each worker's browser before its first test (`browserWarm`, fixtures.ts) |
| Firefox: a click on Watch right after typing did nothing (the page got the release, never the press; no focus change) | the contexts of one Firefox share its profile's form history, which saves the fields of every submit, even one the page cancels; earlier tests' nicknames made Firefox open its autocomplete list over Watch, browser UI Playwright cannot see, and it took the press | form history off for every harness Firefox (`firefoxPrefs`, scripts/test/lib/firefox.mjs) |
| iOS: a tap on the join page's nickname got touchstart and touchend, no click; finger down 285 ms, not a long press (Devices run 41566408164) | "Checking your browser…" (with its "i" button) appeared once the challenge arrived, between touchstart and the synthetic mouse move: WebKit's content-change observer takes such a tap for a hover (WebPage::handleSyntheticClick, ContentChange::Visibility) | the server sends the join page with the line already shown to a browser it will check (`Pages.joinChecking`); a page never reveals clickable content by itself while it takes taps |
| Chat message not shown in a visible page | rAF can stop for a page that still reports visible (occluded/background windows) | timer fallback when no frame comes (`render.ts`, `stats.late`) |
| Slow mode refused a send at the end of the countdown | client counted from send, server from receipt | count from the ack, follow the current slowS, hold Send while a message is in flight |
| Firefox goto never reports DOMContentLoaded | automation layer (Juggler) loses the event on a COOP process switch | wait for `commit` + the real ready signal (Watch enabled), never DOMContentLoaded |
| Loop-delay check fails only on macOS CI | the OS de-schedules the process (3 shared vCPUs); raw loop delay counts preemption | measure the server's own blocking (thread CPU + loop active time) |
| Bench bot closed by the server | jitter pushed a bot over the server's 20 frames / 10 s ceiling | load generators keep a margin under every server limit |
| A viewer barely played after a forced stall (macOS, once in 43 media jobs) | the quality ladder's load guard dropped 480p mid-test ("behind", the runner's CPU shared with the test's browsers); the ladder's playlists vanished and the server answered 503 "not started", which players retry for minutes | product: 404 for a playlist the stream no longer lists, so the player reloads; e2e: the guard drops a rendition only when a spec asks (`server.ts` SpecLoadGuard, `POST /shed`) |
| After the ladder fell back to the original, the viewer froze 9 s (quality.spec, macOS and Linux) | the origin kept MediaMTX's playlists from before the ladder: they began with the gate's 2 s OBS connections, one of them in the audio playlist only; the player started on the oldest video segment and never found its audio until the stall watchdog moved it | a playlist the served stream did not list starts its window over when it comes back (`HlsOrigin.setSource`, `origin-runs.test.ts`); read the served playlists from the trace's resources before guessing |
| Audio-only viewer froze up to 4.7 s when the ladder fell back to the original (audio-only.spec, WebKit, local) | the ladder's `audio.m3u8` went away (404) and the player reloaded only after three 404s, about 3 s with 1 s audio segments; joined on a young ladder stream it held only about 2 s of audio | the server answers 404 only for a playlist the stream no longer lists, so audio-only playback reloads on the first (`AUDIO_ONLY_GONE_AFTER`, audio-only.ts): about 0.5 s; read the hls.js event timeline (levelLoadError times vs `waiting`) before raising a bar |
| Audio only downloaded 34 MB in 8 s, or barely played (audio-only.spec, Firefox on Linux only, soak run 41330071767) | the Linux runners have no audio output: Firefox fails a sound-only element with MEDIA_ERR_DECODE "OnMediaSinkAudioError" once unmuted (video plays on the picture's clock), and hls.js reset the MediaSource and reloaded the whole audio playlist every 2 s, forever (diagnosis run 41333831170: muted fine, unmuted loops) | product: after two resets the player goes back to video and stops offering audio only (`AUDIO_ONLY_BROKEN_AFTER`); the spec checks both outcomes with the sound on and runs the rest muted, as a page starts |
| Audio-only viewer still on the ladder's `audio.m3u8` 20 s after the ladder fell back to the original (audio-only.spec, WebKit on Linux only, run 41729606958): the page answered nothing more, not even `page.evaluate` | the 404 reloaded the source within 15 ms, but `hls.loadSource()` gave the element a new MediaSource, and Linux WebKit (GStreamer) kills the web process on that for sound alone right after the start seek: SIGSEGV on its main thread, always at the same WebKit address (core dumps), about 1 audio-only reload in 300-900, with or without a sound server, a bare hls.js page too, never for video. Playwright WebKit leaves a call that was in flight hanging (only the next one says "Target crashed") and the dead page's process is missing from the gdb dump | product: an audio-only reload for a vanished playlist keeps the MediaSource (`reloadAudioOnlyInPlace`, audio-only.ts: hls.js `transferMedia`); the spec checks the element's MediaSource URL stays the same. To see such a crash: core dumps (`kernel.core_pattern`, `ulimit -c`) and a probe that reloads in a loop; a hung page in a WebKit trace may be a dead one |
| Reload probe "40 source reloads in a row (audio, transfer)": 26 reloads fine, then "not playing: ct 24.6 rs 4 paused false" (WebKit on Linux, 23 of 25 repeats, soak run 41757062883) | not a stop: the playhead had jumped back (currentTime 44 → 11) and was playing on; the probe waited for currentTime to pass where it stood before. The jump was real: a playlist read again in place (`transferMedia`, `loadSource`, `attachMedia`) is placed by hls.js from the first segment its window lists then, while the element's buffer and playhead stay on the timeline of the window the viewer joined, so once the window slid each reload left the playhead further "ahead of live" (negative `hls.latency`) until hls.js jumped back to its live sync position (Chromium too) | product: once the first segment of the new read is buffered, the reload in place moves the playhead into it (hls.js's start position) and flushes the rest through hls.js (`reloadAudioOnlyInPlace`); audio-only.spec reads the playlist again after the window moved on and counts the seconds played ahead of live (18 of 18 failed without the fix on Linux, all three engines). Emptying the buffer at the reload instead made a `waiting` with nothing buffered, the adaptive delay held playback, and Linux WebKit stayed paused about one time in two (soak run 41766158247). A probe that waits for playback to "move again" counts progress, not a currentTime past the old one |
| Audio-only reread test: "6 s more of playback, Received: 0" (audio-only.spec, WebKit on Linux, main run 41828698597; about one run in eight with a logging probe) | the reload in place sought into the new segment and flushed the old media through hls.js at once; the remove ran while WebKit (GStreamer) was still seeking, and the pipeline then played with no clock: currentTime ran from the seek target to the buffer end in a fraction of a second and then jumped 2 s at each new segment (each segment consumed as it came, so the stall monitor saw no playback), status "Buffering…" | product: the old media is flushed only once the seek is over (`seeked`), leaving out what the new read buffered meanwhile (`reloadAudioOnlyInPlace`; unit test "flushes nothing while the seek … runs"). Read `currentTime` from the trace's evaluate results: 2 s steps at each segment arrival mean a clockless pipeline, not a stall |
| `cache-restore.test.ts` "cuts off a try that hangs" missed (macOS unit soak, run 41330071767; 3.2 s = two time limits) | the fake restore counted its own tries in a file; on a loaded runner a new node took over the 1.5 s limit to start, was cut off before counting, and try 2 counted itself as try 1 and hung too | the try number comes from the parent's "try 1 of 2" warning (the test's `log` leaves a marker); a test cuts off a slow-starting try on purpose |
| Cache or upload step hung and failed the job | GitHub service incident | cache/diagnostics steps are non-fatal with short timeouts; tests and builds stay fatal |
| Main-thread proof-of-work test timed out at 15 s (`pow-fallback.test.ts`, Windows unit, run 41226625450) | the test faked the global `setTimeout` for the worker watchdog; the real altcha solver yields with `setTimeout(0)` once a solve passes 200 ms (a loaded runner: p95 193 ms locally under load), and the faked one never fired | inject the clock (`solvePow` `timers`) and leave the global timers real while real code runs; a test that makes the solve slow (`performance.now` stub) proves the yield path |
| WebKit (Linux) page froze for good mid-test (expect hung past its own timeout) when it joined within ~40 s of OBS (re)connecting; gdb: main thread in `gst_pad_push_event`, `webkitmediasrc` thread waiting on it | the fake OBS's 4 s burst made MediaMTX date two 2 s segments 1 ms apart; hls.js aligns audio to video by those dates (first audio segment vs middle video one), shifting audio by any date/duration mismatch (a segment after a burst, a few ms otherwise); near a segment boundary it loaded audio and video of neighbouring segments and jumped to where only video was buffered: WebKit's GStreamer media source deadlocks on that seek | product: inside a run the origin dates each segment as the previous one plus its duration, exactly (`withDate`, hls/playlist.ts; program-date-time.test.ts, stream-start.spec.ts; a 250 ms tolerance still froze 4 starts in 5). Log the page's MSE calls (appendBuffer, remove, currentTime) from an init script to see such a start |
| WebKit (Linux): a test's first `page.goto` never committed (the request sent, status -1, no answer in the trace; 150 s test timeout), about once in 1000-3000 WebKit tests, often right after a test whose viewer played video (soak 41794279205: `loginPanel`); gdb: every WebKit process idle | WebKit, not media: both servers send `Cross-Origin-Opener-Policy: same-origin`, so a page's first navigation to them moves to a new web process when the answer arrives (the network process asks the UI process). When the old web process's DidStartProvisionalLoadForFrame reaches the UI process after that request, WebPageProxy takes it for a new navigation and cancels the swap's provisional page (`didStartProvisionalLoadForFrameShared`, still in WebKit main): no commit, no error. A loopback answer in ~1 ms and a busy CPU make the swap win now and then. WebKit's release logs show it: `WEBKIT_DEBUG=Loading,ProcessSwapping WEBKIT_DEBUG_OUTPUT=stderr` (with `DEBUG=pw:browser`), "ProvisionalPageProxy::cancel" right after "continueNavigationInNewProcess" | in WebKit the first request of every page the fixtures open goes through a route that lets it through unchanged, once (`routeFirstRequestOfEachPage`, fixtures.ts): the request then waits in the web process, and its route question goes to the UI process on the same connection after DidStartProvisionalLoadForFrame, so the swap can no longer overtake it. Not every request: a route sends each request through the test process and turns the HTTP cache off, and after `close()` Playwright answers no route (a held request made the close screenshot wait 5 s). Measured without SwarmCast (a new page's first goto to a local COOP page, Docker arm64, busy CPU): 12 stalls in 30,000 tries against 0 in 30,000 with the route, side by side; 0 in 10,000 without COOP; CI runners 5 in 24,000. In the suite's pattern (close a playing watch page, then a fresh context's goto; CI) 2 in about 2,800. `first-goto.spec.ts` failed 4 runs in 30 without the route; WebKitGTK 2.52 (GNOME Web) lost 6 of 10,000 such loads, 0 of 5,500 without COOP; stopping the player before closing changed nothing (1 stall in about 1,300 cycles). `first-goto.spec.ts` |
| SwarmCast died 31 ms after Stop with `{"level":"fatal","err":"setTypeOfService EINVAL"}` from `writeH1` (desktop.test.ts, macOS, run 41612339510) | product, not the test: Node 24's `fetch` (undici 7.x) calls `socket.setTypeOfService(0)` on each new connection before its first write; when the other side resets the connection in between (during Stop: most likely the origin's poll of MediaMTX, the only plain-HTTP peer that goes away then), macOS answers EINVAL and Node throws it inside the socket's `connect` event, outside the request. A server in another process that resets every connection makes 6-15 % of fetches throw it (Node 24.19-24.22.2; not Node 26, which has undici's fix) | `guardTypeOfService` at server start (`src/core/type-of-service.ts`): only that error is ignored and the request rejects by itself; `type-of-service.test.ts` (unit: real resets, and a refused option at undici's `connected` channel; integration: the built server with every connection refused). Remove it once Node 24 ships nodejs/undici#6076 |
| Server fails at start with EADDRINUSE on a fixed port nothing else listens on (e2e control port 38082, run 41192273509) | the port lay in the OS ephemeral range (Linux 32768-60999, macOS/Windows 49152-65535): an outgoing loopback connection, or its TIME_WAIT, held 127.0.0.1:<port> | port 0 where possible; else a fixed port from `FIXED_PORTS` in 10000-19999 (`scripts/test/lib/ports.mjs`), checked by `assertFixedPorts` at start and by `ports-zone.test.ts` |

## CI

`pipeline.yml` is the one entry point; `ci-ok` is the single required check and is red on any failure or
cancellation. Merge only with every check green on the exact head (`gh pr merge --squash
--match-head-commit`). Release: verify, full pipeline, sign, publish; every version ships as at least two verified betas first.
The run never passes on a re-run (`ci-ok` fails on `run_attempt > 1`): after an outage, start a new run. The build fails if a devDependency reaches anything shipped (`.github/scripts/no-dev-deps.mjs`). Details: `.github/workflows/README.md`, docs/RELEASING.md, docs/TESTING.md, AGENTS.md.

## References used to shape these rules

Meszaros, xUnit Test Patterns; Khorikov, Unit Testing: Principles, Practices, and Patterns; Freeman &
Pryce, Growing Object-Oriented Software, Guided by Tests; Aniche, Effective Software Testing; Beck, TDD
by Example; Software Engineering at Google ch. 11-14; Vitest, Playwright and Rust Book testing docs.
