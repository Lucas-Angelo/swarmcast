#!/usr/bin/env bash
# The real mobile browsers and the Windows 11 VM of the device suite (apps/server/test/devices,
# docs/TESTING.md "Real devices"), installed and removed on demand: they take tens of gigabytes,
# so a machine keeps them only while someone tests with them.
#
#   scripts/test/devices/setup.sh install android|ios|windows ...
#   scripts/test/devices/setup.sh remove  android|ios|windows ...   (or: remove all)
#   scripts/test/devices/setup.sh status
#   scripts/test/devices/setup.sh fetch android      (only the archives, into $SC_ANDROID_ARCHIVES)
#   scripts/test/devices/setup.sh artifact android   (the name of CI's saved copy of them)
#
# android  Android SDK command-line tools, platform-tools, the emulator and an Android 16
#          (API 36) Google APIs system image (it ships Chrome), plus the AVD "swarmcast-pixel"
#          (a Pixel 7 with the on-screen keyboard). SDK: $ANDROID_HOME, else
#          ~/Library/Android/sdk (macOS) or ~/Android/Sdk (Linux). Needs Java 17 or newer.
#          Every package is an archive pinned by SHA-256 in android-sdk.pins, unzipped into the
#          SDK by this script (sdkmanager downloads nothing): from $SC_ANDROID_ARCHIVES when it
#          holds them, else from dl.google.com with tries (kept there when that is set).
# ios      macOS: an iOS Simulator runtime (only when Xcode has none) and the simulator
#          "SwarmCast iPhone" (an iPhone 17) set up for safaridriver, with the daemons a page in
#          Safari never needs turned off. Needs Xcode.
# windows  Apple silicon Macs: UTM (Homebrew cask), the unattended-install CD of a Windows 11 on
#          Arm VM (windows/autounattend.xml, windows/first-logon.ps1) and the steps to make the
#          VM in UTM. Microsoft's ISO is downloaded by hand (the script says how): Microsoft
#          gives it out through its web page only.
#
# `remove` deletes exactly what `install` created, as listed in the manifest
# ($SC_DEVICES_HOME/created, default ~/.swarmcast-devices): an SDK, simulator runtime, UTM or
# folder that was already there before `install` is left alone. Every emulator, simulator or VM
# this script created is shut down first.
set -u
set -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="${SC_DEVICES_HOME:-$HOME/.swarmcast-devices}"
MANIFEST="$STATE/created"

# The Android SDK packages, pinned: each archive with its SHA-256 in android-sdk.pins. They come
# from $SC_ANDROID_ARCHIVES when it holds them (CI restores the saved copy there), else from
# dl.google.com with tries; setup.sh unzips them into the SDK itself, with no sdkmanager download.
PINS="$DIR/android-sdk.pins"
ANDROID_REPOSITORY=https://dl.google.com/android/repository
ANDROID_API="${SC_ANDROID_API:-36}"
AVD_NAME=swarmcast-pixel
AVD_DEVICE=pixel_7

say() { printf '%s\n' "$*"; }
die() {
  printf 'setup.sh: %s\n' "$*" >&2
  exit 1
}

# ---- manifest: one "<kind><TAB><value>" line per thing this script created ----

record() {
  mkdir -p "$STATE"
  grep -qxF "$1	$2" "$MANIFEST" 2>/dev/null || printf '%s\t%s\n' "$1" "$2" >>"$MANIFEST"
}
forget() {
  [ -f "$MANIFEST" ] || return 0
  grep -vxF "$1	$2" "$MANIFEST" >"$MANIFEST.tmp"
  mv "$MANIFEST.tmp" "$MANIFEST"
}
# The values recorded for one kind, newest first (removal undoes creation in reverse).
recorded() {
  [ -f "$MANIFEST" ] || return 0
  awk -F '\t' -v k="$1" '$1 == k { v[n++] = $2 } END { while (n > 0) print v[--n] }' "$MANIFEST"
}
# A folder made by this script (with its parents that did not exist either).
make_dir() {
  local d="$1" top="$1"
  while [ ! -e "$(dirname "$top")" ]; do top="$(dirname "$top")"; done
  if [ ! -e "$top" ]; then
    mkdir -p "$d" || die "cannot create $d"
    record dir "$top"
  fi
}
size_of() { du -sh "$1" 2>/dev/null | cut -f1; }

