#!/usr/bin/env bash
# apt for the gating Linux jobs without the Ubuntu archive at test time: every package comes from
# the job's saved .deb set, with apt offline.
#
#   apt-debs.sh install  PKG|./x.deb...    install them and what they need, from the set
#   apt-debs.sh download PKG|./x.deb...    make sure the set holds what installing them needs, for a
#                                          later `apt-get install` of the job (offline too)
#   apt-debs.sh playwright-deps BROWSER... the system libraries of Playwright's browsers (install)
#   apt-debs.sh finish                     (setup/save) when this job had to add to the set: keep
#                                          what the job used, write its manifest, print key=<cache key>
#
# Always -y and --no-install-recommends.
#
# Environment:
#   APT_DEBS         the set's folder, restored from the Actions cache by ./.github/actions/setup
#                    (input apt-debs): the .debs, SHA256SUMS (sha256sum's format: every .deb of the
#                    set with its SHA-256) and made-on (the runner image the set was made on)
#   SC_APT_DEBS_KEY  (finish) the cache key up to the runner image version (setup sets it)
#   ImageOS, ImageVersion, RUNNER_ARCH: the runner image (GitHub sets them)
#   apt-retry.sh's APT_* settings, for the cold path
#
# How (.github/workflows/README.md, "Ubuntu packages"):
# - The set is checked once per job: every .deb in SHA256SUMS with that SHA-256 (sha256sum --strict),
#   and nothing else in the folder; a set that does not match is not used at all (a warning).
# - apt then runs in a closed world for the rest of the job: /etc/apt/apt.conf.d/zzzz-sc-apt-debs
#   replaces every source with one flat repository, file:$APT_DEBS (its Packages index made here
#   from the .debs, with their SHA-256), and keeps its lists in a folder of its own. No `apt-get
#   update` against the archive, no download; apt can only install what is in the set or on the
#   image. Every apt-get of the job reads that file, also with sudo and from other tools
#   (Playwright's `install-deps --dry-run`, the desktop test's `apt-get install ./app.deb`).
# - Whether the set fits this runner image is apt's own answer: `apt-get install -s` of the
#   request in that closed world. A set made on an older image fits when the image did not move a
#   package the set's packages pin (a -dev package wants its library at the same version). Nothing
#   on the image is ever downgraded.
# - Only when it does not fit (no set yet, a new runner image that moved such a package, a new
#   request) does the job ask the archive (the cold path): apt-retry.sh (time limit per try,
#   retries, another mirror) downloads what is missing into the set, apt checks those downloads
#   against the archive's signed index, and the request must then fit the closed world too. When
#   the archive does not answer, the job stops at that step with an `apt (infrastructure)` error
#   that says so: nothing is skipped.
# - finish (from ./.github/actions/setup/save, main only): a job that fetched saves a new entry,
#   the .debs it used (plus the rest of the restored set when that was made on the same image),
#   so the next jobs find a set that fits without the archive.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RETRY="$HERE/apt-retry.sh"
SET="${APT_DEBS:-${RUNNER_TEMP:-/tmp}/apt-debs}"
SET="${SET%/}"
WORK="$SET.work"
CONF=/etc/apt/apt.conf.d/zzzz-sc-apt-debs
IMAGE="${ImageOS:-unknown}-${RUNNER_ARCH:-$(dpkg --print-architecture)}-${ImageVersion:-unknown}"
OPTS=(-y --no-install-recommends)
# A file name in the set: what apt names its downloads (name_version_arch.deb, ':' as %3a).
NAME_RE='^[A-Za-z0-9][A-Za-z0-9.+~%_-]*\.deb$'
SUDO=()
[ "$(id -u)" = 0 ] || SUDO=(sudo)
export APT_DEBS="$SET"

log() { echo "apt-debs: $*" >&2; }

