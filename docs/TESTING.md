# Testing

How SwarmCast is tested: the rules every test follows, where each kind of test lives and how to
run it, and which tools the system tests use (and why). The commands are also in
[DEVELOPMENT.md](DEVELOPMENT.md); the desktop app's test matrix is in [DESKTOP.md](DESKTOP.md#testing),
the CI stages in [.github/workflows/README.md](../.github/workflows/README.md).

## Rules

These hold for every test on every OS (macOS arm64 and x64, Windows, Linux x64 and arm64).

- **Zero failures, zero retries.** Every run of every test passes. Nothing is retried: Playwright
  runs with `retries: 0`, there is no `--retries`, no `toPass` loop around an action, no re-run of a
  job to get it green, and no "flaky" result counts as acceptable. A failure is a bug to fix at its
  root, in the test or in the product. Soak runs ([below](#soak)) only say how much evidence there is.
- **Pass or fail, nothing in between.** A check either passes or fails the run: there is no
  "warning" or "known bug" verdict that lets a job stay green. What a suite cannot judge (a
  measurement, an outcome nothing documents) is recorded as information, never in place of a check
  (the Windows suites' `record()` and `junit.mjs` refuse any other verdict).
- **Arrange / Act / Assert.** Inside a test body the only comments are `// Arrange`, `// Act` and
  `// Assert` (a pure function may need only Act and Assert; a flow repeats Act/Assert pairs). Why a
  value or a wait is what it is goes into the test's name, a named constant, a helper's doc comment
  or the file header.
- **No waits that "let things settle".** A test waits for the event or state it needs: Playwright's
  web-first assertions and `expect.poll`, `until`/`poll`/`waitForLine` of
  [scripts/test/lib/wait.mjs](../scripts/test/lib/wait.mjs), a process's exit, a log line, a socket
  message, always with a deadline. When time itself is the subject, the clock is injected (Vitest fake
  timers, Playwright `page.clock`, `Instant` arguments in Rust). Real time is used only for windows a
  test *measures*; each is a named constant ([list](#measured-windows)).
- **Independent tests.** Each test makes its own fixture (a folder from `mkdtemp`, a server on port 0)
  and tears it down whatever the outcome (`onTestFinished`, a Rust `Drop`), files and processes
  before their folder. No test depends on another's state, on the order of tests, on the machine's
  language or on what else runs on the machine.
- **Behaviour, not implementation.** When a test would need contortions (sleeps, reaching into
  internals, the machine's locale), the code gets a seam instead: an injected clock, OS, file lookup
  or language (for example `data_dir_for`, `sidecar_path_for`, `tooltip_in`, `prompt_text_in` in the
  desktop shell), and the test checks what the user sees.
- **One helper per concept.** Shared fixtures live in the helper files of each area (below); a new
  helper first looks for an existing one.

### Across operating systems

- Paths are built with `path.join` (Rust `Path::join`), never with `/` or `\`; file names may be
  NFD-normalised on macOS and are case-insensitive on macOS and Windows.
- Text files the Windows tools read (`.cmd`, `.ps1`) keep CRLF; parsers accept `\r\n`.
- Windows cannot delete or rename a file that is open (EBUSY/EPERM): close the handle first (drop a
  writer before its folder), instead of retrying the delete.
- Processes: there is no SIGTERM on Windows (Node's `kill()` ends the process at once), so a graceful
  stop is a message or Ctrl+C, and a forced stop is `taskkill /T /F` of the tree
  ([scripts/test/lib/proc.mjs](../scripts/test/lib/proc.mjs)); on POSIX every tracked child leads its
  own process group. A stop is confirmed (no process of the tree left), not assumed.
- Servers a test starts listen on `127.0.0.1` and port 0: no collision with another run or with a
  SwarmCast on the machine, and no Windows Firewall prompt.
- Timers: Windows rounds short timers to its clock tick (about 15.6 ms), and CI VMs (above all the
  macOS ones, 3 vCPUs) stop processes for tens of milliseconds at random. Timing checks compare with
  a baseline of the same run and measure the process's own work (the [chat bench](#chat-bench)), never
  an absolute duration where it can be avoided.
- Locale and time zone are set by the test when they matter (`SWARMCAST_LOCALE`, `TZ`), or the code
  under test takes them as an argument.
- Shells: bash scripts also run on macOS's bash 3.2; the Windows scripts target Windows PowerShell 5.1.

### Infra recoveries

The only waits that are not for SwarmCast's own state are for runner infrastructure that is not under
test. Each is named, logged as `infra recovery: …` (counted by the soak) and never wraps a check:

| What | Where | Why |
|---|---|---|
| A brand-new quick-tunnel name that the runner's resolver does not know yet | `waitForTunnelName` in [scripts/test/lib/viewer.mjs](../scripts/test/lib/viewer.mjs) (Windows suites, preflight); the host-side `/healthz` wait of `run.sh`'s tunnel check | the zone caches NXDOMAIN for its 60 s negative TTL: the wait is a lookup on Cloudflare's resolvers until they know the name, then one lookup on the runner's resolver (never asked before, by the app either), then the check runs once |
| `hdiutil detach` while macOS services still scan a new volume ("Resource busy") | `detach` in [scripts/test/desktop/verify.mjs](../scripts/test/desktop/verify.mjs) | only "Resource busy" is waited out, then the detach is forced; any other error fails |
| `hdiutil` "Resource busy" while the .dmg is made | the .dmg step of [scripts/build/desktop.mjs](../scripts/build/desktop.mjs) | the create-dmg script Tauri vendors does not retry it (tauri#14686): up to 4 tries, 5, 10 and 20 s apart, only on "Resource busy"; any other failure fails at once |
| A registry hiccup on `docker pull` | [scripts/test/docker/pull.sh](../scripts/test/docker/pull.sh) | Docker Hub's 502s are the network, not the test |
| A slow apt mirror, an artifact service hiccup | `.github/scripts/apt-retry.sh`, `.github/actions/fetch-artifact` | CI infrastructure |
| A port taken by another process between the probe and MediaMTX's bind | `bootApp` in apps/server/test/integration/helpers.ts | a race between concurrent runs, not SwarmCast behaviour: one logged retry on new ports |

### Measured windows

Real time that a test measures, on purpose:

| Window | Where | What it measures |
|---|---|---|
| `BASELINE_SAMPLES` (5 s) and `SAMPLE_MS` (1 s) | [scripts/test/chat/bench.ts](../scripts/test/chat/bench.ts) | the server at rest with everyone connected, then during the run, sampled every second |
| a scenario's length, rates, raid and reconnect times | [scripts/test/chat/scenarios.ts](../scripts/test/chat/scenarios.ts), [bots.ts](../scripts/test/chat/bots.ts) | the load itself |
| `measuredWindow()` | the e2e fixtures (apps/server/test/e2e) | the windows an e2e test measures (playback, stalls); the only real-time wait there |
| `ALIVE_AFTER_PANEL_S` (5 s) | [scripts/test/docker/appimage-test.sh](../scripts/test/docker/appimage-test.sh) | the AppImage still runs after opening its panel (a crash while the webview loads) |
| `ClickHoldMs` (120 ms) | [scripts/test/windows/console-ctl.ps1](../scripts/test/windows/console-ctl.ps1) | not a wait: how long the simulated left button stays down in a real click |

## Where the tests are

| Kind | Where | Runner | How to run it here |
|---|---|---|---|
| Unit | `apps/*/test/unit`, `packages/*/test`, `scripts/*/test`, `site/test/unit` | Vitest | `npm test` |
| Integration | `apps/server/test/integration` | Vitest | `npm run test:integration` (needs `ffmpeg`, `npm run fetch-bins`) |
| End to end | `apps/server/test/e2e`, `apps/viewer/test` | Playwright | `SWARMCAST_NO_OPEN=1 SWARMCAST_E2E_PORT_OFFSET=<n> npx playwright test` |
| Desktop shell | `#[cfg(test)]` modules of `apps/desktop/src-tauri/src` | cargo test | `npm run desktop:test` |
| Start and uninstall scripts | `scripts/test/run.sh`, `uninstall.sh`, `run.ps1`, `uninstall.ps1` | their own | `bash scripts/test/run.sh` (macOS, Linux); `powershell -File scripts\test\run.ps1` |
| System (real installers and packages) | `scripts/test/windows`, `preflight`, `desktop`, `docker` | their own (below) | CI only: they install and start the real app on a clean machine |
| Chat load | `scripts/test/chat` | its own | `SWARMCAST_NO_OPEN=1 node --import tsx scripts/test/chat/bench.ts --scenario quiet,lively` |
| Soak | `scripts/ci/soak-*.mjs`, `.github/soak-plan.json` | `soak.yml` | CI only |

### Unit tests

Server unit tests use `apps/server/test/unit/helpers.ts` (`tempDir`, `captureLog`, `manualClock`,
`killIfRunning`) and `live-helpers.ts` (`makeController`, `startController`, `inactiveDirect`,
`panelServer`). Every resource is cleaned up through `onTestFinished`, in reverse order, so files and
processes close before their folder is deleted. The panel is tested with `app.inject()` and never
listens. Time-dependent code takes an injected clock or runs on Vitest fake timers. Test bodies
contain only `// Arrange`, `// Act` and `// Assert`.

### Integration tests

Integration tests use real MediaMTX, ffmpeg, server processes and 127.0.0.1 sockets, and local
stand-ins for everything off the machine: no test downloads blocklists or reaches GitHub, Cloudflare
or a router. `helpers.ts` has no Vitest imports (the e2e server and the scripts use it too) and
provides `testConfig`/`writeConfig`, `bootApp`, `ServerProcess`, `signIn`, `hangingServer` and
`startFeed`. `viewers.ts` (Vitest suites only) runs a live's public server in-process with
`ControlClient`, whose waits are on the arriving messages. `tmpDir()` folders are deleted after the
run. Waits use `until()`/`waitForLine()` on the real event, never sleeps. Test-only seams:
`SWARMCAST_SPEEDTEST_URL`, `SWARMCAST_GITHUB_URL`, `NODE_EXTRA_CA_CERTS`.

### End-to-end tests

E2E (`apps/server/test/e2e`): one server per run. The gate resets it before each test, and
fixtures put back what a test changes. Get browsers, scripted viewers, chat and branding from the
fixtures. Test bodies hold only Arrange/Act/Assert comments. The only real-time wait is
`measuredWindow()`, for measured windows. Names come from `uid()`, which is unique per test. Never
retry. Run with `SWARMCAST_NO_OPEN=1 SWARMCAST_E2E_PORT_OFFSET=<n> npx playwright test`. The e2e HLS
port is 38083 + offset; the server refuses any offset that hits a reserved port
([scripts/test/lib/ports.mjs](../scripts/test/lib/ports.mjs) `RESERVED`).

### Desktop shell (Rust)

The shell's logic is tested where it lives, in `#[cfg(test)]` modules: the shell ↔ server protocol,
page tracking with injected `Instant`s, navigation rules, the data folder per OS (`data_dir_for`
takes the OS and the environment), the sidecar lookup (`sidecar_path_for` takes the OS and a file
lookup, so the AppImage rule is tested on every OS; one test keeps the real file system), the
tooltips and the update dialog in a given language (`tooltip_in`, `prompt_text_in`), and the update
channels and version order. `test_support::TempDir` gives a test its own folder, removed on drop even
when an assertion fails. Tests run in parallel threads: none touches environment variables or the
current directory. CI runs `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and
`cargo test`; the window, tray and updates are tested on real machines by
[scripts/test/desktop/verify.mjs](../scripts/test/desktop/verify.mjs).

### Coverage

*(The coverage section is added with the coverage tooling.)*

## System tests

The system harnesses test the real thing: the release packages and installers, installed by their
real start scripts on clean CI machines, with real browsers, a synthetic OBS feed from ffmpeg, real
OBS Studio and the real Cloudflare quick tunnel.

| Harness | Runs on | Entry point (CI) |
|---|---|---|
| Windows suites: installer, app, direct, quality, obs | Windows runners (`_windows.yml`) | `node scripts/test/windows/<suite>.mjs --work release/win-e2e --out <file>.json` |
| Preflight: install, stream, watch, P2P, kick, stop, tunnel | macOS, Linux, Windows (`_desktop.yml`) | `node scripts/test/preflight/verify.mjs --release-dir release --tunnel --chrome` |
| Desktop app: installers, autostart, kill, quit, update A → B | macOS, Linux, Windows (`_desktop.yml`) | `node scripts/test/desktop/verify.mjs --installers … --update-from … --update-to …` |
| Linux in Docker: start script, AppImage, OBS, Playwright | x64 and arm64 Linux (`_docker.yml`) | `scripts/test/docker/{run,appimage,obs,e2e}.sh` |
| Start and uninstall scripts | macOS, Linux, Windows (`_node.yml`) | `scripts/test/run.sh`, `uninstall.sh`, `run.ps1`, `uninstall.ps1` |

Shared pieces, one place each:
[scripts/test/lib](../scripts/test/lib) (no side effects when imported): `wait.mjs` (`until`, `poll`,
`orTimeout`, `waitForLine`), `proc.mjs` (tracked child processes, tree kills, `ownerOf`),
`ports.mjs` (`isListening`, test port blocks), `ffmpeg.mjs` (the test ffmpeg and the OBS-like feed),
`release-server.mjs` (a release folder over HTTP on 127.0.0.1), `app.mjs` (the bare-OS environment
of the start scripts, the panel login from their output, the live link), `viewer.mjs` (join, play,
the player's state, the page state dumped when a check fails), `junit.mjs`, `cookie-jar.mjs` (one
fetch-based browser: cookies by name for every address of a site, redirects never followed; the
integration tests' `Jar`, the chat bench's bots, the unit tests of the public server); and
[scripts/test/docker/lib.sh](../scripts/test/docker/lib.sh) (`wait_for`, `gone`) for the bash side.

Each JavaScript harness keeps its own report (the Windows suites' `<out>.json` and Markdown table, the
`PASS`/`FAIL` or `✓`/`✗` lines the soak reads) and also writes JUnit XML for the CI summary:
`<out>.junit.xml` next to a Windows suite's `--out`, `<out>/junit.xml` for the chat bench, and the file
given with `--junit FILE` for preflight and the desktop test. A Windows check that fails dumps every
open page's state (address, readyState, navigation timings, scripts fetched or not, resources) and the
process tree, ports and reserved port ranges, whether or not it aborted its section.

### Chat bench

[scripts/test/chat/bench.ts](../scripts/test/chat/bench.ts) runs the real public server and chat hub
in its own process (fake MediaMTX and quick tunnel, port 0, no data folder) and forks
[bots.ts](../scripts/test/chat/bots.ts) for up to 180 bots, so their work never counts as server CPU.
Each scenario has its pass criteria (delivery latency, protection, budget, memory, reconnects). Two
measurement details matter:

- **Event-loop delay.** The check is that chat load keeps the server's event loop within 20 ms of a
  calm baseline. It measures the delay *the server's own work* causes: each 10 ms tick's lateness,
  bounded by the server thread's CPU time and by the loop's active time since the previous tick
  (`OwnLoopDelay`), at the same p99 as before. `monitorEventLoopDelay` also counts the time the OS
  or the VM did not run the process: on GitHub's macOS VMs it reached 50-110 ms with the server idle
  (ELU 0.01-0.14 and 1 % CPU in the same second), in a random scenario of every run, while a real Mac
  and the Linux and Windows runners stayed flat. It is still recorded, for diagnosis.
- **The end of a run.** The bots stop, then ping the server on every socket (the server answers a
  ping after every frame before it), then the bench adds a system line, a priority item never
  dropped, and waits until every observer has it. Every message has then arrived or been reported
  as skipped. The bots also keep under the server's per-socket ceiling of 20 chat frames per 10 s
  with a one-second margin, so a jittered send rate can never get a socket closed.

### Soak

`soak.yml` repeats suites from `.github/soak-plan.json` on fresh runners;
[scripts/ci/soak-run.mjs](../scripts/ci/soak-run.mjs) runs each suite's usual entry point and turns
its output into checks (its parsers are reused by the CI summary), and
[soak-report.mjs](../scripts/ci/soak-report.mjs) gives per check the runs, failures and a 95 % upper
bound of the failure rate. A failure in any run is a bug.

## System tests: tools

The system harnesses are hand-written: sequential "sections" with `check()`/`must()` in Node, PASS/FAIL
helpers in bash and PowerShell. Before refactoring them further, the standard tools for each kind of
check were evaluated (October 2026). For each: what it would replace, what it brings, what it costs,
and the decision.

| Tool | Would replace | For | Against | CI cost / OS support | Decision |
|---|---|---|---|---|---|
| **Playwright Test** (projects, fixtures, `test.step`, `expect.poll`, reporters) | the `section`/`check` runner of `scripts/test/windows`, preflight, desktop | already a dependency; traces, HTML and JUnit reports, `expect.poll` | a worker is shut down after any failure and its module state is lost, serial mode skips the rest of the group: the Windows suites share one installed app across sections and must go on after a failed one; default 30 s test timeout for 5-50 min flows; the suites' JSON feeds the Windows summary and the soak | none extra; every OS | **Not now.** Kept for the browser e2e suites. A migration would need a Windows machine to prove it (the suites only run there); the shared libraries already give the same waits, and JUnit comes from the harnesses themselves |
| **node:test** (built in: sequential by default, subtests, `todo`, `t.waitFor`, `spec`/`junit` reporters) | the same runner | zero dependencies; failures do not stop the next test and module state stays (one process), which fits sequential system tests; JUnit built in | still a rewrite of every suite's structure; the soak's Windows result format would change | none; every OS | **The candidate** for the Windows suites, preflight and the desktop test once a Windows machine can run them before and after |
| **Pester** (5.9 preinstalled on the windows-2022/2025, ubuntu-24.04 and macos-15 images; 6.x current) | `run.ps1`, `uninstall.ps1` | `Describe`/`It`, `Mock`, `TestDrive`, NUnit/JUnit results | the Discovery/Run phases change where code may live; whether 5.9 is visible to Windows PowerShell 5.1 on the images is unconfirmed; v5 is no longer maintained and v6 is not preinstalled; about 1,500 lines that can be run only partly off Windows (pwsh on macOS skips the Windows-only parts) | preinstalled (or `Install-Module`); every OS with pwsh | **Kept as scripts** until it can be run on Windows PowerShell 5.1; then Pester 6, pinned |
| **bats-core** (TAP/JUnit formatters, `setup_file`, `run`, bats-assert) | `run.sh`, `uninstall.sh`, the in-container scripts | standard runner and reports, per-test isolation | not on the runner images (npm `bats` or apt needed); each test runs in its own process, while these cases build on each other (install, then update, then a broken update…); the AppImage host is minimal on purpose (nothing the app could borrow) | a new dev dependency | **Kept as scripts**; the in-container scripts now share [lib.sh](../scripts/test/docker/lib.sh) |
| **Testcontainers** (node, 12.x) | the orchestration in `scripts/test/docker/*.sh` | typed container lifecycle, wait strategies, automatic cleanup (Ryuk) | the checks inside the containers must stay bash (minimal images by design); Ryuk is another image to pull from Docker Hub; Docker only on Linux runners, where these suites run anyway | a new dependency | **Kept as scripts**: the bash orchestration is small and its waits are now conditions |
| **WebdriverIO + tauri-driver** / `@wdio/tauri-service` | parts of `scripts/test/desktop/verify.mjs` | real clicks in the app window (splash, panel, "Update now") | the important checks are outside the webview (installers, autostart entries, the Job object, relaunch after an update, the tray menu, which WebDriver cannot reach); `tauri-driver` has no macOS driver (the embedded `tauri-plugin-wdio-webdriver` would have to be built into a test build of the app, never into a release); Edge driver versions must match WebView2 | new npm and Rust dependencies, a test build per target | **Not now**: worth its own work package for UI-level desktop checks, with a test-only build |

What changed instead: the harnesses' waits, retries and reports. Every fixed sleep became a wait on
its condition with a deadline (or one of the named [measured windows](#measured-windows)); no check is
retried (the Cloudflare checks and the tunnel section included); the copies of the waits, the release
server, the port probe, the feed, the viewer steps and the installer/panel steps became one shared
library; and every JavaScript harness writes JUnit next to its own report.

Sources: [actions/runner-images](https://github.com/actions/runner-images) (software lists),
[pester.dev](https://pester.dev/docs/usage/discovery-and-run),
[bats-core](https://bats-core.readthedocs.io/en/stable/writing-tests.html),
[Playwright parallelism and retries](https://playwright.dev/docs/test-parallel),
[node:test](https://nodejs.org/docs/latest-v24.x/api/test.html),
[Testcontainers for Node.js](https://node.testcontainers.org/),
[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/),
[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