# ---- Android ----

android_sdk() {
  if [ -n "${ANDROID_HOME:-}" ]; then
    printf '%s\n' "$ANDROID_HOME"
  elif [ "$(uname -s)" = Darwin ]; then
    printf '%s\n' "$HOME/Library/Android/sdk"
  else
    printf '%s\n' "$HOME/Android/Sdk"
  fi
}

# Host flavour of the archives (android-sdk.pins) and the system image ABI the emulator runs natively.
android_host() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "mac_arm64 arm64-v8a" ;;
    Darwin-x86_64) echo "mac_x86_64 x86_64" ;;
    Linux-x86_64) echo "linux x86_64" ;;
    *) die "no Android emulator for $(uname -s) $(uname -m) (x86_64 Linux, or a Mac)" ;;
  esac
}

java_ok() {
  local v
  v="$(java -version 2>&1 | awk -F '"' '/version/ { print $2; exit }')"
  [ -n "$v" ] && [ "${v%%.*}" -ge 17 ]
}

# SHA-256 of a file, or of stdin without one.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi | cut -d ' ' -f1
}

warn() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::warning title=Android SDK::$*"; else printf 'setup.sh: %s\n' "$*" >&2; fi
}

# The packages this host installs, "<package path> <version> <archive> <sha256>" per line: the
# command-line tools, platform-tools, the emulator and the system image of ANDROID_API.
android_wanted() {
  local host abi image lines
  read -r host abi <<<"$(android_host)"
  image="system-images;android-$ANDROID_API;google_apis;$abi"
  lines="$(awk -v h="$host" -v img="$image" '$1 == h && ($2 !~ /^system-images;/ || $2 == img) { print $2, $3, $4, $5 }' "$PINS")"
  grep -q "^$image " <<<"$lines" || die "$image is not pinned for $host in $PINS"
  [ "$(wc -l <<<"$lines")" -eq 4 ] || die "$PINS: $host needs one line each for cmdline-tools;latest, platform-tools, emulator and $image"
  printf '%s\n' "$lines"
}

# The saved copy's name (CI's artifact, .github/actions/android-sdk): the host and a hash of the
# pins it installs, so a changed pin makes a new one.
android_artifact() {
  local host lines
  read -r host _ <<<"$(android_host)"
  lines="$(android_wanted)" || exit 1
  printf 'android-sdk-%s-%s\n' "$host" "$(printf '%s\n' "$lines" | sha256_of | cut -c1-16)"
}

# The downloads of one run share a time limit (seconds), so a CI step ends with the
# infrastructure error below before its own limit: 7 minutes in CI (about 2.4 GB, which takes well
# under a minute from GitHub's runners), an hour elsewhere.
if [ "${GITHUB_ACTIONS:-}" = true ]; then FETCH_LIMIT="${SC_ANDROID_FETCH_LIMIT:-420}" TRY_LIMIT=180; else FETCH_LIMIT="${SC_ANDROID_FETCH_LIMIT:-3600}" TRY_LIMIT=3600; fi
FETCH_START=

# dl.google.com or the runner's network failed, not SwarmCast: in CI a `(infrastructure)` error
# that names the file and why the job had to download it.
android_infra() {
  local msg="dl.google.com did not answer: $1: $2"
  [ -z "${SC_ANDROID_ARCHIVES_FROM:-}" ] || msg="$msg. The job needed it because $SC_ANDROID_ARCHIVES_FROM"
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::error title=Android SDK (infrastructure)::$msg. Nothing was tested: an outage of Google's download server or of the runner's network, not a failure of SwarmCast. Run the job again once it answers."
  fi
  die "$msg"
}