# The set as restored, checked once per job; anything that does not match its manifest goes.
check_set() {
  [ -f "$WORK/checked" ] && return 0
  mkdir -p "$SET" "$WORK"
  : >"$WORK/used"
  local bad="" f b n
  if [ -f "$SET/SHA256SUMS" ]; then
    if awk -v re="$NAME_RE" 'NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-f]+$/ || $2 !~ re { bad = 1 } END { exit !bad }' "$SET/SHA256SUMS"; then
      bad="a line of SHA256SUMS is not <sha256>  <name>.deb"
    elif ! (cd "$SET" && sha256sum --check --strict --quiet SHA256SUMS) >"$WORK/check.log" 2>&1; then
      bad="$(head -n 3 "$WORK/check.log" | paste -sd ' ' -)"
    fi
  elif compgen -G "$SET/*.deb" >/dev/null; then
    bad="no SHA256SUMS"
  fi
  if [ -n "$bad" ]; then
    echo "::warning title=apt-debs::the saved .deb set does not match its manifest ($bad): not used"
    "${SUDO[@]}" rm -f "$SET"/*.deb "$SET/SHA256SUMS" "$SET/made-on"
  fi
  touch "$SET/SHA256SUMS"
  for f in "$SET"/*.deb; do
    [ -e "$f" ] || continue
    b="$(basename "$f")"
    if ! awk -v b="$b" '$2 == b { found = 1 } END { exit !found }' "$SET/SHA256SUMS"; then
      log "$b is not in the manifest: removed"
      "${SUDO[@]}" rm -f "$f"
    fi
  done
  cp "$SET/SHA256SUMS" "$WORK/restored.sha256"
  n="$(grep -c . "$SET/SHA256SUMS")"
  if [ "$n" -gt 0 ]; then
    cat "$SET/made-on" >"$WORK/restored-on" 2>/dev/null || echo unknown >"$WORK/restored-on"
    log "the saved set: $n .debs, each with its manifest's SHA-256, made on $(cat "$WORK/restored-on") (this runner: $IMAGE)"
  else
    echo none >"$WORK/restored-on"
    log "no saved set for this job (cold)"
  fi
  touch "$WORK/checked"
}

# SHA256SUMS anew, over every .deb in the folder: the restored ones were checked, apt checked the
# downloads against the archive's signed index.
write_sums() {
  local tmp
  tmp="$(mktemp)"
  (cd "$SET" && for f in *.deb; do [ -e "$f" ] && sha256sum "$f"; done) | sort -k2 >"$tmp"
  mv "$tmp" "$SET/SHA256SUMS"
  chmod 644 "$SET/SHA256SUMS"
}

# The set as a flat repository: Packages (each .deb's control fields, its file, size and
# SHA-256), Release, and index.tsv (package, version, architecture, file) for `used`.
index_set() {
  local sum b ctl tmp
  tmp="$(mktemp)"
  : >"$WORK/index.tsv"
  while read -r sum b; do
    [ -n "$b" ] || continue
    ctl="$(dpkg-deb -f "$SET/$b")" || { echo "::error title=apt-debs::dpkg-deb cannot read $b"; return 1; }
    printf '%s\nFilename: ./%s\nSize: %s\nSHA256: %s\n\n' "$ctl" "$b" "$(stat -c %s "$SET/$b")" "$sum" >>"$tmp"
    printf '%s\t%s\t%s\t%s\n' "$(sed -n 's/^Package: //p' <<<"$ctl")" "$(sed -n 's/^Version: //p' <<<"$ctl")" \
      "$(sed -n 's/^Architecture: //p' <<<"$ctl")" "$b" >>"$WORK/index.tsv"
  done <"$SET/SHA256SUMS"
  mv "$tmp" "$SET/Packages"
  printf 'Origin: sc-apt-debs\nLabel: sc-apt-debs\nSuite: sc-apt-debs\nCodename: sc-apt-debs\nDate: %s\nSHA256:\n %s %s Packages\n' \
    "$(date -u -R)" "$(sha256sum "$SET/Packages" | cut -d' ' -f1)" "$(stat -c %s "$SET/Packages")" >"$SET/Release"
  chmod 644 "$SET/Packages" "$SET/Release"
}

# The closed world: the set is apt's only source, for every apt call of the job from here on.
offline_on() {
  mkdir -p "$WORK/sources.d"
  echo "deb [trusted=yes] file:$SET ./" >"$WORK/sources.list"
  {
    echo '// .github/scripts/apt-debs.sh: the saved .deb set is the only source (no archive, no download).'
    echo "Dir::Etc::SourceList \"$WORK/sources.list\";"
    echo "Dir::Etc::SourceParts \"$WORK/sources.d\";"
    echo "Dir::State::Lists \"$WORK/lists\";"
    echo 'Dir::Cache::pkgcache "";'
    echo 'Dir::Cache::srcpkgcache "";'
    echo 'Acquire::Languages "none";'
    echo 'APT::Sandbox::User "root";'
  } >"$WORK/offline.conf"
  "${SUDO[@]}" mkdir -p "$WORK/lists/partial"
  "${SUDO[@]}" cp "$WORK/offline.conf" "$CONF"
  local lists=""
  eval "$(apt-config shell lists Dir::State::Lists)"
  if [ "$lists" != "$WORK/lists" ]; then
    echo "::error title=apt-debs::apt does not use $CONF (a file sorting after it in /etc/apt/apt.conf.d overrides it)"
    return 1
  fi
  if ! "${SUDO[@]}" apt-get update -q >"$WORK/update.log" 2>&1 || grep -q '^[WE]: ' "$WORK/update.log"; then
    cat "$WORK/update.log" >&2
    echo "::error title=apt-debs::apt-get update of the saved set (file:$SET) failed"
    return 1
  fi
}

offline_off() { "${SUDO[@]}" rm -f "$CONF"; }

# simulate REQ...: does the request install in the closed world? Its .debs from the set go into
# $WORK/used; on failure MISFIT says why (apt's own lines).
MISFIT=""
simulate() {
  local out rc
  out="$(apt-get install -s "${OPTS[@]}" "$@" 2>&1)"
  rc=$?
  if [ "$rc" != 0 ]; then
    MISFIT="$(grep -E '^E: |: (Pre-)?Depends: |^ +(Pre-)?Depends: |: Breaks: |: Conflicts: ' <<<"$out" | sed 's/^ *//' | head -n 6 | paste -sd ' ' -)"
    MISFIT="${MISFIT:-apt-get install -s exited with $rc}"
    return 1
  fi
  sed -nE 's/^Inst ([^ :]+)(:[^ ]+)? (\[[^]]*\] )?\(([^ ]+) .*\[([^]]+)\]\).*$/\1\t\4\t\5/p' <<<"$out" |
    awk -F'\t' 'NR == FNR { file[$1 "\t" $2 "\t" $3] = $4; next } ($0 in file) { print file[$0] }' "$WORK/index.tsv" - >>"$WORK/used"
  log "$(grep -c '^Inst ' <<<"$out") to install for: $*"
}

