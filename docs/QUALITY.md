# Quality, stability and upload budget

This page records the decisions behind the quality options (1080p/720p/480p with Auto), the "Stable" and "Lower delay" playback profiles, and the automatic upload budget, with the evidence for each. Facts were checked on 2026-10-25.

## Summary of decisions

| Topic | Decision |
|---|---|
| Segment duration | Keep **2 s** segments from OBS's 2 s keyframes. Most platforms (Twitch, YouTube, Kick) also recommend 2 s, and the encoder may be shared with the stream she sends to another platform. Get stability from a bigger buffer, not longer segments. |
| Default player profile | **Stable**: starts 20 s behind live, then **adapts per viewer** between 10 s (firm network; 12 s while getting P2P segments) and 30 s (unstable network). 40 s live window, conservative ABR. |
| Optional profile | **Lower delay**: starts 8 s behind live and adapts in a narrow 6–10 s band. The viewer can switch at any time. |
| Adaptive delay (v0.2.1) | `apps/viewer/src/latency-controller.ts`: segment load times, bandwidth variance, stalls, buffer trend and HTTP vs P2P decide each viewer's target; lowering uses playbackRate ≤ 1.05 (≤ 1.1 in Lower delay), raising happens inside a stall. Bounds from `MAX_PLAYER_DELAY_S` (`packages/shared/src/playback.ts`). See [Adaptive delay](#adaptive-delay). |
| Multi-quality | **SwarmCast transcodes locally with ffmpeg**: one process copies the source and encodes 720p, 480p and 360p on the **GPU encoder**. Without one, a 3-second CPU test decides whether **one** small rendition (480p or 360p, x264 veryfast/superfast or OpenH264, one thread, below-normal priority) fits within **1 core** on a PC with ≥ 6 threads. |
| Default | **On automatically** when ffmpeg is installed and the probe finds a working hardware encoder (or the CPU test passes), with the safe renditions preselected; **off with the reason** otherwise. The streamer's explicit choice ("Stream in multiple qualities" + rendition checkboxes) is saved as `quality.ladder.mode: "manual"` and always wins on later runs. |
| CPU safety while live | The converter never takes CPU from OBS: when it falls behind real time (windowed speed < 1.0×, 0.97 with a noise margin) or the whole machine stays ≥ 90 % busy for 10 s, the most expensive rendition is dropped (30 s cool-down between drops), down to the original quality alone. The panel and the activity log say so. |
| ffmpeg distribution | **Not bundled, not redistributed.** The start scripts download the pinned build for the OS/arch from its publisher (pins published per release as `binaries.json`, SHA-256 verified) into `<data>/tools/ffmpeg/`; the panel's "Install the video converter" button is the fallback. BtbN LGPL builds for Windows and Linux, Martin Riedl builds for macOS. |
| P2P | **One swarm per rendition** (`swarmcast-<live>-main-<height>`). The tracker allowlists exactly the served heights. |
| Upload budget | **AIMD controller.** It raises the cap while the uplink is healthy and viewers want more, and cuts it by 30 % on congestion. Congestion means the ping to Cloudflare grows, or obs-websocket reports congestion or dropped frames on her main OBS output. It never goes above *measured upload × (1 − headroom) − other stream × 1.25*, where "other stream" is what she sends at the same time to another platform (Twitch, YouTube, Kick…), or 0 if none. |
| Manual override | Every automatic choice has a manual setting: rendition list and encoder, fixed upload limit, other-platform bitrate, headroom. |

## 1. Stability vs latency