# The pinned archive in <dir>, its SHA-256 checked. Taken from <dir> when it is there with the
# pinned SHA-256 (a file that differs is deleted); else from dl.google.com (the cold path): each
# try cut off after TRY_LIMIT seconds, or 30 s below 100 kB/s, and resumed where the last one
# stopped; 3 tries, 5 and 15 s apart, within FETCH_LIMIT for the whole run; a 404 is not tried
# again. A file that came only after failed tries logs `infra recovery:`.
fetch_archive() {
  local archive="$1" sum="$2" dir="$3" file part url try code rc left reason reasons=""
  file="$dir/$(basename "$archive")"
  if [ -f "$file" ]; then
    if [ "$(sha256_of "$file")" = "$sum" ]; then
      say "  $(basename "$archive"): from $dir, SHA-256 as pinned"
      return 0
    fi
    warn "$file is not the pinned file (SHA-256 differs from $sum): deleted, downloaded again"
    rm -f "$file"
  fi
  url="$ANDROID_REPOSITORY/$archive"
  part="$file.part"
  [ -n "$FETCH_START" ] || FETCH_START=$SECONDS
  for try in 1 2 3; do
    left=$((FETCH_LIMIT - (SECONDS - FETCH_START)))
    if [ "$left" -lt 10 ]; then
      reasons="$reasons; out of time ($FETCH_LIMIT s for the downloads)"
      break
    fi
    [ "$left" -le "$TRY_LIMIT" ] || left=$TRY_LIMIT
    say "  $(basename "$archive"): downloading $url (try $try of 3)"
    code="$(curl -fsSL --connect-timeout 20 --max-time "$left" --speed-limit 100000 --speed-time 30 -C - -o "$part" -w '%{http_code}' "$url")"
    rc=$?
    if [ -f "$part" ] && [ "$(sha256_of "$part")" = "$sum" ]; then
      mv "$part" "$file" || die "cannot move $part to $file"
      [ "$try" = 1 ] || warn "infra recovery: $url downloaded on try $try of 3 (${reasons#; })"
      return 0
    fi
    if [ "$rc" = 0 ] || [ "$code" = 416 ]; then
      reason="the file's SHA-256 is not the pinned $sum"
      rm -f "$part"
    else
      reason="curl exit $rc, HTTP $code"
    fi
    reasons="$reasons; try $try: $reason"
    say "    $reason"
    if [ "$code" = 404 ]; then break; fi
    if [ "$try" = 1 ]; then sleep 5; elif [ "$try" = 2 ]; then sleep 15; fi
  done
  rm -f "$part"
  android_infra "$archive" "${reasons#; }"
}

# The local package.xml that sdkmanager writes next to a package it installs, for the package
# unzipped in <dir>: avdmanager finds the emulator and the system image by it (with the archives'
# source.properties alone it says '"emulator" package must be installed!'). A system image's
# details as sdkmanager's own (sys-img2/05), the extension level from its source.properties:
# without the `abis` list and that level, avdmanager failed with just "null".
package_xml() {
  local path="$1" version="$2" dir="$3" major minor micro rev details name api tag abi ext
  IFS=. read -r major minor micro <<<"$version"
  rev="<major>$major</major>"
  [ -z "$minor" ] || rev="$rev<minor>$minor</minor>"
  [ -z "$micro" ] || rev="$rev<micro>$micro</micro>"
  details='<type-details xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns5:genericDetailsType"/>'
  case "$path" in
    cmdline-tools\;*) name="Android SDK Command-line Tools (latest)" ;;
    platform-tools) name="Android SDK Platform-Tools" ;;
    emulator) name="Android Emulator" ;;
    system-images\;*\;google_apis\;*)
      IFS=';' read -r _ api tag abi <<<"$path"
      ext="$(awk -F = '$1 == "AndroidVersion.ExtensionLevel" { e = $2 } $1 == "AndroidVersion.IsBaseSdk" { b = $2 } END { if (e != "") printf "<extension-level>%s</extension-level><base-extension>%s</base-extension>", e, (b == "" ? "true" : b) }' "$dir/source.properties")"
      details="<type-details xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"ns14:sysImgDetailsType\"><api-level>${api#android-}</api-level>$ext<tag><id>$tag</id><display>Google APIs</display></tag><vendor><id>google</id><display>Google Inc.</display></vendor><abi>$abi</abi><abis>$abi</abis></type-details>"
      name="Google APIs $abi System Image"
      ;;
    *) die "no package.xml for $path" ;;
  esac
  printf '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02" xmlns:ns5="http://schemas.android.com/repository/android/generic/02" xmlns:ns14="http://schemas.android.com/sdk/android/repo/sys-img2/05"><localPackage path="%s" obsolete="false">%s<revision>%s</revision><display-name>%s</display-name></localPackage></ns2:repository>\n' "$path" "$details" "$rev" "$name"
}