# infra_fail WHAT WHY: the cold path could not reach the archive. Says so, and stops the job.
infra_fail() {
  local on set why="${2%.}"
  on="$(cat "$WORK/restored-on")"
  set="the saved .deb set (made on $on) does not hold all that this runner image ($IMAGE) needs"
  [ "$on" != none ] || set="no .deb set has been saved for this job on this runner image ($IMAGE) yet"
  echo "::error title=apt (infrastructure)::$1 failed: the Ubuntu archive did not answer (the tries above). The job needed it because $set ($why). Nothing was tested: this is an outage of the archive, not a failure of SwarmCast. Run the job again once the archive answers."
  exit 1
}

# The cold path, online: the archive's lists, then the request's .debs into the set. A download
# that fails while apt can resolve the request from the archive's lists is the archive (infra_fail);
# one apt cannot resolve there either is the request itself (a package that does not exist).
online_update() {
  offline_off
  "$RETRY" update || infra_fail "apt-get update" "$1"
}
online_download() {
  local why="$1" out
  shift
  if ! "$RETRY" download "${OPTS[@]}" "$@"; then
    if ! out="$(apt-get install -s "${OPTS[@]}" "$@" 2>&1)"; then
      echo "::error title=apt-debs::($*) cannot be installed from the Ubuntu archive either: $(grep -E '^E: |Depends: ' <<<"$out" | sed 's/^ *//' | head -n 4 | paste -sd ' ' -)"
      exit 1
    fi
    infra_fail "apt-get install --download-only $*" "$why"
  fi
  write_sums
  touch "$WORK/fetched"
  index_set && offline_on || exit 1
}

# ensure REQ...: the closed world holds the request, from the set or (cold) from the archive.
ensure() {
  local why
  check_set
  index_set && offline_on || exit 1
  if simulate "$@"; then
    log "offline: the saved set holds all that this needs on this runner image"
    return 0
  fi
  why="$MISFIT"
  log "the saved set does not hold all that ($*) needs on this runner image ($why); fetching from the Ubuntu archive (cold)"
  online_update "$why"
  online_download "$why" "$@"
  simulate "$@" || {
    echo "::error title=apt-debs::what apt downloaded for ($*) does not install offline: $MISFIT"
    exit 1
  }
}

