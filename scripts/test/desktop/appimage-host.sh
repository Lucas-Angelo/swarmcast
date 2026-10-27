#!/usr/bin/env bash
# The AppImage on a minimal Linux host: a bare Ubuntu container with only the libraries the
# install guide asks for (site/src/content/docs/install/linux.md: "the usual desktop libraries
# (fonts, graphics/OpenGL)" and FUSE 2), plus a virtual display and a session bus for the test.
# Then the AppImage must start, serve its panel and quit, like in verify.mjs. The clean-machine
# test on the runner cannot show this: the runner image has Mesa, fonts and X already.
#
#   scripts/test/desktop/appimage-host.sh <dir with SwarmCast_*.AppImage> [image ...]
#
# Images default to ubuntu:22.04 and ubuntu:24.04, for the host's architecture. Needs Docker and
# Node on the host: the test runs with the host's node binary, mounted read-only (it needs only
# glibc and libstdc++, which every base image has for apt), so no package is installed for it.
# The container has no FUSE device: the AppImage runs extracted (APPIMAGE_EXTRACT_AND_RUN=1, as in
# verify.mjs); libfuse2 is installed because the guide asks for it.
# SC_DESKTOP_ARTIFACTS=<dir>: the app logs of a failed run land in <dir>/<image>/.
set -euo pipefail

dir=$(cd "$1" && pwd)
shift
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(ubuntu:22.04 ubuntu:24.04)
here=$(cd "$(dirname "$0")" && pwd)
node_bin=$(readlink -f "$(command -v node)")
node_root=$(dirname "$(dirname "$node_bin")")
ls "$dir"/*.AppImage >/dev/null

# What the install guide lists (site/src/content/docs/install/linux.md and pt-br, the same list
# as scripts/test/docker/Dockerfile.appimage): keep them in step, this is the list it proves.
GUIDE_PACKAGES='libgl1 libegl1 fontconfig fonts-dejavu-core libharfbuzz0b libfribidi0'
# For the test only (a desktop has its own display server and session bus).
TEST_PACKAGES='xvfb xauth dbus'

inner=$(cat <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update -qq
fuse=libfuse2
if apt-cache show libfuse2t64 >/dev/null 2>&1; then fuse=libfuse2t64; fi
apt-get -o Acquire::Retries=3 install -y -qq --no-install-recommends $GUIDE_PACKAGES $fuse $TEST_PACKAGES >/dev/null
echo "host packages (guide): $GUIDE_PACKAGES $fuse"
echo "host packages (test only): $TEST_PACKAGES"
export NO_AT_BRIDGE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- /opt/node/bin/node /opt/test/verify.mjs --appimage-only /in
EOF
)

failed=0
for image in "${images[@]}"; do
  echo "::group::AppImage on $image (only the documented libraries)"
  out="${SC_DESKTOP_ARTIFACTS:-}"
  logs=()
  if [ -n "$out" ]; then
    mkdir -p "$out/${image//[:\/]/-}"
    logs=(-v "$out/${image//[:\/]/-}:/out" -e SC_DESKTOP_ARTIFACTS=/out)
  fi
  # --init reaps the AppImage's children; WebKitGTK and Mesa use shared memory.
  if timeout -k 15 900 docker run --rm --init --shm-size=512m \
    -v "$dir:/in:ro" -v "$here:/opt/test:ro" -v "$node_root:/opt/node:ro" "${logs[@]}" \
    -e GUIDE_PACKAGES="$GUIDE_PACKAGES" -e TEST_PACKAGES="$TEST_PACKAGES" \
    "$image" bash -c "$inner"; then
    echo "::endgroup::"
    echo "PASS AppImage on $image"
  else
    echo "::endgroup::"
    echo "::error title=AppImage minimal host::the AppImage does not run on $image with only the documented libraries"
    failed=1
  fi
done
exit "$failed"
