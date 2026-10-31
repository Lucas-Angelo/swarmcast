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
   e2e server is shared by the whole run: every test restores what it changes.
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
| System (Windows installer/app/Direct/quality/OBS, Docker x64/arm64, clean machine, apt, DMG) | harnesses | `scripts/test/**` | CI only (`pipeline.yml`), see docs/TESTING.md |
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
| First test of a fresh browser times out | engine cold start (system font fallback, Windows Defender scanning a new binary) | `globalSetup` warms every engine; per-process font warm-up before the page under test |
| Frame timing too slow on macOS Chrome | software raster on GPU-less VM | measure main-thread frame work (message from a rAF callback), not two rAFs |
| Player stalls ~3 s on macOS Chrome even without load | runner noise | same-run baseline comparisons; stall comparison not on darwin, data in the spec |
| Bench "every message reaches everyone" failed | scenario ran at the budget edge | give the scenario the headroom its claim assumes |
| Artifact download failed after 5 retries | GitHub artifact service | `.github/actions/fetch-artifact` (3 tries, 30 s/90 s) |
| Join never posted / click did nothing | a status line above the button hid itself mid-click and moved the button (press on the button, release elsewhere, click on the ancestor) | never move a control after it appears (status below the button, page shown only when ready); Playwright checks the hit target only on press |
| Watch page froze 2-7 s in layout (chat not visible within 5 s), on the first run of a fresh Windows runner only, in two workers' browsers at once | the machine's first load of system fonts (the corpus's CJK/Indic fallbacks) holds up every process's font lookups; Chrome's renderer lays text out with a blocking call to the browser's font service (trace: one Arial match 1.8 s) | globalSetup renders what the specs render (the watch page with the whole corpus) before any test |
| Chat message not shown in a visible page | rAF can stop for a page that still reports visible (occluded/background windows) | timer fallback when no frame comes (`render.ts`, `stats.late`) |
| Slow mode refused a send at the end of the countdown | client counted from send, server from receipt | count from the ack, follow the current slowS, hold Send while a message is in flight |
| Firefox goto never reports DOMContentLoaded | automation layer (Juggler) loses the event on a COOP process switch | wait for `commit` + the real ready signal (Watch enabled), never DOMContentLoaded |
| Loop-delay check fails only on macOS CI | the OS de-schedules the process (3 shared vCPUs); raw loop delay counts preemption | measure the server's own blocking (thread CPU + loop active time) |
| Bench bot closed by the server | jitter pushed a bot over the server's 20 frames / 10 s ceiling | load generators keep a margin under every server limit |
| A viewer barely played after a forced stall (macOS, once in 43 media jobs) | the quality ladder's load guard dropped 480p mid-test ("behind", the runner's CPU shared with the test's browsers); the ladder's playlists vanished and the server answered 503 "not started", which players retry for minutes | product: 404 for a playlist the stream no longer lists, so the player reloads; e2e: the guard drops a rendition only when a spec asks (`server.ts` SpecLoadGuard, `POST /shed`) |
| After the ladder fell back to the original, the viewer froze 9 s (quality.spec, macOS and Linux) | the origin kept MediaMTX's playlists from before the ladder: they began with the gate's 2 s OBS connections, one of them in the audio playlist only; the player started on the oldest video segment and never found its audio until the stall watchdog moved it | a playlist the served stream did not list starts its window over when it comes back (`HlsOrigin.setSource`, `origin-runs.test.ts`); read the served playlists from the trace's resources before guessing |
| Cache or upload step hung and failed the job | GitHub service incident | cache/diagnostics steps are non-fatal with short timeouts; tests and builds stay fatal |

## CI

`pipeline.yml` is the one entry point; `ci-ok` is the single required check and is red on any failure or
cancellation. Merge only with every check green on the exact head (`gh pr merge --squash
--match-head-commit`). Release: verify, full pipeline, sign, publish; every version ships as at least two verified betas first.
The run never passes on a re-run (`ci-ok` fails on `run_attempt > 1`): after an outage, start a new run. The build fails if a devDependency reaches anything shipped (`.github/scripts/no-dev-deps.mjs`). Details: `.github/workflows/README.md`, docs/RELEASING.md, docs/TESTING.md, AGENTS.md.

## References used to shape these rules

Meszaros, xUnit Test Patterns; Khorikov, Unit Testing: Principles, Practices, and Patterns; Freeman &
Pryce, Growing Object-Oriented Software, Guided by Tests; Aniche, Effective Software Testing; Beck, TDD
by Example; Software Engineering at Google ch. 11-14; Vitest, Playwright and Rust Book testing docs.