# One package from its checked archive: unzipped into its folder of the SDK (the package path,
# `;` as `/`), with its package.xml. Skipped when that folder holds this archive already.
install_package() {
  local sdk="$1" path="$2" version="$3" file="$4" sum="$5" dir tmp top
  dir="$sdk/$(printf '%s' "$path" | tr ';' /)"
  if [ "$(cat "$dir/.swarmcast-archive" 2>/dev/null)" = "$sum" ]; then
    say "  $path $version: installed already"
    return 0
  fi
  tmp="$(mktemp -d "$sdk/.unzip.XXXXXX")" || die "no temp folder in $sdk"
  (cd "$tmp" && unzip -q "$file") || die "cannot unzip $file"
  top="$(ls -A "$tmp")"
  { [ "$(printf '%s\n' "$top" | wc -l)" -eq 1 ] && [ -d "$tmp/$top" ]; } || die "$file does not hold one folder ($top)"
  package_xml "$path" "$version" "$tmp/$top" >"$tmp/$top/package.xml"
  printf '%s\n' "$sum" >"$tmp/$top/.swarmcast-archive"
  mkdir -p "$(dirname "$dir")"
  rm -rf "${dir:?}"
  mv "$tmp/$top" "$dir" || die "cannot move $path into $sdk"
  rmdir "$tmp"
  say "  $path $version: installed from $(basename "$file")"
}

# Where the archives are: $SC_ANDROID_ARCHIVES (kept), else a download folder of this run (deleted
# after the install).
archives_dir() {
  if [ -n "${SC_ANDROID_ARCHIVES:-}" ]; then
    mkdir -p "$SC_ANDROID_ARCHIVES" || die "cannot create $SC_ANDROID_ARCHIVES"
    printf '%s\n' "$SC_ANDROID_ARCHIVES"
  else
    make_dir "$STATE/downloads"
    mktemp -d "$STATE/downloads/android.XXXXXX" || die "no temp folder"
  fi
}

# `fetch android`: only the archives, checked, into $SC_ANDROID_ARCHIVES (CI saves them).
fetch_android() {
  [ -n "${SC_ANDROID_ARCHIVES:-}" ] || die "fetch android needs SC_ANDROID_ARCHIVES (the folder for the archives)"
  local wanted path version archive sum dir
  wanted="$(android_wanted)" || exit 1
  dir="$(archives_dir)" || exit 1
  say "Android SDK archives (android-sdk.pins) into $dir"
  while read -r path version archive sum; do
    fetch_archive "$archive" "$sum" "$dir"
  done <<<"$wanted"
}

