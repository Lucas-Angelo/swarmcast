#!/usr/bin/env bash
# Section 1: tests the REAL release (start-linux.sh + SwarmCast-vX-linux-*.tar.gz) in Linux
# containers. Run it on a machine with Docker (tested with Docker Desktop on an arm64 Mac).
#
#   scripts/test/docker/run.sh [options] [TARGET...]
#
# TARGET is an image, optionally with "@amd64" to run it as linux/amd64 (emulated on arm64).
# Default targets: ubuntu:22.04 ubuntu:24.04 debian:12 ubuntu:24.04@amd64
#
# Options:
#   --release DIR     Release folder (default: $RELEASE_DIR, or <main checkout>/release)
#   --serial          Run the targets one after another (default: in parallel)
#   --no-build        Reuse the images built by a previous run
#   --no-tunnel-test  Skip the real Cloudflare quick tunnel test
#   --tunnel-all      Run the tunnel test on every target (default: only the first one)
#   --tunnel-only     Only run the tunnel test (d)
#   --tunnel-docker-dns  Use Docker's own DNS in the tunnel container (default: 1.1.1.1 / 1.0.0.1;
#                     Docker Desktop's resolver caches the new host's NXDOMAIN, see README)
#   --skip-speedtest  Pass --skip-speedtest to the first install too
#   --clean           Remove the images this script built when done
#
# For each target:
#   a. bare image (no curl, no sudo): the script must explain what to install and stop
#   b. bare image + passwordless sudo: the script must install curl itself and pass the smoke test
#   c. full image: install-test.sh (install + real smoke test, up to date, corrupted checksum,
#      normal start + RTMP + curl viewer, SIGINT / SIGTERM shutdown)
#   d. (first target) the real quick tunnel: the https://*.trycloudflare.com link must answer
#      /healthz from this host, and stop answering after Ctrl+C.
set -u
set -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"

RELEASE="${RELEASE_DIR:-}"
SERIAL=0
BUILD=1
TUNNEL=1
TUNNEL_ALL=0
TUNNEL_DNS="1.1.1.1 1.0.0.1"
TUNNEL_ONLY=0
SKIP_SPEED=0
CLEAN=0
TARGETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="$2"; shift ;;
    --serial) SERIAL=1 ;;
    --no-build) BUILD=0 ;;
    --no-tunnel-test) TUNNEL=0 ;;
    --tunnel-all) TUNNEL_ALL=1 ;;
    --tunnel-docker-dns) TUNNEL_DNS="" ;;
    --tunnel-only) TUNNEL_ONLY=1 ;;
    --skip-speedtest) SKIP_SPEED=1 ;;
    --clean) CLEAN=1 ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) TARGETS+=("$1") ;;
  esac
  shift
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(ubuntu:22.04 ubuntu:24.04 debian:12 ubuntu:24.04@amd64)

if [ -z "$RELEASE" ]; then
  common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  for c in "$ROOT/release" "${common%/.git}/release"; do
    [ -f "$c/SHA256SUMS.txt" ] && { RELEASE="$c"; break; }
  done
fi
[ -n "$RELEASE" ] && [ -f "$RELEASE/SHA256SUMS.txt" ] && [ -f "$RELEASE/start-linux.sh" ] ||
  { echo "Release folder not found (need SHA256SUMS.txt and start-linux.sh). Use --release DIR." >&2; exit 2; }
RELEASE="$(cd "$RELEASE" && pwd)"
VERSION="$(sed -nE 's/^[0-9a-f]{64} [ *]?SwarmCast-v([0-9]+\.[0-9]+\.[0-9]+)-linux-arm64\.tar\.gz$/\1/p' "$RELEASE/SHA256SUMS.txt" | head -n1)"
[ -n "$VERSION" ] || { echo "No linux-arm64 package in $RELEASE/SHA256SUMS.txt" >&2; exit 2; }

ID="$$"
NET="sc-test-net-$ID"
SERVER="sc-test-release-$ID"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sc-docker.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
BUILT_IMAGES=()

