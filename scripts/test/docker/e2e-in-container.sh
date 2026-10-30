#!/usr/bin/env bash
# Runs INSIDE mcr.microsoft.com/playwright:v<version>-noble (as root), started by e2e.sh.
# /src = the repo (read-only), /out = where reports are copied.
#   PROJECTS="firefox chromium"   Playwright projects to run
set -u
set -o pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(dirname "$0")/lib.sh"
PROJECTS="${PROJECTS:-firefox chromium}"

echo "== copy the repo (without node_modules / build output)"
mkdir -p /work
tar -C /src --exclude=./node_modules --exclude='*/node_modules' --exclude=./vendor --exclude='*/dist' \
  --exclude=./test-results --exclude=./playwright-report --exclude=./release --exclude=./.claude --exclude=./.git \
  -cf - . | tar -C /work -xf -
cd /work || exit 2

echo "== system packages (ffmpeg for the synthetic OBS stream)"
apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null || exit 2
echo "node $(node --version), npm $(npm --version), ffmpeg $(ffmpeg -version | head -n1 | cut -d' ' -f3), $(uname -m)"

echo "== npm ci"
npm ci --no-audit --no-fund --loglevel=error || exit 2
echo "Playwright $(npx playwright --version)"
echo "== fetch-binaries"
node scripts/build/fetch-binaries.mjs || exit 2
echo "== build"
npm run build --silent >/tmp/build.log 2>&1 || { tail -50 /tmp/build.log; exit 2; }

echo "== codec support of the bundled browsers"
node scripts/test/docker/codec-probe.mjs

# Once Playwright has stopped the e2e web server (apps/server/test/e2e/server.ts: SIGTERM, and
# its own shutdown stops the MediaMTX and cloudflared it started before it exits), none of those
# processes runs any more: checked after every Playwright invocation, with LEFTOVER_GRACE_S for
# that shutdown. What is still running fails the run, and is then killed so the next invocation
# can bind its ports.
LEFTOVER_GRACE_S=10
LEFT_RE='vendor/linux-[a-z0-9]+/(mediamtx|cloudflared)|test/e2e/server\.ts'
LEFT_CHECKS=()
LEFT_FAILED=0
none_left() { ! pgrep -f "$LEFT_RE" >/dev/null; }
leftovers() { # leftovers LABEL
  local name="nothing of the e2e web server left running after $1" n
  if wait_for "$LEFTOVER_GRACE_S" none_left; then
    LEFT_CHECKS+=("PASS $name")
    return
  fi
  n="$(pgrep -f "$LEFT_RE" | wc -l | tr -d ' ')"
  echo "  still running $LEFTOVER_GRACE_S s after Playwright stopped the web server ($1):"
  pgrep -a -f "$LEFT_RE" | sed 's/^/    /'
  LEFT_CHECKS+=("FAIL $name ($n processes still running $LEFTOVER_GRACE_S s after Playwright stopped it)")
  LEFT_FAILED=1
  pkill -9 -f "$LEFT_RE"
  wait_for 10 none_left || echo "  still running after SIGKILL: $(pgrep -a -f "$LEFT_RE" | tr '\n' ' ')"
}

declare -A RC
for p in $PROJECTS; do
  echo
  echo "== playwright test --project=$p (scripts/test/docker/playwright.linux.config.ts)"
  # The e2e server writes its log and the fake OBS's next to outputDir (test-results/, not
  # test-results/pw, which Playwright empties): one set per project.
  rm -f test-results/e2e-server.log test-results/fake-obs.log
  npx playwright test -c scripts/test/docker/playwright.linux.config.ts --project="$p"
  RC[$p]=$?
  mkdir -p "/out/$p"
  cp -a test-results/pw "/out/$p/test-results" 2>/dev/null
  cp -a playwright-report "/out/$p/playwright-report" 2>/dev/null
  cp -a test-results/e2e-server.log test-results/fake-obs.log "/out/$p/" 2>/dev/null
  leftovers "--project=$p"
done

echo
echo "== main playwright.config.ts with PW_CHROMIUM_CHANNEL='' (does an empty value disable channel 'chrome'?)"
PW_CHROMIUM_CHANNEL='' timeout 300 npx playwright test --project=chromium -g 'opening the site without the link' --reporter=line >/tmp/empty-channel.txt 2>&1
EMPTY_RC=$?
grep -vE '^\s+at ' /tmp/empty-channel.txt | tail -n 12
leftovers "PW_CHROMIUM_CHANNEL=''"

echo
echo "=================== E2E SUMMARY ==================="
for p in $PROJECTS; do
  if [ "${RC[$p]}" = 0 ]; then echo "PASS $p"; else echo "FAIL $p (exit ${RC[$p]})"; fi
done
echo "INFO main config with PW_CHROMIUM_CHANNEL='': exit $EMPTY_RC"
printf '%s\n' "${LEFT_CHECKS[@]}"
for p in $PROJECTS; do [ "${RC[$p]}" = 0 ] || exit 1; done
[ "$LEFT_FAILED" = 0 ] || exit 1
exit 0
