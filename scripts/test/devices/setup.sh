#!/usr/bin/env bash
# The real mobile browsers and the Windows 11 VM of the device suite (apps/server/test/devices,
# docs/TESTING.md "Real devices"), installed and removed on demand: they take tens of gigabytes,
# so a machine keeps them only while someone tests with them.
#
#   scripts/test/devices/setup.sh install android|ios|windows ...
#   scripts/test/devices/setup.sh remove  android|ios|windows ...   (or: remove all)
#   scripts/test/devices/setup.sh status
#
# android  Android SDK command-line tools, platform-tools, the emulator and an Android 16
#          (API 36) Google APIs system image (it ships Chrome), plus the AVD "swarmcast-pixel"
#          (a Pixel 7 with the on-screen keyboard). SDK: $ANDROID_HOME, else
#          ~/Library/Android/sdk (macOS) or ~/Android/Sdk (Linux). Needs Java 17 or newer.
# ios      macOS: an iOS Simulator runtime (only when Xcode has none) and the simulator
#          "SwarmCast iPhone" (an iPhone 17) set up for safaridriver. Needs Xcode.
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

# Pinned: Android SDK command-line tools 22.0 (build 15859902), SHA-1 as Google publishes them
# in https://dl.google.com/android/repository/repository2-3.xml. Not 23.0: its sdkmanager hands
# over to the new "Android CLI", which downloads itself into ~/.android and collects usage data
# unless told not to. sdkmanager verifies the packages it installs itself.
CMDLINE_BUILD=15859902
cmdline_sha1() {
  case "$1" in
    mac_arm64) echo c4e0dbc53f1a4ce04fc2b11d4e2c4675001a95af ;;
    mac_x86_64) echo 1a79e61677b99cb0ce622792713cbea7ff2dc5de ;;
    linux) echo 040d3996a65543d22ec4bf73e4c37aa37a8d4af4 ;;
  esac
}
# Pinned: Android Emulator 37.2.12 (build 16428233), SHA-256 of Google's archives (no longer in its
# repository listing, which offers only the newest). 37.2.13 crashed with SIGSEGV in its host
# renderer thread (a core named RenderThread) in most CI runs of the device suite; the one change in
# its release notes is that it now frees a guest process's GLES contexts and surfaces when it exits.
EMULATOR_VERSION=37.2.12
EMULATOR_BUILD=16428233
emulator_zip_sha256() {
  case "$1" in
    mac_arm64) echo "emulator-darwin_aarch64-$EMULATOR_BUILD.zip f4c4a142bda54fcec064bdb32b51f19e25bae0a45ad019197ef968bf7a48979b" ;;
    mac_x86_64) echo "emulator-darwin_x64-$EMULATOR_BUILD.zip 9fdae8c07ac92155aeb175835669ef9b12adf19130f5557792139fb4ebd01256" ;;
    linux) echo "emulator-linux_x64-$EMULATOR_BUILD.zip b08fc43d8608d2955f607f1b287beb525041e730086bdca3af152accac3af9c1" ;;
  esac
}
ANDROID_API=36
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

# Host flavour of the command-line tools and the system image ABI the emulator runs natively.
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

