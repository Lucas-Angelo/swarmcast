#!/usr/bin/env bash
# Runs INSIDE mcr.microsoft.com/playwright:v<version>-noble (as root), started by e2e.sh.
# /src = the repo (read-only), /out = where reports are copied.
#   PROJECTS="firefox chromium"   Playwright projects to run
set -u
set -o pipefail
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

# Processes the e2e web server (apps/server/test/e2e/server.ts) leaves behind once Playwright
# has stopped it. Reported, then killed so the next invocation can bind its ports again.
LEFTOVER=0
LEFT_RE='vendor/linux-[a-z0-9]+/(mediamtx|cloudflared)|test/e2e/server\.ts'
leftovers() { # leftovers LABEL
  local l
  sleep 2
  l="$(pgrep -a -f "$LEFT_RE")"
  if [ -n "$l" ]; then
    echo "WARN after $1: processes left running after Playwright stopped the web server:"
    printf '%s\n' "$l" | sed 's/^/  /'
    LEFTOVER=1
    pkill -9 -f "$LEFT_RE"
    sleep 1
  fi
}

declare -A RC
for p in $PROJECTS; do
  echo
  echo "== playwright test --project=$p (scripts/test/docker/playwright.linux.config.ts)"
  npx playwright test -c scripts/test/docker/playwright.linux.config.ts --project="$p"
  RC[$p]=$?
  mkdir -p "/out/$p"
  cp -a test-results/pw "/out/$p/test-results" 2>/dev/null
  cp -a playwright-report "/out/$p/playwright-report" 2>/dev/null
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
[ "$LEFTOVER" = 1 ] && echo "WARN the e2e web server left processes running after Playwright stopped it (see above)"
for p in $PROJECTS; do [ "${RC[$p]}" = 0 ] || exit 1; done
exit 0
