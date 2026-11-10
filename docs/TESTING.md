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
  an absolute duration where it can be avoided. A cost that grows with the input (linear, a binary
  search) is shown by counting the work the code does (`chatTextWork()`, `cidrSearchSteps()`), not by
  timing it; a time limit the code under test enforces runs on an injected timer when the test needs
  a try to pass it or not (`restore({ timer })` of the cache action).
- Locale and time zone are set by the test when they matter (`SWARMCAST_LOCALE`, `TZ`), or the code
  under test takes them as an argument.
- Shells: bash scripts also run on macOS's bash 3.2; the Windows scripts target Windows PowerShell 5.1.

### Infra recoveries

The only waits that are not for SwarmCast's own state are for runner infrastructure that is not under
test. Each is named, logged as `infra recovery: …` (counted by the soak) and never wraps a check:

| What | Where | Why |
|---|---|---|
| A brand-new quick-tunnel name that the runner's resolver does not know yet | `waitForTunnelName` in [scripts/test/lib/viewer.mjs](../scripts/test/lib/viewer.mjs), only with the real Cloudflare (`real-services.yml`, never a gate; the gate's tunnels go to the [local stand-in](#no-third-party-service-in-the-gate)) | the zone caches NXDOMAIN for its 60 s negative TTL: the wait is a lookup on Cloudflare's resolvers until they know the name, then one lookup on the runner's resolver (never asked before, by the app either), then the check runs once |
| A live link that Cloudflare's edge answers with its own 530 page (no connection for the tunnel) while cloudflared runs on | `joinAndPlay` in [scripts/test/preflight/verify.mjs](../scripts/test/preflight/verify.mjs), only with `--real-cloudflare` (`real-services.yml`); with the stand-in a 530 fails the step | Cloudflare's free quick-tunnel edge, not SwarmCast (gate run 42164021587). It is the app's job to notice and replace the tunnel (`tunnel/watch.ts`), so it is checked: the app must show a new link within its watch time plus the tunnel step's limit, and the viewer then plays that one. The gate checks the same replacement deterministically: `local-cloudflare.test.ts` makes the stand-in answer 530 |
| `hdiutil detach` while macOS services still scan a new volume ("Resource busy") | `detach` in [scripts/test/desktop/verify.mjs](../scripts/test/desktop/verify.mjs) | only "Resource busy" is waited out, then the detach is forced; any other error fails |
| `hdiutil` "Resource busy" while the .dmg is made | the .dmg step of [scripts/build/desktop.mjs](../scripts/build/desktop.mjs) | the create-dmg script Tauri vendors does not retry it (tauri#14686): up to 4 tries, 5, 10 and 20 s apart, only on "Resource busy"; any other failure fails at once |
| A registry hiccup on `docker pull` | [scripts/test/docker/pull.sh](../scripts/test/docker/pull.sh) | Docker Hub's 502s are the network, not the test |
| A slow apt mirror, an artifact service hiccup | `.github/scripts/apt-retry.sh`, `.github/actions/fetch-artifact` | CI infrastructure |
| A network error in `npm ci` that npm's own retries did not get past, or a timed-out prebuild-install download in an install script | the "npm ci" step of `.github/actions/setup` (`.github/scripts/npm-network-error.mjs` tells them apart) | the registry or GitHub, not the test: one more `npm ci`, as a warning; any other failure fails the step (run 41664754395) |
| A GitHub release download that answers 5xx, breaks off or stalls (MediaMTX, cloudflared, Pebble, the test ffmpeg, cargo-llvm-cov, the AppImage tools, pkg's Node.js base binary) | `download` in [scripts/build/fetch-binaries.mjs](../scripts/build/fetch-binaries.mjs) (also through `pkg-base.mjs`), after the Actions download cache (`.github/actions/setup`) | github.com's release downloads, not the test (504s for most of an hour, PR #141): 6 tries in a row without progress, resumed with Range, then the next source, and the GitHub release files once more through GitHub's REST API (`githubApiUrl`, which served them during that outage); a source that worked only after failed tries or through the API logs `infra recovery:`; a SHA-256 pin decides, whichever source. In CI the cache serves the file first, and a download that still fails stops the job at that step (`::error title=fetch-binaries::`): no test runs without its binaries ([.github/workflows/README.md](../.github/workflows/README.md), "Release downloads") |
| NSIS and its Tauri plugin for the Windows installer | the Tauri tools cache of `.github/actions/setup` (`tauri-tools`) | `tauri build` downloads them from github.com with one try each; the cached folder means it does not (a cold cache still downloads once) |
| A 404 from codeload for an action at a commit that exists | `.github/actions/fetch-remote` (our actions run their remote actions from a git fetch) | the runner's own download does not try again after a 404 (run 41636784175); CI infrastructure |
| A port taken by another process between the probe and MediaMTX's bind | `bootApp` in apps/server/test/integration/helpers.ts | a race between concurrent runs, not SwarmCast behaviour: one logged retry on new ports |

### Measured windows

Real time that a test measures, on purpose:

| Window | Where | What it measures |
|---|---|---|
| `BASELINE_SAMPLES` (5 s) and `SAMPLE_MS` (1 s) | [scripts/test/chat/bench.ts](../scripts/test/chat/bench.ts) | the server at rest with everyone connected, then during the run, sampled every second |
| a scenario's length, rates, raid and reconnect times | [scripts/test/chat/scenarios.ts](../scripts/test/chat/scenarios.ts), [bots.ts](../scripts/test/chat/bots.ts) | the load itself |
| `measuredWindow()` | the e2e fixtures (apps/server/test/e2e) | the windows an e2e test measures (playback, stalls); the only real-time wait there |
| `CALM_WINDOW_MS` (2 s) | [apps/server/test/devices/calm.ts](../apps/server/test/devices/calm.ts) | a phone's CPU (the simulator's processes, the emulator's guest), two windows in a row under its bar before a test |
| `ALIVE_AFTER_PANEL_S` (5 s) | [scripts/test/docker/appimage-test.sh](../scripts/test/docker/appimage-test.sh) | the AppImage still runs after opening its panel (a crash while the webview loads) |

## Where the tests are

| Kind | Where | Runner | How to run it here |
|---|---|---|---|
| Unit | `apps/*/test/unit`, `packages/*/test`, `scripts/*/test`, `site/test/unit` | Vitest | `npm test` |
| Integration | `apps/server/test/integration` | Vitest | `npm run test:integration` (needs `ffmpeg`, `npm run fetch-bins`) |
| End to end | `apps/server/test/e2e`, `apps/viewer/test` | Playwright | `SWARMCAST_NO_OPEN=1 SWARMCAST_E2E_PORT_OFFSET=<n> npx playwright test` |
| Real phone browsers | `apps/server/test/devices` | Playwright (+ safaridriver on iOS) | `scripts/test/devices/setup.sh install android`, then `SWARMCAST_NO_OPEN=1 SWARMCAST_E2E_PORT_OFFSET=<n> npx playwright test -c apps/server/test/devices/playwright.config.ts --project=android-chrome`; `setup.sh remove all` afterwards |
| Desktop shell | `#[cfg(test)]` modules of `apps/desktop/src-tauri/src` | cargo test | `npm run desktop:test` |
| System (real installers and the staged server) | `scripts/test/windows`, `preflight`, `desktop`, `docker` | their own (below) | CI only: they install or start the real app on a clean machine |
| Chat load | `scripts/test/chat` | its own | `SWARMCAST_NO_OPEN=1 node --import tsx scripts/test/chat/bench.ts --scenario quiet,lively` |
| Surge (many people at once) | `scripts/test/surge` | its own | `SWARMCAST_NO_OPEN=1 node --import tsx scripts/test/surge/bench.ts --scenario join-burst` (after `npm run build -w @swarmcast/viewer`) |
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
or a router (Cloudflare's quick tunnels go to the [local stand-in](#no-third-party-service-in-the-gate):
`quick-tunnel.test.ts`, `local-cloudflare.test.ts`). `helpers.ts` has no Vitest imports (the e2e server and the scripts use it too) and
provides `testConfig`/`writeConfig`, `bootApp`, `ServerProcess`, `signIn`, `hangingServer` and
`startFeed`. `viewers.ts` (Vitest suites only) runs a live's public server in-process with
`ControlClient`, whose waits are on the arriving messages. `tmpDir()` folders are deleted after the
run. Waits use `until()`/`waitForLine()` on the real event, never sleeps. Test-only seams:
`SWARMCAST_SPEEDTEST_URL`, `SWARMCAST_GITHUB_URL`, `SWARMCAST_TEST_CLOUDFLARE`, `SWARMCAST_TEST_FFMPEG_URL`,
`NODE_EXTRA_CA_CERTS`.

`acme-pebble.test.ts` runs the ACME client against Pebble, Let's Encrypt's test CA, as a process on
127.0.0.1 (every OS; no Docker): the binary `npm run fetch-bins` puts in `vendor/<target>/`
(`pebble` in `scripts/build/versions.json`, a `testTool`: never packaged). It is not Pebble's
release: v2.10.1 can leave the poll of an order that follows its finalize unanswered for good
(letsencrypt/pebble#554), and our client polls right after finalizing (run 42428110733: "AbortError:
The operation was aborted" after the 30 s request timeout; the journal of that poll and Pebble's log
in soak run 42429289741). The binaries are commit 1fcb30c of Pebble's main branch, which has the fix,
built reproducibly and kept in the `ci-deps` pre-release ([RELEASING.md §8](RELEASING.md#8-mirrored-ci-dependencies-ci-deps)).
Go back to the publisher's release files once a release has it.

### End-to-end tests

E2E (`apps/server/test/e2e`): one server per run. The gate resets it before each test, and
fixtures put back what a test changes. Get browsers, scripted viewers, chat and branding from the
fixtures. In WebKit the first request of every page the fixtures' contexts open goes through a route
that lets it through unchanged, since WebKit can lose a page's first navigation to a COOP page
otherwise (fixtures.ts, `routeFirstRequestOfEachPage`). Test bodies hold only Arrange/Act/Assert
comments. The only real-time wait is `measuredWindow()`, for measured windows. Names come from
`uid()`, which is unique per test. Never retry. Run with
`SWARMCAST_NO_OPEN=1 SWARMCAST_E2E_PORT_OFFSET=<n> npx playwright test`. The e2e ports are 11080
(public), 11081 (panel), 11082 (test control), 11083 (MediaMTX HLS) and 11935 (RTMP), plus the
offset; the server refuses an offset that moves one out of 10000–19999, onto another
harness's port or into this machine's ephemeral range.

**Ports.** A test server listens on port 0 when nothing needs its number in advance, or takes one from
`allocPorts()` (a block of 20000–31999 per Vitest worker). A harness whose URL is fixed before its server
starts (Playwright's `webServer`, the desktop update manifest, the quality and OBS scripts, the website
tests) takes its ports from `FIXED_PORTS`, all in 10000–19999
([scripts/test/lib/ports.mjs](../scripts/test/lib/ports.mjs)). Neither range touches an ephemeral range
(Linux 32768–60999, macOS and Windows 49152–65535): every outgoing connection takes its local port from
there, and while it or its TIME_WAIT holds `127.0.0.1:<port>` nobody can listen on it. The e2e control
port used to be 38082 and once failed at start with EADDRINUSE for that reason (run 41192273509).
`assertFixedPorts()` checks a harness's ports at start against this machine's real range, and
`scripts/test/test/ports-zone.test.ts` checks every fixed port, and every port written out in the
workflows and harness scripts, against the defaults and `RESERVED`. A test never relies on a port
another program may hold or free: a port it lets go and checks again comes from `allocPorts()`, and
a test that needs every port busy injects the probe (`createApp({ isPortFree })`) instead of
holding real ports, since one an outgoing connection held while the test took the others can be
free a moment later.

### Real devices

`apps/server/test/devices` runs the viewer in real mobile browsers against the e2e server: Chrome on
an Android emulator (Pixel 7) and Mobile Safari on an iOS Simulator. Each test joins with a nickname
typed on the on-screen keyboard and checks one behaviour: muted autoplay and Unmute by a tap; the chat
under the player with the keyboard up (input and Send inside the visual viewport) and a message both
ways with a scripted viewer (a desktop browser next to the iOS Simulator slowed its taps); the browser
sent to the background and back (playback resumes, Go live returns to the live point); turning the
phone (Android: Chrome's fullscreen video, then SwarmCast's sideways layout; iOS: the sideways layout).

- **Setup:** `scripts/test/devices/setup.sh install android|ios` (a manifest records what it created;
  `setup.sh remove all` deletes exactly that). iOS also needs `sudo safaridriver --enable` once.
- **CI:** `devices.yml` (the `devices` label or by hand; pipeline.yml calls it in release-flavour
  runs). It gets a schedule only after a run of consecutive green dispatches on both jobs. Failed tests keep a screenshot of the whole screen, the player's state (`player`: the
  element, the page's lines and hls.js's playlists and controllers), the screen recording (Android)
  and the device's logs; every job prints `taps.log` and `device.log`.
- **iOS on macOS 27 / Xcode 27:** safaridriver cannot drive iOS 18+ simulators (cryptex runtimes
  outside its sandbox): run iOS in CI (`macos-26`) or with a classic iOS 17.x runtime.
- **Windows 11:** `setup.sh install windows` builds a UTM VM from the official Windows 11 Arm64 ISO
  (downloaded by hand from Microsoft's page) with an unattended answer file and OpenSSH; the
  Windows harnesses then run in it over SSH. SmartScreen's "Run anyway" and the UAC prompt stay manual.

#### How a test drives a phone

A phone fails a test in ways a desktop browser never does: a tap that ends in no click, a page the
browser has not shown yet, a daemon that eats the CPU, a keyboard that is up or not. The harness
leaves none of them to luck; each rule below has the failure that taught it.

1. **A calm device, once and before each test** (`calm.ts`). The phone's CPU is measured over
   two-second windows (`CALM_WINDOW_MS`, a measured window): on iOS every simulator process on the
   Mac (`ps`, executables under a CoreSimulator folder), on Android the guest's `/proc/stat`. The
   device fixture waits until two windows in a row stay under the phone's bar
   (`SIMULATOR_CALM_CORES` 0.5 of a core, `GUEST_CALM_CORES` 1 core) after the boot, so that a new
   device's first-boot work is done before the first test, and again before each test; every window
   goes to `device.log` with the three busiest processes, and a timeout names them. A busy device
   lengthens what the harness cannot time itself: on iOS finger down and up are two steps of one
   W3C `POST /actions` that Safari's automation plays one after the other, and with the Mac 0 % idle
   the finger stayed down 1.26 s, a long press (Devices run 42515339177).
2. **A known start, checked** (`newPhone`, `pageAtRest`). Android: Chrome stopped, its data
   cleared, notifications allowed, upright, then checked: rotation 0, no keyboard, Chrome's window
   in front with the input focus (no dialog over it). iOS: a new WebDriver session (no cookies or
   storage of an earlier one), upright, then checked: one tab, no prompt, Simulator.app hidden.
   Both: the first page shown, in the orientation the phone holds, at zoom 1, nothing full screen.
3. **One gate for every tap** (`actionability.ts`, both phones):
   - the page records the tap first (`armTap`): each trusted touchstart, touchend, mouseover,
     mousedown and click, and every control it reveals meanwhile (`shown>element`), in
     sessionStorage, which outlives a navigation the tap causes;
   - the element must be actionable (`touchState`), Playwright's checks for a click
     (https://playwright.dev/docs/actionability) and what a phone adds: in the page, the page
     shown and in the orientation the phone was turned to, no full-screen change running (the
     page keeps what was full screen at the last fullscreenchange, `recordFullscreen`: WebKit sets
     the full-screen element as its animation begins and fires the change once it is over), enabled, visible by WebKit's rule (no
     box, visibility hidden, opacity 0 on it or on one of its four nearest ancestors), at least
     4 px of it inside the visual viewport (what the on-screen keyboard leaves), not covered at
     the point (`elementFromPoint`), nothing animating on it, no opacity or left transition running
     anywhere, and on iOS zoom 1; then the same scene (point, visible part of the page, every
     control in sight) read again after two animation frames (`actionablePoint`);
   - the finger: W3C touch actions through safaridriver on iOS (`tapActions`; WebKit's automation
     plays them as touches on Safari's view, so Safari's own click synthesis decides, as for a
     finger), DevTools' `Input.dispatchTouchEvent` on Android (Chrome feeds it to the page as the
     system's touches: touch events, its gesture detector's tap, the click, and the keyboard for
     a field; a mouse click raises no keyboard);
   - the tap counts only once the page got the click on the element (`tapEndsInClick`); otherwise
     the test fails with what arrived, the finger's time down, and what the page revealed during
     the tap ("taken for a hover"); on iOS with the simulator's log of the tap. Every tap's timing
     goes to `taps.log`.
4. **The page's own reveals waited out by state.** What a page shows by itself on its own clock
   cannot be gated by a tap: a spec waits for the state after it. The watch page reveals Unmute, Go
   live and "Live" with the video's first `playing`, and the delay behind live (with its "i"
   button) a second later; `watching` (phone.ts) waits for 1.5 s played and the delay shown before
   any tap on the watch page. The join page is touched once Watch is enabled (`joinPageReady`).
   Player controls are focused before a tap (`tapControl`): focus holds them shown, and the gate
   waits out their fade-in.
5. **Every check polls the state, with what it saw.** No single read of something that passes
   through other states (a status line, `paused` during an adaptive-delay hold, a layout during a
   turn): `expect.poll` with a value that says, while waiting, what the page shows.
6. **Playback counted on the media's clock** (`playsOn`): after a step (a turn, full screen, the
   background, Unmute, Go live) the count of `played` seconds starts only once the video plays
   (not paused, not seeking, readyState 3 or more), so the step's own pause or seek is never
   counted against it, and a failure says what the element was doing (readyState, buffered,
   status line).

What the soaks measured (Devices runs 42684571191 and 42694261030: ten iOS jobs and two Android
jobs, each test five times, every repeat on a new simulator or emulator boot):

- Calm, iOS: after a boot 9.1 s at the median, 23.5 s at most (48 boots); before a test 4.6 s
  (two windows), 11.5 s at most. Android: after a cold boot 35 s at the median, 95 s at most (the
  guest at 3.7 to 3.96 of its 4 cores for about 70 s: system_server, Play services, Gboard, the
  launcher, SystemUI; then Google Messages for about 30 s); before a test 4.2 s, 14.8 s at most.
- The gate: 624 iOS taps and 170 Android taps, every one ended in a click on its element. An
  element became actionable after 74 ms at the median on iOS (322 ms at the 95th percentile,
  1.0 s at most), after 405 ms on Android (1.1 s, 2.0 s at most: the keyboard's slide).
- The finger's time down, by the events' time stamps: 55 ms at the median on iOS, 172 ms at the
  95th percentile; Android 43 and 165 ms. The tail is the tap that enters full screen: there the
  page handled touchstart 0.4 to 5.3 s after its time stamp (its click still came), the most
  marginal moment of the lane; the volume check that set the playing video's volume right before
  that tap now asks an element of its own (`playerUi`).

#### Why each rule

- **iOS taps and content that appears:** Mobile Safari turns a tap into a click only if no control
  appears between touchstart and its synthetic mouse move (Apple's Safari Web Content Guide,
  "Handling Events": "if the contents of the page changes on the mousemove event, no subsequent
  events in the sequence are sent"). WebKit's `ContentChangeObserver` watches every style change
  from touchstart to that mouse move, and 32 ms more for an element that is not a form control: an
  element that takes clicks going from hidden to visible inside the layout viewport, or an
  opacity or left transition that ends with one shown, makes the tap a hover
  (`WebPage::handleSyntheticClick`, `isConsideredActionableContent`). The join page's "Checking
  your browser…" (with its "i" button) appeared once the challenge arrived, under a tap on the
  nickname (Devices run 41566408164); the server now sends the page with the line already shown to
  a browser it will check (`server.ts` `Pages.joinChecking`). The watch page's delay behind live
  came up on its 1 s timer 15 ms after the touchstart of a tap on the chat input, about one run in
  15: mouseover, no mousedown, no click (Devices runs 42521418840, 42524374628). It cannot come with
  "Live": hls.js reads its latency as 0 until the video's first `timeupdate`.
- **iOS taps on a page Safari has not shown yet:** WebKit's automation refuses a touch outside the
  visible area Safari keeps for the page ("move target out of bounds",
  `WebAutomationSession::simulateTouchInteraction` checks it against
  `WebPageProxy::unobscuredContentRect`). The live link moves the page to a new web process (the
  viewer pages send Cross-Origin-Opener-Policy); Safari then forgets that area
  (`WebPageProxy::resetState`) and learns it again only from the new page's first frame, while the
  page itself already reports its visual viewport. The tap on the join page's nickname came 147 ms
  after its load event and was refused at (201, 275) of a 402 × 714 page (release-rehearsal run
  42508591582); the join page's first paint comes 7 ms to 1.35 s after its load event (53 loads,
  Devices run 42512440502). WebKit starts a page's next frame only once Safari has taken the
  previous one (`RemoteLayerTreeDrawingArea` waits for `DisplayDidRefresh`), so after two frames
  Safari shows the page where it reports itself. The same holds for a scroll: after a
  `scrollIntoView` Safari still showed the old place for a moment, and a tap there reached another
  element (Devices runs 41181641808, 41183257695); a tap scrolls only an element not wholly in sight.
- **iOS taps at zoom 1:** Mobile Safari makes the click at once only at the initial scale of a
  `width=device-width` page (https://webkit.org/blog/5610/more-responsive-tapping-on-ios/);
  zoomed, it waits to see whether a second tap follows.
- **iOS Simulator load:** the CI Mac has 3 cores, and with a stock iPhone simulator it stayed
  saturated through the run (load average 300 to 550): the push daemon retried Apple's push server
  in a loop and logged up to 2,300 lines a second, which the simulator's diagnosticd relays to the
  Mac's, and Health, Fitness, Siri and the widgets added theirs. `setup.sh` and the suite turn those
  daemons off (`launchctl disable` in the simulator; `ios.ts` `UNUSED_JOBS`), and the harness's
  touch listeners are passive, so WebKit does not hold a tap for the page. A simulator's first long
  boot also has a burst of its own: about a minute in, siriactionsd (Shortcuts) indexes every app's
  actions in its XPC service BackgroundShortcutRunner for some 80 s at up to 120 % CPU (Devices run
  42519281087), which on CI was when the first test began, and the first tap's finger stayed down
  1.3 s (run 42515339177); siriactionsd is in `UNUSED_JOBS` too, and the calm wait after the boot
  holds the first test until whatever else a first boot runs is done. The Mac's load goes to
  `host-load.log`. Each repeat of a test file boots the simulator again (a new worker), and each
  attach quits Simulator.app before it boots a shut-down simulator: one left running and hidden
  from the previous simulator once never showed a window for the next boot (`open` hands a
  running app no arguments), and since that attach left its simulator booted, every later one
  met the same Simulator.app (Devices run 42694261030). An attach that fails shuts down what it booted.
  A simulator's first text field after a boot sets its keyboard daemon (kbd) to work, with the
  Mac reading the runtime's image (diskimagesiod), right as the first test's join page focuses
  the nickname: the attach focuses a field once in a session of its own (`textFieldOnce`), and
  the calm wait after the boot waits that out. The CI Mac has Spotlight off (`mdutil -a -i off`
  in `devices.yml`): its indexer was among the busiest processes around a tap whose finger stayed
  down 538 ms, a long press on the nickname field (Devices run 42715017924). Shown, Simulator.app draws the simulator's screen, and taps then took up to 2.4 s
  from finger down to up (Devices runs 41227486868, 41235159056): it is shown only to turn the
  phone, and the job records no simulator video.
- **Safari's tips on iOS:** a new simulator's Safari shows its "More" button tip (TipKit) once,
  over the first page, and a tap while it was still coming up went to its popover (release-rehearsal
  pipeline 42399897758). `setup.sh` and the suite set TipKit's own switch in Safari's defaults
  (`com.apple.TipKit.HideAllTips`, `ios.ts` `SAFARI_TIPS_OFF`; side by side the tip came up in both
  simulators without it and in none with it, Devices run 42403184245), and the `phone` fixture fails
  a test in which Safari showed a tip (`IosDevice.tipsShown`).
- **On-screen keyboard on iOS:** the iOS Simulator under safaridriver never raises it, though the
  tap reaches the field as trusted touch events and the field has focus, with or without the Mac's
  keyboard connected; and Send Keys delivers key events but inserts nothing (WebKit gives UIKit no
  field to edit: "disableAutomaticKeyboardUI" in the simulator's log; Devices runs 41173958482 to
  41180367812). The keyboard checks (what it leaves in sight) and real typing run on Android; on
  iOS the tap is checked to reach the field as a finger's, the text is put in the field as the
  keyboard would (`IosPhone.type`), and every other check runs (`Phone.onScreenKeyboard`).
- **Background on iOS:** under safaridriver the session ends as Safari leaves the screen ("invalid
  session id" from then on), so the trip to the background runs on Android (`@android`).
- **Screenshots on iOS:** `simctl io <udid> screenshot -` does not write to stdout on Xcode 26,
  though its help says so: it writes a file named `-` in the current folder, so failed tests kept
  an empty "screen". `IosDevice.screenshot` writes a file and reads it back, and fails ("screen
  (failed)") with simctl's words when there is no image.
- **Android: the address before the page.** The join page's address says `/join` as soon as
  Chrome commits it, while the head's stylesheet still holds the parser (the startup guard's
  inline script waits for it), so `document.body` can be null then (Devices run 42286829225): the
  page is touched only once Watch is enabled (`joinPageReady`).
- **Keyboard up before the tap (Chrome on Android):** Chrome raises the on-screen keyboard for a
  focus the page gives a field itself (the join page's autofocus) once the page has had a user
  gesture (Blink `Element::Focus`, sticky user activation), and on the emulator the join page has
  one before any tap: Chrome gives it as the page finishes loading (Devices run 42315128472), and
  Playwright's `page.evaluate` is one as well (`userGesture: true`). When the autofocus comes after
  it, the keyboard comes up by itself as the page opens (Devices run 42307812551), which is fine on a
  page whose only job is the nickname. So `tapToType` waits for the keyboard to be up (the system
  reports it shown, it covers at least `KEYBOARD_MIN_PX` of the page, the field has the tap and the
  focus, the page has stopped moving), never for the visible height to change across the tap.
- **Android emulator:** `-gpu swangle_indirect` (`android.ts` `EMULATOR_GPU`): with
  `swiftshader_indirect` the emulator crashed in its host renderer thread (SIGSEGV) in most runs, on
  versions 37.2.12 and 37.2.13 and on Android 15 and 16; measured side by side, `swangle_indirect`
  held. It also runs with `-feature -Vulkan,-HardwareDecoder` (`EMULATOR_FEATURES`), with
  animations off (the three `*_animation_scale` settings, as Android's guide to testing asks:
  https://developer.android.com/training/testing/espresso/setup#set-up-environment), and
  `setup.sh` pins version 37.2.12. The AVD has four cores (`hw.cpu.ncore`, the CI runner's count):
  with the default two the guest stayed CPU-bound (CPU pressure near 90 % in every ANR report), and
  in Devices run 42316622933 SystemUI did not start in time at two cold boots of the eight; its
  "isn't responding" dialog took the window focus from Chrome, so Android refused Chrome's requests
  for the keyboard while the suite's touches, which reach the page over DevTools, still focused the
  field. With four cores the 15 boots of three runs had no ANR (Devices runs 42321838235,
  42321840933, 42321843458). `keyboardOnce` brings the keyboard up once after the boot (Gboard's
  first show took 13.9 s, Devices run 41226056177) once Chrome's window has the input focus.
  CI boots the emulator the suite's way, after `setup.sh install android`, so `emulator.log` keeps
  its output and exit, and a crash leaves a core and its backtrace with the job's artifacts.
- **Time away (Android):** the phone stays in the background for whole segments of live counted
  from the first new one (`liveMovesOn`), four of them (8 to 10 s): the page must come back behind
  by more than Go live's 4 s, after the catch-up has begun, and by less than the 16 s past which
  hls.js jumps to the live point by itself. Three new segments counted from the call lasted 4 to
  6 s, and the video stands paused for less than Chrome's window is hidden (release-rehearsal run
  42382536965): the page came back only 4 s behind. Thirty trips with a record of the page
  (Devices runs 42385971521 and 42387936202) read 5.0 to 8.4 s behind when the check passed.
- **Android, design facts:** the page is served on 127.0.0.1 through `adb reverse` (10.0.2.2 is
  not a secure context, so the browser check could not run); the suite starts Chrome itself
  (Playwright's launchBrowser disables renderer backgrounding) and detaches before backgrounding
  (focus emulation keeps an attached page visible).

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

The system harnesses test the real thing on clean CI machines: the desktop installers, and the staged
server (`release/staging/<target>`, the executable the app runs as its sidecar) started by itself, with
real browsers, a synthetic OBS feed from ffmpeg, real OBS Studio, and quick tunnels opened by the
package's own cloudflared against a [local stand-in for Cloudflare](#no-third-party-service-in-the-gate).

| Harness | Runs on | Entry point (CI) |
|---|---|---|
| Windows suites: app, direct, quality, obs | Windows runners (`_windows.yml`) | `node scripts/test/windows/<suite>.mjs --staging release/staging/windows-x64 --out <file>.json` |
| Preflight: start, stream, watch, P2P, kick, stop, tunnel (local stand-in for Cloudflare) | macOS, Linux, Windows (`_desktop.yml`) | `node scripts/test/preflight/verify.mjs --staging release/staging/<target> --tunnel --chrome` |
| Real services (not a gate): the preflight through the real Cloudflare quick tunnel | Linux, daily (`real-services.yml`) | `node scripts/test/preflight/verify.mjs --staging release/staging/linux-x64 --tunnel --real-cloudflare --chrome` |
| Desktop app: installers, autostart, kill, quit, update A → B | macOS, Linux, Windows (`_desktop.yml`) | `node scripts/test/desktop/verify.mjs --installers … --update-from … --update-to …` |
| Linux in Docker: AppImage, OBS, Playwright | x64 and arm64 Linux (`_docker.yml`) | `scripts/test/docker/{appimage,obs,e2e}.sh` |

Shared pieces, one place each:
[scripts/test/lib](../scripts/test/lib) (no side effects when imported): `wait.mjs` (`until`, `poll`,
`orTimeout`, `waitForLine`), `proc.mjs` (tracked child processes, tree kills, `ownerOf`),
`ports.mjs` (`isListening`, test port blocks), `ffmpeg.mjs` (the test ffmpeg and the OBS-like feed),
`ffmpeg-stand-in.mjs` (the app's pinned ffmpeg archive served on 127.0.0.1), `pinned-archive.mjs`
(a pinned archive from CI's download cache, SHA-256 checked),
`app.mjs` (the bare-OS environment the staged server runs with, the panel login from its output, the
live link), `viewer.mjs` (join, play,
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

### No third-party service in the gate

A gating test never reaches a service on the internet at test time: a test that depends on one
fails when that service does. In the CI history from 2026-10-25 to 2026-11-07, every failure in
which the product under test reached an external service came from Cloudflare's free quick tunnel
(9 jobs, 3 more plausible): new names that did not resolve yet (`getaddrinfo ENOTFOUND
<name>.trycloudflare.com`, a 45-minute burst in 6 of 72 windows-app soak jobs and one macOS Intel
preflight), an edge that answered a working tunnel with its 530 page (gate run 42164021587), and a
quick-tunnel API that timed out (run 41283791976). So the tunnel sessions of the preflight, the
Windows app suite (sections 3-5) and the desktop test, the soak's preflight and the integration
tests open their tunnels against a local stand-in for Cloudflare,
[scripts/test/lib/cloudflare.mjs](../scripts/test/lib/cloudflare.mjs), on 127.0.0.1:

- the real cloudflared of the package (or `vendor/`) asks its quick-tunnel service for a tunnel
  (`--quick-service`) and registers with its edge (`--edge`, `--cacert`) over Cloudflare's tunnel
  protocol: TLS, HTTP/2 with the edge as the client, the control stream and its Cap'n Proto
  registration RPC ([capnp.mjs](../scripts/test/lib/capnp.mjs), the few encoding pieces it needs);
- viewers' requests and WebSockets go to `https://<name>.trycloudflare.com` on the stand-in's public
  side, which forwards them through cloudflared with the headers Cloudflare adds (CF-Connecting-IP,
  CF-Ray, X-Forwarded-Proto) and answers Cloudflare's 530 page when the tunnel has no connection;
  browsers reach it through its CONNECT proxy, which refuses every other host (`contextOptions`:
  the proxy and its certificate);
- the app takes it from `SWARMCAST_TEST_CLOUDFLARE` (`appEnv`; `apps/server/src/tunnel/stand-in.ts`,
  127.0.0.1 only): its cloudflared gets the stand-in's arguments, and its reachability checks
  (`waitForReachable`, the tunnel watch, "Stop everything") ask the stand-in's DNS-over-HTTPS and
  public side instead of 1.1.1.1 and the internet, over plain HTTP on 127.0.0.1 (the app reads no
  certificate for them; only cloudflared gets the CA). Everything else is the real code. The
  variable adds no power over the app: whoever can set the app's environment already runs code as
  its user (`SWARMCAST_BIN_DIR` picks the cloudflared it starts).

The Windows quality suite's ffmpeg install (the panel's "Install the video converter", section 1)
downloaded the pinned archive from BtbN's GitHub releases at test time, and github.com's 504s on
2026-11-08 stalled it until the step's limit (pull request #141's gate run 42474266127). It now
downloads it from a local stand-in for the publisher,
[scripts/test/lib/ffmpeg-stand-in.mjs](../scripts/test/lib/ffmpeg-stand-in.mjs), on 127.0.0.1: the
setup action (`app-ffmpeg: true`) puts the pinned archive in the download cache before the tests
(`fetch-binaries.mjs --only ffmpeg`, a set-up download with its own recoveries), the stand-in
serves that file, and the app takes its address from `SWARMCAST_TEST_FFMPEG_URL`
(`ffmpegDownloadUrl` in `apps/server/src/quality/ffmpeg.ts`, `http://127.0.0.1:<port>/<file>`
only, no redirects). The SHA-256 check, extraction and `ffmpeg -version` are the app's own, so a
wrong file still fails; the suite checks that the app asked the stand-in, once. The stand-in's
unit test (`scripts/test/test/ffmpeg-stand-in.test.ts`) also sends the headers and then nothing,
and the install fails with its stall message. `real-services.yml` installs from the real URL daily.

The Windows OBS suite (`scripts/test/windows/obs.mjs`, section 1) also downloaded its portable OBS
Studio zip from GitHub (obsproject's release) at test time. The zip is now pinned in
`versions.json` (`obs-studio`: `testOnly`, `archive`, kept whole and never extracted by
fetch-binaries), the setup action's `obs-studio` input puts it in the download cache before the
tests, and the suite reads it from there
([scripts/test/lib/pinned-archive.mjs](../scripts/test/lib/pinned-archive.mjs), SHA-256 checked),
so its test step downloads nothing. OBS is test scaffolding, not a service the app uses, so
`real-services.yml` does not cover it; a pin change downloads it again in set-up, with
fetch-binaries' recoveries. The Docker OBS suite installs Ubuntu's `obs-studio` package when its
image is built (`Dockerfile.obs`, with `build.sh`'s infra recovery): a set-up download, like
the other images' apt packages.

A bump of the pinned cloudflared (`scripts/build/versions.json`) runs `local-cloudflare.test.ts`
with the new binary in its own pull request, so a change in the tunnel protocol fails there first
(the edge answers an interface or method it does not know with an RPC exception, which
cloudflared logs); `capnp.mjs` has its own unit test (`scripts/test/test/capnp.test.ts`).

What differs from the real service: HTTP/2 instead of QUIC between cloudflared and the edge (so the
UDP-blocked fallback is not exercised here; `quick-tunnel.test.ts` covers it with an edge that
drops UDP), one edge address, a name that resolves as soon as its connection registers, and no
rate limit. `local-cloudflare.test.ts` proves the stand-in with the real cloudflared (a request and
its answer with Cloudflare's headers, a WebSocket, 530 once the connector is gone) and runs a live
of the real app through it: the live link, the tunnel watch replacing a tunnel the edge answers
with 530, and "Stop everything". The real service stays covered by `real-services.yml`: daily, the
preflight of the staged Linux server through the real Cloudflare (`--real-cloudflare`), with the
real speed test, blocklists and STUN, and the app's ffmpeg install from its publisher
(`scripts/test/quality/install-ffmpeg.ts`); never a gate, no secrets, a failure is reported in its
summary and as a warning.

Still reached by gating jobs, with no failure in that history, and why they stay: the staged
server's start-up speed test (speed.cloudflare.com) and public blocklist downloads in the system
harnesses (both in the background, failures only logged; the Windows suites judge the "upload too
low" warning only on a measured fast uplink, else record it), STUN (stun.cloudflare.com) for the
browsers' P2P candidates (the viewers find each other on loopback without it), Direct mode's public
IP lookup in the Windows direct suite (1.1.1.1/cdn-cgi/trace), and cloudflared's own lookup of its
feature flags in DNS (`cfd-features.argotunnel.com`, 10 s limit, defaults on failure). CI set-up
downloads (npm, apt, Docker images, pinned binaries, actions) are infrastructure with their own
recoveries ([above](#infra-recoveries)), not services under test.

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

### Surge bench

[scripts/test/surge/bench.ts](../scripts/test/surge/bench.ts) measures what a burst does to a live:
many people joining within a few seconds, or many turning P2P on at once
([QUALITY.md](QUALITY.md#5-many-people-at-once)). It runs the real public server in its own process,
fed by a synthetic HLS ladder ([source.ts](../scripts/test/surge/source.ts): random bytes of the
right sizes, one 2 s segment per rendition every 2 s, the 40 s window full from the start) instead of
MediaMTX, behind [tunnel.ts](../scripts/test/surge/tunnel.ts), an emulation of the quick tunnel
(200 requests in flight with WebSockets, a 60 ms round trip) and of the streamer's uplink (the cap
is 85 % of it, and the pages' scripts share it with the video). The viewers are protocol-level
players in their own processes ([viewers.ts](../scripts/test/surge/viewers.ts)): the real join
flow with the browser check and the pages' assets, `/control`, then hls.js' Stable profile (20 s
behind live, one fragment at a time, its two-EWMA ABR, 1× playback with stalls, p2p-media-loader's
3 s no-bytes abort and retries, `X-SC-Need`); "P2P on" opens the tracker channel and announces
with 5 offers, answering every offer (no media over WebRTC: Node has none). Each run is real time
(about 2.5 min per scenario), so results vary from run to run: compare several runs per variant.
Its checks are structural, never thresholds on stall counts: everyone joins, every newcomer gets a
first picture, the server closes no `/control` socket, and the attack shield does not take the
burst for an attack. The soak suite `surge` runs it.

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
| **Playwright Test** (projects, fixtures, `test.step`, `expect.poll`, reporters) | the `section`/`check` runner of `scripts/test/windows`, preflight, desktop | already a dependency; traces, HTML and JUnit reports, `expect.poll` | a worker is shut down after any failure and its module state is lost, serial mode skips the rest of the group: the Windows suites share one running app across sections and must go on after a failed one; default 30 s test timeout for 5-50 min flows; the suites' JSON feeds the Windows summary and the soak | none extra; every OS | **Not now.** Kept for the browser e2e suites. A migration would need a Windows machine to prove it (the suites only run there); the shared libraries already give the same waits, and JUnit comes from the harnesses themselves |
| **node:test** (built in: sequential by default, subtests, `todo`, `t.waitFor`, `spec`/`junit` reporters) | the same runner | zero dependencies; failures do not stop the next test and module state stays (one process), which fits sequential system tests; JUnit built in | still a rewrite of every suite's structure; the soak's Windows result format would change | none; every OS | **The candidate** for the Windows suites, preflight and the desktop test once a Windows machine can run them before and after |
| **bats-core** (TAP/JUnit formatters, `setup_file`, `run`, bats-assert) | the in-container scripts | standard runner and reports, per-test isolation | not on the runner images (npm `bats` or apt needed); each test runs in its own process, while these cases build on each other (install, then update, then a broken update…); the AppImage host is minimal on purpose (nothing the app could borrow) | a new dev dependency | **Kept as scripts**; the in-container scripts now share [lib.sh](../scripts/test/docker/lib.sh) |
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
