#!/usr/bin/env bash
# Turns the Screen Time agent off for the runner's user before Playwright's WebKit runs (macOS
# jobs only; never run it on a person's computer: it disables a launchd agent of the user).
#
# Why: WebKit builds for macOS 26 have Screen Time on (ENABLE_SCREEN_TIME, WebKit 320705@main;
# Playwright's WebKit 2370 and later). Once a page shows an http(s) address, its WKWebView starts a
# WKScreenTimeConfigurationObserver, which key-value-observes "configuration.enforcesChildRestrictions"
# of an STScreenTimeConfigurationObserver; that one asks com.apple.ScreenTimeAgent and sets its
# `configuration` on a background queue a few ms later (macOS runner, unified log: the agent asked
# 10-80 ms after the commit, the configuration in 3-18 ms). A web view freed right then (a page
# closed just after its first commit, as first-goto.spec.ts does a hundred times per engine) removes
# its observer on the main thread while the set is half done, and Foundation throws
# NSInternalInconsistencyException ("Cannot remove an observer <WKScreenTimeConfigurationObserver>
# ... most likely because the value for the key "configuration" has changed"): the browser aborts
# and the test reads "Target page, context or browser has been closed" (release rehearsal
# 44565310409). WebKit main still removes that observer unguarded (WKScreenTimeConfigurationObserver
# stopObserving; bug 303024's fix only serialized the sets), Playwright 1.65's WebKit 2388 too.
# Safari never runs this code (WebKit turns Screen Time off for Safari), and nothing outside
# Playwright's app reaches the switch: ScreenTimeEnabled is an internal preference, not read from
# user defaults, and not among the settings of Playwright's protocol.
#
# With the agent off, launchd refuses the lookup, the observer logs "Failed to retrieve Screen Time
# configuration" and never sets a configuration, so nothing can change under the removal (measured
# on macos-latest: no configuration for any page; 2,500 pages closed right after their commit, no
# abort). The step checks that the agent is really gone, and fails otherwise.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "::error::screen-time-off.sh is for macOS runners"; exit 1; }
[ "${CI:-}" = true ] || { echo "::error::screen-time-off.sh changes the user's launchd agents: CI only"; exit 1; }

service="gui/$(id -u)/com.apple.ScreenTimeAgent"
launchctl disable "$service"
# bootout stops a loaded agent; it fails when the agent is not loaded, which is the state we want.
launchctl bootout "$service" 2>/dev/null || true

if launchctl print "$service" >/dev/null 2>&1; then
  echo "::error::$service is still loaded"; launchctl print "$service" | head -20; exit 1
fi
if pgrep -x ScreenTimeAgent >/dev/null; then
  echo "::error::ScreenTimeAgent still runs"; pgrep -lx ScreenTimeAgent; exit 1
fi
echo "Screen Time agent off ($service disabled, not loaded)"