cleanup() {
  local c
  for c in $(docker ps -aq --filter "name=-$ID\$"); do docker rm -f "$c" >/dev/null 2>&1; done
  docker rm -f "$SERVER" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  if [ "$CLEAN" = 1 ] && [ ${#BUILT_IMAGES[@]} -gt 0 ]; then
    docker rmi "${BUILT_IMAGES[@]}" >/dev/null 2>&1
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "Release:  $RELEASE (v$VERSION)"
echo "Targets:  ${TARGETS[*]}"

# --- corrupted release: SHA256SUMS.txt lists a NEWER version with a wrong checksum ------------
mkdir -p "$WORK/corrupt"
cp "$RELEASE/start-linux.sh" "$WORK/corrupt/"
for arch in arm64 x64; do
  real="$(grep -E " [ *]?SwarmCast-v$VERSION-linux-$arch\.tar\.gz$" "$RELEASE/SHA256SUMS.txt" | cut -c1-64)"
  [ -n "$real" ] || continue
  # Flip the first hex digit: a valid-looking but wrong checksum.
  first="${real:0:1}"; if [ "$first" = 0 ]; then wrong="1${real:1}"; else wrong="0${real:1}"; fi
  printf '%s  SwarmCast-v99.0.0-linux-%s.tar.gz\n' "$wrong" "$arch" >>"$WORK/corrupt/SHA256SUMS.txt"
  ln -s "/srv/ok/SwarmCast-v$VERSION-linux-$arch.tar.gz" "$WORK/corrupt/SwarmCast-v99.0.0-linux-$arch.tar.gz"
done

# --- release server on a private Docker network ----------------------------------------------
docker network create "$NET" >/dev/null || exit 2
docker run -d --name "$SERVER" --network "$NET" --network-alias release \
  -v "$RELEASE:/srv/ok:ro" -v "$WORK/corrupt:/srv/corrupt:ro" \
  python:3.12-alpine python -m http.server 8000 -d /srv >/dev/null || exit 2
RELEASE_URL="http://release:8000/ok"
CORRUPT_URL="http://release:8000/corrupt"

tag_of() { # ubuntu:24.04@amd64 -> ubuntu-24.04-amd64
  local t="${1%@*}"
  t="${t//[:\/]/-}"
  case "$1" in *@amd64) t="$t-amd64" ;; esac
  printf '%s' "$t"
}
platform_of() { case "$1" in *@amd64) echo linux/amd64 ;; *) echo "linux/$(docker version -f '{{.Server.Arch}}')" ;; esac; }

build() { # build DOCKERFILE IMAGE BASE PLATFORM [build-args...]
  local df="$1" img="$2" base="$3" plat="$4"
  shift 4
  if [ "$BUILD" = 1 ]; then
    docker build -q --platform "$plat" -f "$DIR/$df" --build-arg "BASE=$base" "$@" -t "$img" "$DIR" >/dev/null ||
      { echo "build of $img failed"; return 1; }
  fi
}