install_android() {
  local sdk abi image wanted dir path version archive sum
  sdk="$(android_sdk)"
  read -r _ abi <<<"$(android_host)"
  java_ok || die "avdmanager needs Java 17 or newer on PATH (java -version)"
  image="system-images;android-$ANDROID_API;google_apis;$abi"
  wanted="$(android_wanted)" || exit 1

  make_dir "$sdk"
  # ~/.android (the AVDs, adb's key) is created by the first Android tool that runs, and the
  # emulator's console token by the first emulator: recorded here when they do not exist yet.
  make_dir "$HOME/.android"
  [ -e "$HOME/.emulator_console_auth_token" ] || record file "$HOME/.emulator_console_auth_token"
  dir="$(archives_dir)" || exit 1
  say "Android SDK packages (android-sdk.pins) into $sdk, archives in $dir"
  while read -r path version archive sum; do
    fetch_archive "$archive" "$sum" "$dir"
    install_package "$sdk" "$path" "$version" "$dir/$(basename "$archive")" "$sum"
  done <<<"$wanted"
  [ -n "${SC_ANDROID_ARCHIVES:-}" ] || rm -rf "${dir:?}"

  mkdir -p "$HOME/.android/avd"
  if [ ! -d "$HOME/.android/avd/$AVD_NAME.avd" ]; then
    say "Creating the AVD $AVD_NAME ($AVD_DEVICE, $image)"
    echo no | ANDROID_SDK_ROOT="$sdk" "$sdk/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD_NAME" -k "$image" -d "$AVD_DEVICE" >/dev/null ||
      die "avdmanager could not create $AVD_NAME"
    record avd "$AVD_NAME"
  fi
  # The on-screen keyboard (no hardware keyboard: the suite checks that it does not cover the
  # chat input), and enough memory and CPU for Chrome with a live video. Four cores, the CI
  # runner's count: with the AVD's default two the guest stayed CPU-bound through the run (CPU
  # pressure near 90 %), and system apps missed Android's deadlines; SystemUI's "isn't
  # responding" dialog then took the window focus from Chrome at a cold boot, so the keyboard
  # never came up, and Gboard was killed mid-test (Devices run 42316622933, docs/TESTING.md
  # "Real devices").
  local cfg="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  local key value
  for kv in hw.keyboard=no hw.ramSize=4096 hw.cpu.ncore=4 disk.dataPartition.size=6G hw.audioOutput=yes; do
    key="${kv%%=*}"
    value="${kv#*=}"
    if grep -q "^${key}[ ]*=" "$cfg"; then
      sed -i.bak "s|^${key}[ ]*=.*|$key=$value|" "$cfg" && rm -f "$cfg.bak"
    else
      printf '%s=%s\n' "$key" "$value" >>"$cfg"
    fi
  done
  say "Android ready: SDK $sdk ($(size_of "$sdk")), AVD $AVD_NAME ($(size_of "$HOME/.android/avd/$AVD_NAME.avd"))."
}

remove_android() {
  local sdk avd
  sdk="$(android_sdk)"
  # Running emulators first (they hold the AVD files open).
  if [ -x "$sdk/platform-tools/adb" ]; then
    "$sdk/platform-tools/adb" devices 2>/dev/null | awk '/^emulator-/ { print $1 }' | while read -r serial; do
      "$sdk/platform-tools/adb" -s "$serial" emu kill >/dev/null 2>&1 || true
    done
    "$sdk/platform-tools/adb" kill-server >/dev/null 2>&1 || true
  fi
  while IFS= read -r avd; do
    if [ -x "$sdk/cmdline-tools/latest/bin/avdmanager" ]; then
      ANDROID_SDK_ROOT="$sdk" "$sdk/cmdline-tools/latest/bin/avdmanager" delete avd -n "$avd" >/dev/null 2>&1 || true
    fi
    rm -rf "$HOME/.android/avd/${avd:?}.avd" "$HOME/.android/avd/${avd:?}.ini"
    forget avd "$avd"
    say "Removed the AVD $avd"
  done < <(recorded avd)
}

# ---- iOS Simulator ----