install_android() {
  local sdk host abi zip url sha tmp image
  sdk="$(android_sdk)"
  read -r host abi <<<"$(android_host)"
  java_ok || die "sdkmanager needs Java 17 or newer on PATH (java -version)"
  image="system-images;android-$ANDROID_API;google_apis;$abi"

  make_dir "$sdk"
  # ~/.android (sdkmanager's cache, the AVDs, adb's key) is created by the first Android tool
  # that runs, and the emulator's console token by the first emulator: recorded here when they do
  # not exist yet.
  make_dir "$HOME/.android"
  [ -e "$HOME/.emulator_console_auth_token" ] || record file "$HOME/.emulator_console_auth_token"
  if [ ! -x "$sdk/cmdline-tools/latest/bin/sdkmanager" ]; then
    zip="commandlinetools-$host-${CMDLINE_BUILD}_latest.zip"
    url="https://dl.google.com/android/repository/$zip"
    sha="$(cmdline_sha1 "$host")"
    make_dir "$STATE/downloads"
    tmp="$(mktemp -d "$STATE/downloads/cmdline.XXXXXX")" || die "no temp folder"
    say "Downloading $url"
    curl -fsSL --retry 3 -o "$tmp/$zip" "$url" || die "download failed: $url"
    [ "$(shasum -a 1 "$tmp/$zip" | cut -d ' ' -f1)" = "$sha" ] || die "$zip: SHA-1 differs from $sha"
    (cd "$tmp" && unzip -q "$zip") || die "cannot unzip $zip"
    mkdir -p "$sdk/cmdline-tools"
    rm -rf "${sdk:?}/cmdline-tools/latest"
    mv "$tmp/cmdline-tools" "$sdk/cmdline-tools/latest" || die "cannot move the tools into $sdk"
    rm -rf "${tmp:?}"
  fi
  local sdkmanager="$sdk/cmdline-tools/latest/bin/sdkmanager"
  say "Accepting the Android SDK licences and installing platform-tools, emulator, $image"
  # `yes` ends on SIGPIPE once sdkmanager stops reading: not a failure (pipefail).
  { yes 2>/dev/null || true; } | "$sdkmanager" --sdk_root="$sdk" --licenses >/dev/null || die "sdkmanager --licenses failed"
  "$sdkmanager" --sdk_root="$sdk" --install platform-tools emulator "$image" | grep -v '^\[' || true
  [ -d "$sdk/system-images/android-$ANDROID_API/google_apis/$abi" ] || die "$image did not install"
  install_emulator "$sdk" "$host"

  mkdir -p "$HOME/.android/avd"
  if [ ! -d "$HOME/.android/avd/$AVD_NAME.avd" ]; then
    say "Creating the AVD $AVD_NAME ($AVD_DEVICE, $image)"
    echo no | ANDROID_SDK_ROOT="$sdk" "$sdk/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD_NAME" -k "$image" -d "$AVD_DEVICE" >/dev/null ||
      die "avdmanager could not create $AVD_NAME"
    record avd "$AVD_NAME"
  fi
  # The on-screen keyboard (no hardware keyboard: the suite checks that it does not cover the
  # chat input), and enough memory for Chrome with a live video.
  local cfg="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  local key value
  for kv in hw.keyboard=no hw.ramSize=4096 disk.dataPartition.size=6G hw.audioOutput=yes; do
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

# The pinned emulator in place of the one sdkmanager installed (the newest), its package.xml kept
# with the pinned version so that sdkmanager lists what is there.
install_emulator() {
  local sdk="$1" host="$2" zip sum tmp
  [ "$(cat "$sdk/emulator/.swarmcast-build" 2>/dev/null)" = "$EMULATOR_BUILD" ] && return 0
  read -r zip sum <<<"$(emulator_zip_sha256 "$host")"
  make_dir "$STATE/downloads"
  tmp="$(mktemp -d "$STATE/downloads/emulator.XXXXXX")" || die "no temp folder"
  say "Downloading the Android Emulator $EMULATOR_VERSION ($zip)"
  curl -fsSL --retry 3 -o "$tmp/$zip" "https://dl.google.com/android/repository/$zip" || die "download failed: $zip"
  [ "$(shasum -a 256 "$tmp/$zip" | cut -d ' ' -f1)" = "$sum" ] || die "$zip: SHA-256 differs from $sum"
  (cd "$tmp" && unzip -q "$zip") || die "cannot unzip $zip"
  if [ -f "$sdk/emulator/package.xml" ]; then
    sed -e "s|<major>[0-9]*</major>|<major>${EMULATOR_VERSION%%.*}</major>|" \
      -e "s|<minor>[0-9]*</minor>|<minor>$(echo "$EMULATOR_VERSION" | cut -d . -f2)</minor>|" \
      -e "s|<micro>[0-9]*</micro>|<micro>${EMULATOR_VERSION##*.}</micro>|" "$sdk/emulator/package.xml" >"$tmp/emulator/package.xml"
  fi
  echo "$EMULATOR_BUILD" >"$tmp/emulator/.swarmcast-build"
  rm -rf "${sdk:?}/emulator"
  mv "$tmp/emulator" "$sdk/emulator" || die "cannot move the emulator into $sdk"
  rm -rf "${tmp:?}"
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