# run_target TARGET LOGFILE RESULTFILE
run_target() {
  local target="$1" log="$2" res="$3" base plat tag out rc r
  base="${target%@*}"
  plat="$(platform_of "$target")"
  tag="$(tag_of "$target")"
  exec >"$log" 2>&1
  echo "##### $target ($plat)"
  build Dockerfile.bare "swarmcast-test-bare:$tag" "$base" "$plat" || { echo "$target|build|FAIL" >>"$res"; return; }
  build Dockerfile.bare "swarmcast-test-bare:$tag-sudo" "$base" "$plat" --build-arg WITH_SUDO=1 || { echo "$target|build|FAIL" >>"$res"; return; }
  build Dockerfile.install "swarmcast-test-install:$tag" "$base" "$plat" || { echo "$target|build|FAIL" >>"$res"; return; }

  local envs=(-e "SWARMCAST_RELEASE_URL=$RELEASE_URL" -e "SWARMCAST_HOME=/tmp/sc-home" -e NO_COLOR=1)

  echo
  echo "=== a. bare image, no curl, no sudo"
  out="$(docker run --rm --platform "$plat" --network "$NET" -v "$RELEASE:/release:ro" "${envs[@]}" \
    "swarmcast-test-bare:$tag" bash /release/start-linux.sh --yes --no-tunnel --smoke-test 2>&1)"
  rc=$?
  printf '%s\n' "$out" | sed 's/^/  | /'
  if [ "$rc" != 0 ] && grep -qF "Missing required tools: curl" <<<"$out" && grep -qF "Please install these tools" <<<"$out"; then r=PASS; else r=FAIL; fi
  echo "$r a. no curl, no sudo -> explains and stops (exit $rc)"
  echo "$target|a. no curl, no sudo|$r" >>"$res"

  echo
  echo "=== b. bare image, no curl, passwordless sudo (--yes)"
  out="$(docker run --rm --platform "$plat" --network "$NET" -v "$RELEASE:/release:ro" "${envs[@]}" \
    "swarmcast-test-bare:$tag-sudo" bash /release/start-linux.sh --yes --no-tunnel --skip-speedtest --smoke-test 2>&1)"
  rc=$?
  printf '%s\n' "$out" | grep -vE '^(Get|Hit|Selecting|Preparing|Unpacking|Setting up|Processing|Reading|Building|\(Reading)' | sed 's/^/  | /'
  if [ "$rc" = 0 ] && grep -qF "Installed: curl" <<<"$out" && grep -qF "Smoke test passed." <<<"$out"; then r=PASS; else r=FAIL; fi
  echo "$r b. no curl + sudo -> installs curl via apt-get, smoke test passes (exit $rc)"
  echo "$target|b. no curl + sudo apt-get|$r" >>"$res"

  echo
  echo "=== c. full image: install-test.sh"
  docker run --rm --platform "$plat" --network "$NET" --name "sc-test-c-$tag-$ID" \
    -v "$RELEASE:/release:ro" -v "$DIR:/tests:ro" \
    -e "RELEASE_URL=$RELEASE_URL" -e "CORRUPT_URL=$CORRUPT_URL" -e "EXPECT_VER=$VERSION" -e "SKIP_SPEED=$SKIP_SPEED" \
    "swarmcast-test-install:$tag" bash /tests/install-test.sh
  rc=$?
  if [ "$rc" = 0 ]; then r=PASS; else r=FAIL; fi
  echo "$target|c. install-test.sh|$r" >>"$res"
}

# tunnel_test TARGET LOGFILE RESULTFILE
tunnel_test() {
  local target="$1" log="$2" res="$3" plat tag c link base i code hdr r=PASS
  plat="$(platform_of "$target")"
  tag="$(tag_of "$target")"
  c="sc-test-tunnel-$tag-$ID"
  exec >"$log" 2>&1
  echo "##### quick tunnel on $target"
  local dns=()
  # Docker Desktop's resolver caches the NXDOMAIN of the brand-new trycloudflare host for the
  # zone's 60 s negative TTL, longer than the app waits (see README). Public resolvers avoid it.
  [ -n "$TUNNEL_DNS" ] && for d in $TUNNEL_DNS; do dns+=(--dns "$d"); done
  echo "container DNS: ${TUNNEL_DNS:-Docker default}"
  docker run -d --platform "$plat" --network "$NET" --name "$c" -v "$RELEASE:/release:ro" ${dns[@]+"${dns[@]}"} \
    "swarmcast-test-install:$tag" sleep infinity >/dev/null || { echo "$target|d. quick tunnel|FAIL" >>"$res"; return; }
  docker exec -d -e "SWARMCAST_RELEASE_URL=$RELEASE_URL" -e SWARMCAST_HOME=/tmp/sc-home -e NO_COLOR=1 "$c" \
    bash -c 'echo $$ >/tmp/app.pid; exec bash /release/start-linux.sh --yes --skip-speedtest >/tmp/app.log 2>&1 </dev/null'
  link=""
  for i in $(seq 1 90); do
    link="$(docker exec "$c" grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com/join/[A-Za-z0-9_-]+' /tmp/app.log 2>/dev/null | head -n1)"
    [ -n "$link" ] && break
    sleep 2
  done
  if [ -z "$link" ]; then
    echo "FAIL no trycloudflare link after 180 s"; docker exec "$c" cat /tmp/app.log | sed 's/^/  | /'
    echo "$target|d. quick tunnel|FAIL" >>"$res"; docker rm -f "$c" >/dev/null; return
  fi
  base="${link%/join/*}"
  echo "link printed after ~$((i * 2)) s: $base/join/<secret>"
  code=""
  for i in $(seq 1 30); do
    hdr="$(curl -sS -D - -o /dev/null --max-time 15 "$base/healthz" 2>&1)"
    code="$(printf '%s' "$hdr" | awk 'toupper($1) ~ /^HTTP/ { c = $2 } END { print c }')"
    [ "$code" = 200 ] && break
    sleep 2
  done
  echo "host: GET $base/healthz -> ${code:-no answer}"
  printf '%s\n' "$hdr" | grep -iE '^(HTTP|x-swarmcast|server|cf-ray)' | sed 's/^/  < /'
  if [ "$code" = 200 ] && printf '%s' "$hdr" | grep -qi '^x-swarmcast:'; then echo "ok: 200 + x-swarmcast header from the host"; else echo "FAIL: expected 200 + x-swarmcast"; r=FAIL; fi
  code="$(curl -s -o /dev/null --max-time 15 -w '%{http_code} %{redirect_url}' "$link")"
  echo "host: GET <live link> -> $code"
  case "$code" in "303 $base/join") echo "ok: live link redirects to /join through the tunnel" ;; *) echo "FAIL: live link"; r=FAIL ;; esac

  docker exec "$c" bash -c 'kill -INT "$(cat /tmp/app.pid)"'
  for i in $(seq 1 45); do
    docker exec "$c" bash -c 'kill -0 "$(cat /tmp/app.pid)" 2>/dev/null' || break
    sleep 1
  done
  docker exec "$c" cat /tmp/app.log | sed 's/^/  | /'
  if docker exec "$c" grep -qF "Off: nothing on your computer is reachable" /tmp/app.log; then echo "ok: printed Off line"; else echo "FAIL: no Off line"; r=FAIL; fi
  if docker exec "$c" pgrep -a -f '/app/current/(swarmcast|bin/mediamtx|bin/cloudflared)'; then echo "FAIL: processes left"; r=FAIL; else echo "ok: no mediamtx/cloudflared/swarmcast left"; fi
  code=""
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "$base/healthz")"
    [ "$code" != 200 ] && break
    sleep 2
  done
  echo "host after stop: GET $base/healthz -> $code (after ~$((i * 2)) s)"
  if [ "$code" != 200 ]; then echo "ok: the tunnel URL stopped answering"; else echo "FAIL: still answering 60 s after stop"; r=FAIL; fi
  docker rm -f "$c" >/dev/null
  echo "$r d. quick tunnel"
  echo "$target|d. quick tunnel|$r" >>"$res"
}