SIM_NAME="SwarmCast iPhone"
SIM_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-17
# Web Inspector and remote automation switches inside the simulator (apps/server/test/devices/ios.ts).
SIM_KEYS="com.apple.webinspectord:RemoteInspectorEnabled com.apple.webinspectord:RemoteAutomationEnabled com.apple.webinspectord:WIRRemoteAutomationEnabled com.apple.mobilesafari:WebKitDeveloperExtrasEnabledPreferenceKey com.apple.mobilesafari:WebInspectorEnabled com.apple.mobilesafari:RemoteAutomationEnabled com.apple.mobilesafari:WebKitRemoteAutomationEnabled"
# Safari's tips (TipKit) off: one popped up over the page and took a tap (ios.ts SAFARI_TIPS_OFF).
SIM_KEYS="$SIM_KEYS com.apple.mobilesafari:com.apple.TipKit.HideAllTips"
# Daemons a page in Safari never needs, turned off for every later boot: the push daemon's retry
# loop and the rest kept the CI Mac saturated, and siriactionsd's index of every app's actions
# (BackgroundShortcutRunner) took the first test's CPU (apps/server/test/devices/ios.ts UNUSED_JOBS).
SIM_UNUSED_JOBS="com.apple.apsd com.apple.identityservicesd com.apple.StatusKitAgent com.apple.remindd com.apple.healthd com.apple.fitcore com.apple.fitnessintelligenced com.apple.finhealthd com.apple.assistantd com.apple.mediaanalysisd com.apple.chronod com.apple.siriactionsd"

# shellcheck disable=SC2016 # ${...} below is JavaScript, for node
ios_runtimes() {
  xcrun simctl list runtimes --json | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      for (const r of JSON.parse(s).runtimes) if (r.platform === "iOS" && r.isAvailable) console.log(`${r.version}\t${r.identifier}`);
    });' | sort -t . -k1,1n -k2,2n -k3,3n
}
# shellcheck disable=SC2016 # as above
sim_udids() {
  xcrun simctl list devices --json | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      for (const list of Object.values(JSON.parse(s).devices)) for (const d of list) console.log(`${d.udid}\t${d.name}`);
    });'
}
runtime_images() { xcrun simctl runtime list --json | node -e 'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => { for (const id of Object.keys(JSON.parse(s))) console.log(id); });'; }

install_ios() {
  [ "$(uname -s)" = Darwin ] || die "the iOS Simulator needs macOS"
  xcodebuild -version >/dev/null 2>&1 || die "Xcode is needed (xcode-select -p)"
  local runtime images_before devices_before id udid key
  runtime="$(ios_runtimes | tail -n 1 | cut -f2)"
  if [ -z "$runtime" ]; then
    images_before="$(runtime_images)"
    devices_before="$(sim_udids | cut -f1)"
    say "Downloading the iOS Simulator runtime of this Xcode (about 8 GB)"
    if [ "$(uname -m)" = arm64 ]; then xcodebuild -downloadPlatform iOS -architectureVariant arm64; else xcodebuild -downloadPlatform iOS; fi || die "xcodebuild -downloadPlatform iOS failed"
    # What the download added: its disk images, and the simulators CoreSimulator made for them.
    for id in $(runtime_images); do grep -qx "$id" <<<"$images_before" || record sim-runtime "$id"; done
    for udid in $(sim_udids | cut -f1); do grep -qx "$udid" <<<"$devices_before" || record sim-device "$udid"; done
    runtime="$(ios_runtimes | tail -n 1 | cut -f2)"
    [ -n "$runtime" ] || die "no iOS runtime after the download"
  fi
  # awk reads everything (no early exit): the writer of a pipe closed early gets EPIPE.
  udid="$(sim_udids | awk -F '\t' -v n="$SIM_NAME" '$2 == n && !found { print $1; found = 1 }')"
  if [ -z "$udid" ]; then
    udid="$(xcrun simctl create "$SIM_NAME" "$SIM_TYPE" "$runtime")" || die "cannot create $SIM_NAME ($SIM_TYPE, $runtime)"
    record sim-device "$udid"
  fi
  say "Setting up $SIM_NAME ($udid, $runtime) for safaridriver"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null || die "$SIM_NAME did not boot"
  for key in $SIM_KEYS; do xcrun simctl spawn "$udid" defaults write "${key%%:*}" "${key#*:}" -bool true || die "cannot set $key"; done
  for job in $SIM_UNUSED_JOBS; do xcrun simctl spawn "$udid" launchctl disable "user/foreground/$job" || die "cannot turn off $job"; done
  xcrun simctl shutdown "$udid" || true
  say "iOS ready: $SIM_NAME ($udid). safaridriver needs 'sudo safaridriver --enable' once (it asks for an admin password)."
}