### Segment duration
- **Guidance.** Apple's HLS authoring spec says target durations *SHOULD be 6 s*, keyframes every 2 s, and at least 6 segments in a live playlist ([Apple HLS authoring spec](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)). Wowza reports the fewest rebuffers at 10 s, with quality "beginning to degrade" at 4 s and 2 s being the most disruptive ([Wowza](https://www.wowza.com/docs/how-to-reduce-latency-in-apple-hls-stream-targets)). Bitmovin recommends 2–4 s with persistent connections ([Bitmovin](https://bitmovin.com/blog/mpeg-dash-hls-segment-length/)).
- **Why longer segments help.** Fewer requests, and a bigger buffer for the same number of segments behind live. Both effects come from the buffer, not from the segment length itself.
- **Why we keep 2 s.**
  - Our segment length is fixed by OBS's keyframe interval, which most platforms (Twitch, YouTube, Kick) recommend at 2 s. When the multistream plugin reuses the encoder of her stream to another platform, we cannot change it without touching that stream.
  - The tunnel limits requests *in flight* (200, open WebSockets included; measured, see [ARCHITECTURE.md](ARCHITECTURE.md#quick-tunnel-limit-measured-2026-10-26)), not the request rate. A playlist request is in flight for one round trip, so 0.5 extra req/s per viewer adds about 0.1 in flight. What fills the tunnel is one open WebSocket per viewer plus segment downloads that peers did not serve.
  - 2 s segments let the player sit at any multiple of 2 s behind live, and let peers trade smaller pieces.
- **What we change instead.**
  - The player waits **20 s** behind live (10 segments) instead of 14 s. Since v0.2.1 that is where it starts: the [adaptive delay](#adaptive-delay) then moves each viewer between 10 and 30 s.
  - The playlist window viewers see is **40 s in every playlist** (`PLAYLIST_WINDOW_S` in packages/shared): the furthest a player sits behind live (Stable's `liveMaxLatencyDuration`, 36 s) plus 2 segments to fetch the oldest one. MediaMTX and the ladder list that many 2 s segments, and the origin's stitcher keeps every playlist at that many seconds from its actual segment durations: the ladder cuts its shared audio rendition every second, so the audio playlist keeps 40 entries (with a fixed count of 20 it held only 20 s, and a player 20 s behind live sat on the oldest audio segment). Change a profile delay and the windows follow (a unit test checks the invariant).
  - The player fits its delay into the shortest playlist it uses (video or audio): `liveMaxLatencyDuration` ≤ window − 2 target durations and `liveSyncDuration` ≤ that − 2 target durations, so with an older server whose audio playlist holds 20 s, Stable plays at most about 12 s behind live instead of freezing (that fit is the adaptive delay's ceiling).

### hls.js settings
hls.js 1.7.3 defaults are from `src/config.ts`. `apps/viewer/src/player-config.ts` holds both profiles. The table shows the main values.

| Setting | hls.js default | Before (watch.ts) | **Stable** | Lower delay | Why |
|---|---|---|---|---|---|
| `lowLatencyMode` | true | false | false | false | No LL-HLS: partial segments cannot go over P2P, and quick tunnels add RTT to every part. |
| `liveSyncDuration` | 3 × TD | 7 × 2 s = 14 s | **20 s** | 8 s | Distance behind live, which is the most buffer the player can ever hold. |
| `liveMaxLatencyDuration` | ∞ | 12 × 2 s = 24 s | **36 s** | 20 s | Past this, hls.js jumps back to live. Must stay below the 40 s window. |
| `maxLiveSyncPlaybackRate` | 1 | 1 | **1.05** | 1.1 | Highest catch-up rate. hls.js itself only uses it with `lowLatencyMode`, so before v0.2.1 it did nothing; the [adaptive delay](#adaptive-delay) controller now drives playbackRate with these limits. |
| `maxBufferLength` / `maxMaxBufferLength` | 30 / 600 | 20 / 30 | 30 / 40 | 12 / 20 | Never the limit in Stable: the live edge is. |
| `backBufferLength` | ∞ | 10 | 10 (6 on mobile) | 6 | MSE memory on phones. |
| `abrEwmaDefaultEstimate` | 500 kbps | default | saved estimate, else **2 Mbps** | same | Start near the right rendition. Saved on `pagehide`. |
| `abrBandWidthFactor` / `UpFactor` | 0.95 / 0.7 | default | **0.8 / 0.6** | 0.9 / 0.7 | Switch up late and down early: fewer oscillations, fewer stalls. |
| `abrEwmaFastLive` / `SlowLive` | 3 / 9 | default | 4 / 12 | 3 / 9 | Smoother bandwidth estimate on jittery mobile links. |
| `capLevelToPlayerSize`, `maxDevicePixelRatio` | false, ∞ | false | **true, 2** | true, 2 | No 1080p into a phone-sized player. Saves the viewer's data and our upload. |
| `capLevelOnFPSDrop` | false | false | true | true | Weak devices drop to a smaller rendition. |
| `maxBufferHole` / `nudgeMaxRetry` | 0.1 / 3 | default | **0.5 / 5** | same | Jump the small gaps at a restart (discontinuity) instead of stalling. |
| `startFragPrefetch` | false | false | true | true | Slightly faster first frame. |
| Retry policies | — | custom (429 back-off) | same | same | Unchanged: they already handle the tunnel's 429. |

### p2p-media-loader windows
- **`highDemandTimeWindow`** (default 15 s, before 6 s): Stable uses **8 s** and Lower delay 4 s. Segments closer than this to the playhead always come over HTTPS. In Stable that leaves about 12 s (20 − 8) in which a peer can supply a segment first. Before, it was about 8 s (14 − 6).
- **HTTP and P2P windows:** `httpDownloadTimeWindow` and `p2pDownloadTimeWindow` keep their defaults. Shrinking the HTTP window raises the P2P share, but it also makes hls.js wait on peers, which is the opposite of "stutter less".
- **Swarm ids:** before this change the viewer used one swarm id per stream type (`swarmcast-<id>-main`). With several renditions, p2p-media-loader 4.0 refuses to register two streams with the same id (`onStreamRegistrationError`). Without per-variant swarms, peers would also trade 720p bytes for 1080p requests, which would fail validation and look like an attack. So the id now includes the height (`variantStreamSwarmId`), and the tracker allowlists each served height (`TrackerService.setVariants`).

### Adaptive delay
Since v0.2.1 the delay behind live is no longer fixed per profile: each viewer's player adapts its own target to its connection. Pure decision code in `apps/viewer/src/latency-controller.ts` (unit tests: `apps/viewer/test/unit/latency-controller.test.ts`), wiring in `apps/viewer/src/adaptive-delay.ts`, a few hook lines in `watch.ts`.

**Bounds** (`ADAPTIVE_DELAY` in `packages/shared/src/playback.ts`). `MAX_PLAYER_DELAY_S` (`constants.ts`, 36 s) is the furthest a player ever sits behind live (hls.js jumps back past `liveMaxLatencyDuration`, 36 s in Stable), and `PLAYLIST_WINDOW_S` (40 s) covers it with two segments of margin. The highest adaptive target is `MAX_PLAYER_DELAY_S` − 6 s headroom (one long stall), capped at 30 s; with hls.js' stall increase it stays below 36 s (unit tested). So the delay can never outgrow the server's playlist window. The playlists actually served limit it too, with the `latencyFor` rule (target ≤ min(36, window − 2 TD) − 2 TD): an audio playlist shorter than the video one (an older server: 20 s caps it at 12 s) caps the target itself (`setCeiling`); the shortest playlist in use (a stream that just started, a server keeping fewer segments) only stops the controller building delay past it (no slow-down, no hold; `setGrowthLimit`), without pulling the playhead closer to live: such a window grows by itself. What hls.js syncs to (`hls.targetLatency`: the start position, "Go live", the stall watchdog's restarts) is the target capped by that window too (`syncTarget`), so a restart never lands on the oldest segment, about to leave the playlist. The controller, the status line and the panel all read one delay: the median of the last 5 one-second `hls.latency` samples (hls.js computes it from the wall clock, so a clock step shows a 1–2 s spike). Neither changes the network's own target, so the delay goes back to it once the playlists have grown. The adaptive delay owns `liveSyncDuration`; the window fit only sets `liveMaxLatencyDuration`. The controller's deliberate hold neither starts nor resets the stall watchdog (`stall-recovery.ts`): held time counts as the stall it extends, so a player that is really stuck is recovered on schedule, and there is at most one hold a minute (a freeze that keeps coming back, e.g. while the watchdog restarts loading, is not extended again and again).

| Profile | Start | Firm network | Firm, P2P segments in the last 2 min | Unstable network | Max catch-up rate |
|---|---|---|---|---|---|
| Stable | 20 s | 10 s | 12 s | 30 s | 1.05× |
| Lower delay | 8 s | 6 s | 6 s | 10 s | 1.1× |

**Inputs** (one tick per second, statistics over the last 60 s):
- **Segment load time / segment duration** (hls.js `FRAG_LOADED`; for segments p2p-media-loader fetched ahead, its own download time from `onSegmentStart` → `onSegmentLoaded`). Only HTTP segments count: a slow peer says nothing about the viewer's own link, and the urgent ones always come over HTTP anyway.
- **Bandwidth headroom** = hls.js bandwidth estimate / bitrate of the rendition playing (from the playlist, else measured from segment sizes), capped at 4× before its coefficient of variation is computed (on a fast link a jittery 50–500 Mbps estimate is still "plenty").
- **Stalls**: `waiting` events after the first frame, not caused by a seek or a pause, and their length. Only when the media ran out: a `waiting` with 1 s or more buffered ahead (`STARVED_BELOW_S`) is the browser's decoder or renderer falling behind on a busy machine, which neither a hold nor a longer delay helps (Chrome on the 3-vCPU macOS CI runners: each such hiccup became the full 3 s hold).
- **Buffer trend**: least-squares slope, over 30 s, of the gap between the end of the buffer and the live edge (hls.js' live edge estimate minus the buffer end, both read the same second; the median of the last 5 readings, so a clock step or a reload that lists a segment not buffered yet is not a trend). It grows when downloads fall behind the live edge, and does not move when playbackRate changes. (It used to be the median delay minus the buffer of the current second: that median trails the playhead, so catching up and a reload listing two segments at once read as a growing gap.)
- **HTTP vs P2P**: p2p-media-loader's `downloadSource` per segment.

**Network state, with hysteresis**:
| State | Enter when | Leave when |
|---|---|---|
| Firm | for 20 s: median load ratio ≤ 0.35 and p90 ≤ 0.6 (≥ 4 HTTP segments; with fewer, ≥ 50 % from peers), headroom ≥ 2× with CoV ≤ 0.2, buffer trend ≤ +0.05 s/s, no stall for 2 min | for 5 s: median > 0.5, p90 > 0.8, CoV > 0.3, headroom < 1.5× or trend > +0.1 s/s; at once on a stall |
| Unstable | for 5 s: p90 load ratio ≥ 0.9 or median ≥ 0.6, CoV ≥ 0.35, headroom < 1.2× or trend ≥ +0.15 s/s; at once on a stall | 30 s without any of these and without a stall |
| Steady | otherwise | |

**Behaviour**:
- **Firm**: the target drifts down by 0.04 s per second (Lower delay 0.02), so 20 → 15 s takes about 2 min and → 10 s about 4 min, and never more than 3 s (2 s) below the current delay, so playback can always follow it. Playback catches up at 1.025× within 2 s of the target and 1.05× further away (Lower delay 1.05× / 1.1×), only with ≥ 4 s buffered (2 s), and stops 0.25 s from the target. Never a seek.
- **Unstable**: the target rises by 0.1 s per second (0.05) while the signals stay bad, and playback slows to 0.95× (pitch preserved) until the delay reaches it. It never speeds up while unstable, unless the delay is above the upper bound.
- **Stall**: the target rises at once by 3 s (Lower delay 1.5 s), × 2 or × 3 with recent stalls (5 min memory, long stalls count more). Playback is already frozen, so the player keeps it frozen up to 4 s (2 s) longer to reach the new target in the same freeze instead of stalling again later; the hold never goes past the upper bound (the playlist window). If the stall itself lasted longer, nothing is added: the delay it caused just sticks (the target becomes at least the delay after the stall). No lowering for 2 min after a stall.
- **Far behind after a pause**: the target does not fall while the delay is more than 3 s (2 s) above it, playback catches up at 1.05× (1.1×), and the target resumes its drift once the delay is close. A pause longer than `liveMaxLatencyDuration` makes hls.js jump back as before. "Go live" seeks to hls.js' `liveSyncPosition`, which uses the adaptive target.
- **Profile switch** starts over at the profile's start delay. If the viewer picks a speed in the browser's own controls, the controller leaves playbackRate alone until it is back to 1×.
- **Lower delay adapts too, in a narrow band.** We chose 6–10 s over a fixed 8 s: the same code path for both profiles; ±2 s is what hls.js' own `liveSyncOnStallIncrease` already allowed (up to one target duration); a viewer who asked for less delay gets 6 s on a firm network, and on an unstable one 10 s cuts the stalls that 8 s showed on 4G with dropouts (table in section 4), while staying well below Stable.
- **What the viewer sees**: "~14 s behind live" next to the status, with a tooltip saying it adjusts itself to the connection. The player reports the rounded delay in its 5 s stats message, and the panel's viewers table shows it (**Delay** column).
- **Tests**: unit scenarios (steady fast network, oscillating 4G, single, long and repeated stalls, P2P-heavy, bounds fuzz, buffer trend, hysteresis) and `apps/server/test/e2e/adaptive-delay.spec.ts` (Chromium + WebKit; Chromium with CDP throttling). `?delaySpeed=10` on the watch page runs the controller's dwell times, quiet period and drift rates 10× faster for tests, and `?delayRate=10` moves playbackRate up to 10× further from 1 (at most ±0.5). Both are ignored unless the server runs with `SWARMCAST_TEST_HOOKS=1` (the E2E harness sets it), so a link with them changes nothing for real viewers.

## 2. Multi-quality options

### a. OBS sends the renditions itself (Enhanced RTMP multitrack): rejected
- **Custom servers.** OBS 30.2 added Multitrack Video ("Enhanced Broadcasting" on Twitch). Custom RTMP servers can use it without a hidden launch flag only since **OBS 32.0.1** ([PR #12665](https://github.com/obsproject/obs-studio/pull/12665)), with a JSON config override limited to the Custom service since 32.2.0 ([PR #13487](https://github.com/obsproject/obs-studio/pull/13487)).
- **It only runs on the main Stream output.** `obs_frontend_get_streaming_output()` returns the multitrack output in place of the stream output (frontend `OBSStudioAPI.cpp`). When she also streams to another platform, that output carries that stream, so it can be multitrack to that platform *or* to SwarmCast, never both. The Aitum Multistream and Multiple RTMP outputs plugins each send exactly one video track.
- **MediaMTX v1.21.3** ingests every E-RTMP track (gortmplib v1.0.5 `reader.go`, `internal/protocols/rtmp/to_stream.go`). But its HLS muxer serves only one video track: gohlslib v2.4.7 `muxer.go` returns "only one video track is currently supported" ([gohlslib #361](https://github.com/bluenviron/gohlslib/issues/361)). Multitrack ingest would still need a remuxer.
- **Possible future zero-CPU path, not tested.** She keeps Enhanced Broadcasting (multitrack, e.g. on Twitch) on the main output to her other platform, and Aitum outputs reuse its encoders by index (`VideoEncoderIndex`, `obs_output_get_video_encoder2`), one Aitum output per rendition to MediaMTX. That platform's server would then decide the ladder.

### b. SwarmCast transcodes with ffmpeg: chosen
- **One process (`apps/server/src/quality/transcoder.ts`).**
  - It reads `rtmp://127.0.0.1/live/<key>` from MediaMTX.
  - It **copies** the source as the top rendition: no generation loss, no CPU.
  - It encodes 720p, 480p and 360p (auto mode with a GPU encoder) with keyframes forced where the source has them (`-force_key_frames source`), and copies the audio once into a shared audio rendition.
  - It writes fMP4 HLS (`-var_stream_map`, `temp_file`) into a private run directory, deleted on Stop.
  - One muxer means every rendition shares one timeline and the same program date-times, so switching is seamless.
- **Encoders.**
  - Preference order: `h264_nvenc`, `h264_videotoolbox`, `h264_qsv`, `h264_amf`, `h264_vaapi`, then `libx264` (`threads=2`) and `libopenh264`.
  - Each is probed once per app run with a 1-second 720p30 test encode (`encoders.ts`). A hardware encoder that is compiled in but has no device fails the probe and is skipped.
  - On this M5 Max: VideoToolbox works, and x264 does 177 fps in the probe (an 18-core CPU).
- **CPU safety.**
  - ffmpeg runs at below-normal priority (`os.setPriority`), so OBS always wins.
  - With a hardware encoder (NVENC, Quick Sync, AMF, VideoToolbox, VA-API), auto mode adds 720p, 480p and 360p. The probe runs with `-benchmark`, so the panel shows the CPU cost (decode-like work + scaling) as "about N % of your CPU".
  - **No hardware encoder (CPU fallback, `testCpu` in `encoders.ts`, `decideSoftware` in `packages/shared/src/quality.ts`).** Only on PCs with ≥ 6 hardware threads. Short test encodes of a 1080p30 pattern scaled to one low rendition, one encoder thread, below-normal priority, 3 s of video each, in this order: 480p x264 veryfast, 480p x264 superfast, 360p x264 superfast (OpenH264: 480p, 360p; the BtbN LGPL builds for Windows/Linux have no x264). A test passes when it ran **≥ 1.5× real time** and needs **≤ 1 core** at real time after a 1.3× margin (real content is harder than the test pattern, and the source must be decoded). The first passing test becomes the one rendition auto mode offers. Otherwise the panel explains in plain words why (too few threads, or how many cores it would need) and that viewers still get the Stable buffer.
  - **While live (`load-guard.ts`).** Every 2 s the manager checks the converter's speed over a sliding 10 s window (from `out_time_us`; ffmpeg's own `speed=` is an average since the start) and whole-machine CPU from `os.cpus()` deltas (works on every OS). Falling behind (< 0.97×) for 10 s, or ≥ 90 % busy for 10 s, drops the largest encoded rendition by restarting ffmpeg with the rest (viewers on it reload the multivariant playlist through `createManifestReloader`); the last one drops back to the plain MediaMTX stream. One drop per 30 s. The renditions come back when OBS reconnects.
  - The probe ran at launch, maybe before OBS and the game started; that is why the live protection exists.
- **Lifecycle.**
  - ffmpeg is a `ManagedChild` registered with the reaper and restarted with back-off (up to 5 times).
  - If the ladder has not produced segments 20 s after OBS connects, viewers get the plain MediaMTX stream (fallback).
  - "Stop everything" verifies the ffmpeg pid is gone and deletes its files (integration test).
- **Upload cost.** A rendition costs upload only while someone watches it, because the origin serves on demand. Lower renditions *reduce* upload per viewer: a 480p viewer costs about 1.5 Mbps and a 360p viewer about 0.9 Mbps, instead of about 6.5.
  - When the global cap is reached, every viewer's throughput drops, and hls.js ABR moves them to lower renditions. Total demand falls, so the cap and ABR settle together.
  - P2P swarms split per rendition. With `capLevelToPlayerSize` and the conservative ABR, most viewers converge on one or two renditions.

**Licensing.**
- FFmpeg is LGPL-2.1+ by default, and GPL as a whole when built with GPL parts such as libx264 ([ffmpeg.org/legal](https://ffmpeg.org/legal.html)). A separate executable started as a child process is "mere aggregation" ([GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)), so SwarmCast stays MIT either way.
- Whoever **distributes** an ffmpeg binary must ship its license and the complete corresponding source. BtbN's and Riedl's archives do not include a source bundle, so we would have to assemble and host it.
- SwarmCast therefore **does not ship ffmpeg**. The user's own computer downloads it straight from the publisher, with SHA-256 verified: the start scripts do it right after installing SwarmCast (from `binaries.json`, a release asset generated from `scripts/build/versions.json` and listed in `SHA256SUMS.txt`; the installer zips include it and download ffmpeg online when they can), and the panel's "Install the video converter" button does the same as a fallback. Both install into `<data>/tools/ffmpeg/` (outside `app/`, so updates keep it; a `PIN` file triggers a new download only when the pin changes). The app finds it there by default (`SWARMCAST_FFMPEG` and `ffmpegPath` override it). The exact pins are in `scripts/build/versions.json` (`"bundle": false`; `fetch-binaries.mjs --with-ffmpeg` bundles them for a packager who accepts the obligations).
- CI exception: the two macOS archives are slow to download from GitHub's runners, so byte-identical copies sit in this repository's `ci-deps` pre-release (with the GPL-3.0 license and the complete Corresponding Source: every component at its exact version plus the build script, listed in `SOURCES.md`) and `fetch-binaries.mjs` tries them first (`"mirrors"` in `versions.json`, SHA-256 verified like any download). Users never download from it: `binaries.json` and the app use the publisher URLs. See [RELEASING.md](RELEASING.md), "Mirrored CI dependencies".

| Target | Build | License | SHA-256 (verified by download) |
|---|---|---|---|
| windows-x64 | [BtbN autobuild-2026-09-30-13-08 `ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-9.0.zip`](https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-9.0.zip) | LGPL-3.0+ (`--enable-version3`), nvenc/qsv/amf/vaapi/openh264, no x264 | `6b264b9e…fe63432` |
| linux-x64 | same release, `…-linux64-lgpl-9.0.tar.xz` | LGPL-3.0+ | `2d41cbea…705350a` |
| linux-arm64 | same release, `…-linuxarm64-lgpl-9.0.tar.xz` | LGPL-3.0+ (no qsv) | `b8cc0920…475ce37` |
| macos-arm64 | [Martin Riedl 9.0.2 `ffmpeg.zip`](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip) (notarized) | GPL-3.0+ (has x264) | `c8ed4c4e…492d924` |
| macos-x64 | [Martin Riedl 9.0.2 `ffmpeg.zip`](https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip) | GPL-3.0+ | `7c6b4125…cacd4` |

- **Build choice.**
  - BtbN month-end builds are kept for 2 years. Daily builds disappear after 14 days, so we pin month-end builds.
  - No reputable LGPL macOS build exists. If SwarmCast ever wants to *bundle* ffmpeg on macOS, the clean option is an LGPL, VideoToolbox-only build from `ffmpeg-9.0.2.tar.xz` (sha256 `8c385028…a96e002e`) made in our own CI, with `h264_videotoolbox -allow_sw 1` as the software fallback (Apple's own encoder).
- **Patents (not legal advice).** Every ffmpeg build contains an H.264 decoder. With hardware encoders the encoder is the OS's or GPU vendor's licensed implementation. Cisco's OpenH264 patent coverage applies only to Cisco's own binary downloaded separately, not to a statically linked libopenh264.

### c. MediaMTX `runOnReady`: rejected
- **Lifecycle.** `runOnReady` (now an alias of `runOnAvailable`) starts the command in its own process group (`Setpgid`) and stops it with SIGINT, with no SIGKILL escalation. If MediaMTX itself is SIGKILLed, the command keeps running, out of our reaper's reach (`internal/externalcmd/cmd_os_other.go`).
- **Muxers and timelines.** Publishing renditions back to new MediaMTX paths gives one HLS muxer per path, each with its own timeline and segment boundaries. hls.js would then switch across unaligned timelines.
- **Our approach instead.** One ffmpeg process that we manage keeps the reaper guarantees and produces aligned renditions.

## 3. Automatic upload budget

### Ceiling
`computeUploadCeiling` = measured upload × (1 − headroom, default 15 %) − other-stream bitrate × 1.25. The 1.25 factor covers x264 CBR bursts plus RTMP/TCP overhead.

The other-stream bitrate (what she sends to another platform at the same time) comes from the first available source:
1. Her manual value.
2. obs-websocket's `outputBytes` rate.
3. The bitrate OBS sends to SwarmCast, when "also streaming elsewhere" is on (usually the same encoder), or 6 Mbps before OBS connects.
4. Otherwise 0: she streams only to SwarmCast.

The speed test runs at launch and every 15 min while off. If no test exists, her manual limit is the absolute maximum, and only the congestion signals protect the uplink.

### Congestion signals (`apps/server/src/quality/signals.ts`)
1. **Queueing delay on the uplink** (always on).
   - Every 2 s, the RTT of a TCP handshake to `1.1.1.1:443`, which is Cloudflare's nearest anycast PoP, the same network as the tunnel.
   - Baseline = minimum over 5 min; current = minimum of the last 2 samples; congested when current − baseline > max(50 ms, baseline). This is the LEDBAT/BBR idea: a saturated uplink fills the router buffer and every packet waits.
   - Limitation: routers with fq_codel or CAKE keep the delay low and drop our packets instead. Fair queuing then already protects her other stream.
2. **obs-websocket `GetStreamStatus`** (opt-in, loopback only, password stored in the private config).
   - Congested when `outputCongestion` > 0.15, when dropped frames (`outputSkippedFrames` / `outputTotalFrames` delta, OBS's own "dropped frames (network)" formula) exceed 0.5 %, or when `outputReconnecting` is set ([protocol.md](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)).
   - This is the only direct view of her main OBS output (her stream to another platform, if any). The local OBS→MediaMTX RTMP runs over loopback and never shows uplink congestion.
3. **Demand.** The limiter records when a request had to wait for tokens. The cap only grows when it is the bottleneck. In direct mode, socket send queues would be another signal; behind the tunnel, Node's sockets go to cloudflared over loopback and say nothing about the uplink.

### Controller (`upload-controller.ts`)
- **Start:** 60 % of the ceiling.
- **Every 2 s:**
  - On congestion, the cap becomes 0.7 × min(cap, actually sent), followed by a 10 s hold.
  - When healthy and demand-limited, it grows by 5 % of the cap (at most 4 % of the ceiling, at least 0.25 Mbps), and by a quarter of that near the last cap that caused congestion.
  - When nobody needs more, the cap holds (no untested growth).
- **Bounds:** never above the ceiling, never below 1 Mbps.
- **Manual mode** pins the limiter to her "upload limit".
- **Unit tests** cover these simulated links and run in CI: `apps/server/test/unit/upload-controller.test.ts` and `quality-signals.test.ts`, the latter with a fake obs-websocket server. To reproduce the table: `node --import tsx scripts/test/quality/simulate-controller.ts`.

| Scenario | Free uplink (Mbps) | Avg cap, 2nd half | Max cap | Time with queue > 100 ms | Backoffs (30 min) |
|---|---|---|---|---|---|
| 20 Mbps up, other stream 6, no speed test, RTT only | 13.4 | 11.8 (88 %) | 14.0 | 5.1 % | 45 |
| 20 Mbps up, other stream 6, OBS congestion only | 13.4 | 11.8 (88 %) | 14.0 | 5.1 % | 43 |
| 20 Mbps up, other stream 6, speed test (ceiling 11.5) | 13.4 | 11.5 (86 %) | 11.5 | 0.0 % | 0 |
| 10 Mbps up, other stream 6, RTT only | 3.7 | 3.3 (89 %) | 4.0 | 8.9 % | 70 |
| 100 Mbps up, other stream 8, speed test (ceiling 75) | 89.0 | 75.0 (84 %) | 75.0 | 0.0 % | 0 |

Simulated uplink, 30 min per scenario. The queue grows when SwarmCast + the other stream exceed 97 % of capacity. "Free uplink" = capacity × 0.97 − other stream. Without a speed test the controller probes the link (a sawtooth that briefly fills the router queue about every 40 s, 5–9 % of the time). With a speed test the ceiling keeps it below the knee and it never backs off. That is why the speed test before going live matters, and obs-websocket gives the earliest warning.

## 4. Measurements

### Setup
- **Server:** `scripts/test/quality/server.ts` on ports 16080/16081/16888/16935 (`FIXED_PORTS.quality` in `scripts/test/lib/ports.mjs`). A synthetic 1080p30 6 Mbps CBR stream (x264, 2 s GOP) goes into MediaMTX, and the ffmpeg ladder (VideoToolbox) produces 1080p copy + 720p 3 Mbps + 480p 1.4 Mbps.
- **Client:** `scripts/test/quality/bench.ts` runs Google Chrome under CDP `Network.emulateNetworkConditions`, with all 4 configurations side by side on each network for 2.5 min, after a 40 s playlist window had built up.
- **Configurations:** "before" = the current watch.ts settings, pinned to the source, since there was no ladder before. "stable-source" isolates the effect of the buffer profile.
- **Metrics:** stalls = `waiting` events after the first frame. Latency to edge = `hls.latency`. Wall-clock latency = now − `hls.playingDate` (program date-time from the muxer, which includes segmenting).

Each cell shows **stalls (seconds stalled)**, then startup time and wall-clock latency. Rounds 2 and 3 ran with the final ladder (1080p copy + 720p + 480p + 360p). Round 1 (5G, 4G) had no 360p, which does not matter on those links: nothing went below 720p.

| Network (Chrome emulation) | Before: watch.ts, source only | Stable, source only | **Stable + ladder (new default)** | Lower delay + ladder |
|---|---|---|---|---|
| 5G-ish 50 Mbps / 40 ms | 0 (0 s) · 0.9 s · 15.3 s | 0 (0 s) · 0.8 s · 21.3 s | **0 (0 s) · 0.7 s · 19.4 s** (720p) | 0 (0 s) · 0.8 s · 7.4 s |
| 4G 9 Mbps / 170 ms | 0 (0 s) · 2.6 s · 17.0 s | 0 (0 s) · 2.6 s · 23.0 s | **0 (0 s) · 1.5 s · 19.9 s** (720p) | 0 (0 s) · 1.5 s · 7.9 s |
| 4G 9 Mbps, offline 10 s every 60 s | 0 (0 s) · 2.7 s · 16.5 s | 0 (0 s) · 2.6 s · 22.5 s | **0 (0 s) · 1.5 s · 19.4 s** | 3 (4.0 s) · 1.5 s · 10.2 s |
| 4G 9 Mbps, offline 15 s every 60 s | 5 (8.9 s) · 2.5 s · 20.3 s | 3 (5.2 s) · 2.7 s · 25.0 s | **0 (0 s) · 1.9 s · 20.5 s** | 1 (8.2 s) · 1.8 s · 14.6 s |
| 4G fluctuating 1.5–9 Mbps / 100–300 ms, 1 % loss | 7 (10.8 s) · 5.2 s · 20.8 s | 4 (10.4 s) · 5.2 s · 34.0 s | **0 (0 s) · 2.5 s · 21.8 s** (480p 89 %, 360p 11 %) | 0 (0 s) · 2.5 s · 9.8 s (720p 42 %) |
| Fast 3G 1.44 Mbps / 562 ms | 14 (142 s, 85 % of the time) · 11.8 s · 21.0 s | 11 (147 s) · 11.8 s · 30.5 s | **1 (0.9 s) · 5.5 s · 24.5 s** (360p) | 1 (0.9 s) · 5.4 s · 12.5 s |

Raw output, including latency to the edge, the share of time per rendition and level switches: `test-results/quality/results-*.json`. To reproduce: `node --import tsx scripts/test/quality/server.ts`, then `node --import tsx scripts/test/quality/bench.ts --minutes 3`.

**What the numbers say**
- **The ladder is the big win.** On any link whose average throughput is below the source bitrate (fluctuating 4G, 3G), no buffer can help. Source-only playback stalls 7–14 times in 2.5–3 min, and 85 % of the time on 3G. With the ladder and Auto: zero stalls on fluctuating 4G, and one 0.9 s stall on 3G (startup only). Before the 360p rung was added (round 1), 3G still stalled 13 times (20 s), which is why auto mode now includes 360p.
- **The Stable buffer rides out outages.** With 15 s dropouts every minute, the old 14 s target stalled 5 times. Stable + ladder never stalled, and Lower delay stalled once for 8 s. Stable *without* the ladder still stalled 3 times: after each outage, refilling 6.5 Mbps over a 9 Mbps link takes longer than the 45 s until the next one.
- **Startup is faster with the ladder** (0.7–2.5 s vs 0.9–5.2 s, and 5.5 s vs 11.8 s on 3G). hls.js starts on a rendition that fits the first estimate (2 Mbps, or the saved one) instead of the 6 Mbps source.
- **Latency.** Stable sits about 20 s behind live (wall clock, including segmenting), which is +5 s over before. Lower delay sits at 8–12 s. Without the ladder, latency drifts up after stalls (34 s on fluctuating 4G). With it, latency stays at the target.
- **720p rather than 1080p on fast links.** That comes from `capLevelToPlayerSize`: the bench player is 1280×720 CSS px at DPR 1. On a Retina screen (DPR 2) or in fullscreen, hls.js lifts the cap and picks 1080p. On a phone it saves the viewer's data and our upload.
- **Packet loss.** Chrome accepted CDP's `packetLoss` parameter (1 %) for the fluctuating profile. CDP emulation shapes at the request level, not at the TCP level, so real-network jitter and loss can be harsher than this.

## 5. Not verified
- Hardware encoders other than VideoToolbox (NVENC, QSV, AMF, VAAPI): argument sets follow the ffmpeg docs but were not run here. The probe will mark them as not working if they fail.
- The obs-websocket client against a real OBS: it was tested against a protocol-faithful fake server, and the auth vector matches protocol.md.
- RTT-based congestion detection on a real saturated home uplink: only simulated.
- The panel's ffmpeg installer (`quality/ffmpeg.ts`) and the start scripts' ffmpeg step have not downloaded the real third-party archives end to end on any OS (the installer tests use a fake archive served locally; `scripts/test/preflight/verify.mjs` checks the real download when the release directory has `binaries.json`). All five archive hashes were verified by download during research. Extraction relies on `tar -xf`: bsdtar on macOS and Windows 10+ (zip), GNU tar + xz on Linux (`.tar.xz`); the Windows script uses .NET's ZipFile. The E2E and integration tests used the Homebrew ffmpeg 9.0.1.
- The CPU fallback thresholds (≥ 6 threads, ≥ 1.5×, ≤ 1 core after a 1.3× margin) and the live protection (0.97×, 90 % CPU, 10 s, 30 s cool-down) come from reasoning and unit tests, not from measurements on weak PCs: this M5 Max has VideoToolbox, so the CPU fallback never runs here.
- Tunnel behaviour: the bench ran against the local server, without the Cloudflare quick tunnel. The tunnel's concurrency limit itself was measured with a synthetic load (200 in flight, WebSockets included; `scripts/test/tunnel-limit/`, [ARCHITECTURE.md](ARCHITECTURE.md#quick-tunnel-limit-measured-2026-10-26)), but not the number of video requests real viewers keep in flight.
- P2P share per rendition with real viewers.
