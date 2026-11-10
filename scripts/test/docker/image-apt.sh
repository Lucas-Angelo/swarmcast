#!/usr/bin/env bash
# Runs INSIDE the build of a test image (the RUN step of a Dockerfile.*, as root, mounted with
# apt-retry.sh and the runner's mirror list by build.sh): installs the packages with apt-get
# through apt-retry.sh (a time limit per try, 3 tries), then removes everything that served only
# the install: apt's lists, the .debs, the settings and mirror list below. Only the packages stay.
#
#   bash /ci/image-apt.sh PKG...   PKG may be A|B: the first of A, B the distribution has
#                                  (libfuse2t64|libfuse2: Ubuntu 24.04 renamed the package)
#
# The mirrors: on a GitHub Ubuntu runner build.sh hands over the runner's own mirror list
# (/etc/apt/apt-mirrors.txt: Azure's copy of the archive first, archive.ubuntu.com and
# security.ubuntu.com after). An Ubuntu image's archive sources then go through it for this step,
# as the runner's own apt does, and apt-retry.sh drops the Azure line after a failed or slow try,
# as on the runner. Soak run 42763674289 (2026-11-10 05:47 UTC): archive.ubuntu.com still
# answered at a trickle an hour after release rehearsal 42757440898, and three tries of a
# 90 s apt-get update ran out on it, while the runner's mirrors were fast.
set -eu
MIRRORS_IN=/ci/apt/apt-mirrors.txt
MIRRORS=/etc/apt/apt-mirrors.txt
ARCHIVE_RE='http://archive\.ubuntu\.com/ubuntu/\{0,1\}'

printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "15";' 'Acquire::https::Timeout "15";' \
  'APT::Update::Error-Mode "any";' >/etc/apt/apt.conf.d/zzz-ci-retries

changed=()
if [ -s "$MIRRORS_IN" ] && grep -q '^ID=ubuntu$' /etc/os-release; then
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    if [ -f "$f" ] && grep -q "$ARCHIVE_RE" "$f"; then
      cp -p "$f" "$f.sc-orig"
      sed -i "s#$ARCHIVE_RE#mirror+file:$MIRRORS#g" "$f"
      changed+=("$f")
    fi
  done
  if [ ${#changed[@]} -gt 0 ]; then
    # A bare image has no CA certificates; apt checks the archive's signatures either way.
    sed 's#https://#http://#' "$MIRRORS_IN" >"$MIRRORS"
    echo "apt: the archive through this runner's mirrors: $(cut -f1 "$MIRRORS" | paste -sd' ' -)"
  fi
fi

bash /ci/apt-retry.sh update
pkgs=()
for p in "$@"; do
  if [[ "$p" == *'|'* ]]; then
    IFS='|' read -ra alts <<<"$p"
    pick="${alts[${#alts[@]} - 1]}"
    for a in "${alts[@]}"; do
      if apt-cache show "$a" >/dev/null 2>&1; then pick="$a"; break; fi
    done
    pkgs+=("$pick")
  else
    pkgs+=("$p")
  fi
done
bash /ci/apt-retry.sh install -y --no-install-recommends "${pkgs[@]}"

for f in ${changed[@]+"${changed[@]}"}; do mv -f "$f.sc-orig" "$f"; done
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb "$MIRRORS" /etc/apt/apt.conf.d/zzz-ci-retries