remove_ios() {
  [ "$(uname -s)" = Darwin ] || return 0
  local udid id
  while IFS= read -r udid; do
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
    forget sim-device "$udid"
    say "Removed the simulator $udid"
  done < <(recorded sim-device)
  while IFS= read -r id; do
    xcrun simctl runtime delete "$id" || die "cannot delete the simulator runtime $id"
    forget sim-runtime "$id"
    say "Removed the simulator runtime $id"
  done < <(recorded sim-runtime)
}

# ---- Windows 11 VM (UTM) ----

WIN_VM_NAME="SwarmCast Win11"
WIN_USER=swarmcast
UTM_DOCUMENTS="$HOME/Library/Containers/com.utmapp.UTM/Data/Documents"

win_iso_clicks() {
  cat <<EOF
No Windows 11 ARM64 ISO yet. Microsoft hands it out through its download page only (a browser
session), so download it once by hand:
  1. Open https://www.microsoft.com/software-download/windows11arm64
  2. Under "Download Windows 11 Disk Image (ISO) for Arm-based PCs", select
     "Windows 11 (multi-edition ISO for Arm64)", then "Download Now".
  3. Under "Select the product language", choose "English (United States)", then "Confirm".
  4. Click the Arm64 download link (valid for 24 hours); the ISO goes to ~/Downloads.
  5. Optional: copy its SHA-256 from "Verify your download" on the same page.
Then run again:
  SC_WIN11_ISO_SHA256=<that hash> $0 install windows
(SC_WIN11_ISO=/path/to.iso if it is not ~/Downloads/Win11*Arm64*.iso.)
EOF
}