# install_offline REQ...: apt-get install in the closed world, then every named package is installed.
install_offline() {
  local start=$SECONDS a pkg missing=()
  "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install "${OPTS[@]}" "$@" || {
    echo "::error title=apt-debs::apt-get install from the saved set failed"
    exit 1
  }
  for a in "$@"; do
    case "$a" in ./* | /*) pkg="$(dpkg-deb -f "$a" Package)" ;; *) pkg="$a" ;; esac
    [ "$(dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null)" = 'install ok installed' ] || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "::error title=apt-debs::not installed after apt-get install: ${missing[*]}"
    exit 1
  fi
  log "apt-get install (offline, from the saved set): $((SECONDS - start)) s"
}

# Playwright's own list: `install-deps --dry-run` asks `apt-get install -s` for its browsers'
# packages (in the closed world here) and prints the ones still missing; it fails when apt
# cannot find one. Its own install runs apt-get update && install with no time limit: never used.
pw_dry() { npx --no-install playwright install-deps --dry-run "$@" 2>&1; }
pw_missing() { sed -n '/^Missing system dependencies/,$ s/^  \([^ ]\{1,\}\)$/\1/p'; }
playwright_deps() {
  local out why="" pkgs=()
  check_set
  index_set && offline_on || exit 1
  out="$(pw_dry "$@")"
  if grep -q '^Missing system dependencies' <<<"$out"; then
    mapfile -t pkgs < <(pw_missing <<<"$out")
    simulate "${pkgs[@]}" || why="$MISFIT"
  elif ! grep -q '^All system dependencies are installed' <<<"$out"; then
    why="$(grep -E "E: |Error" <<<"$out" | head -n 3 | paste -sd ' ' -)"
    why="${why:-$(tail -n 1 <<<"$out")}"
  fi
  if [ -n "$why" ]; then
    log "the saved set does not hold all that Playwright ($*) needs on this runner image ($why); fetching from the Ubuntu archive (cold)"
    online_update "$why"
    out="$(pw_dry "$@")"
    if grep -q '^Missing system dependencies' <<<"$out"; then
      mapfile -t pkgs < <(pw_missing <<<"$out")
      online_download "$why" "${pkgs[@]}"
    elif ! grep -q '^All system dependencies are installed' <<<"$out"; then
      echo "$out" >&2
      echo "::error title=apt-debs::playwright install-deps --dry-run failed against the archive"
      exit 1
    fi
    offline_on || exit 1
    out="$(pw_dry "$@")"
    pkgs=()
    if grep -q '^Missing system dependencies' <<<"$out"; then
      mapfile -t pkgs < <(pw_missing <<<"$out")
      simulate "${pkgs[@]}" || {
        echo "::error title=apt-debs::what apt downloaded for Playwright does not install offline: $MISFIT"
        exit 1
      }
    elif ! grep -q '^All system dependencies are installed' <<<"$out"; then
      echo "$out" >&2
      echo "::error title=apt-debs::playwright install-deps --dry-run failed with the downloaded set"
      exit 1
    fi
  else
    log "offline: the saved set holds all that Playwright ($*) needs on this runner image"
  fi
  echo "Playwright ($*) needs ${#pkgs[@]} more packages"
  if [ "${#pkgs[@]}" -gt 0 ]; then install_offline "${pkgs[@]}"; fi
  pw_dry "$@"
}

# finish: the set the next jobs restore, when this job fetched. Prints key=<cache key> (stdout).
finish() {
  local keep n mb suffix
  if [ ! -f "$WORK/fetched" ]; then
    log "nothing fetched from the archive in this job: no new set to save"
    return 0
  fi
  : "${SC_APT_DEBS_KEY:?SC_APT_DEBS_KEY is not set}"
  keep="$(mktemp)"
  sort -u "$WORK/used" >"$keep"
  if [ "$(cat "$WORK/restored-on")" = "$IMAGE" ]; then
    awk '{ print $2 }' "$WORK/restored.sha256" >>"$keep"
    sort -u -o "$keep" "$keep"
  fi
  for f in "$SET"/*.deb; do
    [ -e "$f" ] || continue
    grep -qxF "$(basename "$f")" "$keep" || "${SUDO[@]}" rm -f "$f"
  done
  write_sums
  echo "$IMAGE" >"$SET/made-on"
  n="$(grep -c . "$SET/SHA256SUMS")"
  mb="$(du -cm "$SET"/*.deb 2>/dev/null | tail -n 1 | cut -f1)"
  suffix="$(sha256sum "$SET/SHA256SUMS" | cut -c1-16)"
  log "the set for the next jobs: $n .debs (${mb:-0} MB) made on $IMAGE, key $SC_APT_DEBS_KEY$suffix"
  echo "key=$SC_APT_DEBS_KEY$suffix"
}

[ $# -gt 0 ] || { sed -n '2,10p' "$0"; exit 2; }
mode="$1"
shift
case "$mode" in
  install)
    [ $# -gt 0 ] || { echo "apt-debs.sh install: no package" >&2; exit 2; }
    ensure "$@"
    install_offline "$@"
    ;;
  download)
    [ $# -gt 0 ] || { echo "apt-debs.sh download: no package" >&2; exit 2; }
    ensure "$@"
    log "offline from here on: the job's own apt-get install of ($*) takes them from the saved set"
    ;;
  playwright-deps) playwright_deps "$@" ;;
  finish) finish ;;
  *)
    echo "apt-debs.sh: unknown mode '$mode' (install, download, playwright-deps, finish)" >&2
    exit 2
    ;;
esac