RES="$WORK/results.txt"
: >"$RES"
pids=()
logs=()
n=0
for t in "${TARGETS[@]}"; do
  n=$((n + 1))
  BUILT_IMAGES+=("swarmcast-test-bare:$(tag_of "$t")" "swarmcast-test-bare:$(tag_of "$t")-sudo" "swarmcast-test-install:$(tag_of "$t")")
  log="$WORK/log-$n.txt"
  logs+=("$log")
  : >"$log"
  if [ "$TUNNEL_ONLY" = 1 ]; then
    build Dockerfile.install "swarmcast-test-install:$(tag_of "$t")" "${t%@*}" "$(platform_of "$t")"
    continue
  fi
  if [ "$SERIAL" = 1 ]; then
    (run_target "$t" "$log" "$RES"); cat "$log"
  else
    (run_target "$t" "$log" "$RES") &
    pids+=($!)
  fi
done
if [ "$SERIAL" != 1 ] && [ "$TUNNEL_ONLY" != 1 ]; then
  echo "Running ${#TARGETS[@]} targets in parallel..."
  for p in "${pids[@]}"; do wait "$p"; done
  for l in "${logs[@]}"; do cat "$l"; echo; done
fi

if [ "$TUNNEL" = 1 ]; then
  for t in "${TARGETS[@]}"; do
    (tunnel_test "$t" "$WORK/tunnel.txt" "$RES"); cat "$WORK/tunnel.txt"; echo
    [ "$TUNNEL_ALL" = 1 ] || break
  done
fi

echo "=================== SUMMARY (release v$VERSION) ==================="
fails=0
while IFS='|' read -r t name r; do
  printf '%-6s %-22s %s\n' "$r" "$t" "$name"
  [ "$r" = PASS ] || fails=$((fails + 1))
done <"$RES"
grep -h '^RESULT ' "${logs[@]}" | sed 's/^/  /'
[ "$fails" = 0 ] && echo "All passed." || echo "$fails failed."
[ "$fails" = 0 ]