install_windows() {
  [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || die "the Windows 11 on Arm VM needs a Mac with Apple silicon"
  local iso="${SC_WIN11_ISO:-}" dir sum password
  # shellcheck disable=SC2012 # the newest download by its name pattern
  [ -n "$iso" ] || iso="$(ls -t "$HOME"/Downloads/Win11*Arm64*.iso 2>/dev/null | head -n 1)"
  if [ -z "$iso" ] || [ ! -f "$iso" ]; then
    win_iso_clicks
    exit 3
  fi
  if [ -n "${SC_WIN11_ISO_SHA256:-}" ]; then
    sum="$(shasum -a 256 "$iso" | cut -d ' ' -f1)"
    [ "$sum" = "$(printf '%s' "$SC_WIN11_ISO_SHA256" | tr 'A-F' 'a-f')" ] || die "$iso: SHA-256 $sum, Microsoft lists $SC_WIN11_ISO_SHA256"
  fi
  if [ ! -d /Applications/UTM.app ]; then
    command -v brew >/dev/null || die "UTM is needed: brew install --cask utm (or https://mac.getutm.app)"
    brew install --cask utm || die "brew install --cask utm failed"
    record cask utm
  fi
  # The answer file CD: autounattend.xml with this VM's account, and first-logon.ps1.
  dir="$STATE/windows"
  make_dir "$dir/cd"
  if [ ! -s "$dir/password" ]; then (umask 077 && openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20 >"$dir/password"); fi
  password="$(cat "$dir/password")"
  sed -e "s|@USER@|$WIN_USER|g" -e "s|@PASSWORD@|$password|g" "$DIR/windows/autounattend.xml" >"$dir/cd/autounattend.xml"
  cp "$DIR/windows/first-logon.ps1" "$dir/cd/first-logon.ps1"
  rm -f "${dir:?}/unattend.iso"
  hdiutil makehybrid -iso -joliet -default-volume-name SWARMCAST -o "$dir/unattend.iso" "$dir/cd" >/dev/null || die "hdiutil could not make $dir/unattend.iso"
  cat <<EOF
Windows ISO: $iso
Answer file CD: $dir/unattend.iso (account $WIN_USER, password in $dir/password)
In UTM (one VM by hand: UTM's scripting cannot add the TPM that Windows 11 wants):
  1. Create a New Virtual Machine > Virtualize > Windows.
  2. Tick "Install Windows 10 or higher" and "Install drivers and SPICE tools"; Boot ISO Image: Browse > the ISO above.
  3. Memory 8192 MB, CPU cores 4; storage 64 GB; no shared folder; name: $WIN_VM_NAME; Save.
  4. Edit the VM > Drives > New... > Removable, Interface USB; select the new drive > Image: $dir/unattend.iso.
  5. Start the VM. Setup runs by itself (30 to 60 minutes) and logs on as $WIN_USER; then
     C:\\Users\\Public\\swarmcast-vm-ready.txt exists and ssh works: ssh $WIN_USER@<the VM's address>
     (UTM shows it; with the default Shared Network it is 192.168.64.x).
EOF
}

remove_windows() {
  [ "$(uname -s)" = Darwin ] || return 0
  # The VM made from the instructions above, by its name; UTM must not hold it open.
  if [ -d "$UTM_DOCUMENTS/$WIN_VM_NAME.utm" ]; then
    pkill -x UTM 2>/dev/null || true
    say "Removing the VM $WIN_VM_NAME ($(size_of "$UTM_DOCUMENTS/$WIN_VM_NAME.utm"))"
    rm -rf "${UTM_DOCUMENTS:?}/${WIN_VM_NAME:?}.utm"
  fi
  # grep without -q reads all its input: with pipefail, a writer cut off early fails the pipeline.
  if recorded cask | grep -x utm >/dev/null; then
    pkill -x UTM 2>/dev/null || true
    brew uninstall --cask utm || die "brew uninstall --cask utm failed"
    # UTM's own data (its VM list, settings), made by the UTM this script installed.
    rm -rf "${HOME:?}/Library/Containers/com.utmapp.UTM" "${HOME:?}/Library/Preferences/com.utmapp.UTM.plist"
    forget cask utm
    say "Removed UTM"
  fi
}

# ---- folders and files (last: they may hold what the steps above removed) ----

remove_dirs() {
  local d f
  while IFS= read -r f; do
    case "$f" in
      "$HOME"/?*) rm -f "${f:?}" ;;
      *) die "refusing to remove $f (not inside $HOME)" ;;
    esac
    forget file "$f"
  done < <(recorded file)
  while IFS= read -r d; do
    case "$d" in
      "$HOME"/?*) ;;
      *) die "refusing to remove $d (not inside $HOME)" ;;
    esac
    if [ -e "$d" ]; then
      say "Removing $d ($(size_of "$d"))"
      rm -rf "${d:?}"
    fi
    forget dir "$d"
  done < <(recorded dir)
  # Nothing left to undo: no manifest, and no state folder if it is empty now.
  if [ -f "$MANIFEST" ] && [ ! -s "$MANIFEST" ]; then
    rm -f "$MANIFEST"
    rmdir "$STATE" 2>/dev/null || true
  fi
}

status() {
  say "Manifest: $MANIFEST"
  if [ -f "$MANIFEST" ]; then cat "$MANIFEST"; else say "(nothing installed by this script)"; fi
}

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit 2
}

[ $# -ge 1 ] || usage
verb="$1"
shift
case "$verb" in
  status) status ;;
  fetch | artifact)
    [ "$*" = android ] || usage
    if [ "$verb" = fetch ]; then fetch_android; else android_artifact; fi
    ;;
  install | remove)
    [ $# -ge 1 ] || usage
    [ "$*" = all ] && set -- windows ios android
    for target in "$@"; do
      case "$target" in
        android | ios | windows) "${verb}_$target" ;;
        *) usage ;;
      esac
    done
    if [ "$verb" = remove ]; then remove_dirs; fi
    ;;
  *) usage ;;
esac
