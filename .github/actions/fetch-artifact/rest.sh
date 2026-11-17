#!/usr/bin/env bash
# The parts of fetch-artifact (action.yml) that do not go through actions/download-artifact.
#
#   rest.sh diagnose TRY   what a failed download-artifact try ran into, from this runner (at
#                          most DIAG_S seconds)
#   rest.sh fetch          try 2: the same artifacts through the REST API and curl, within a
#                          budget that follows their size
#
# Environment (from action.yml): NAME or PATTERN, DEST, MERGE (true/false), RUN_ID, REPO, TOKEN
# (needs actions: read), and for `fetch` FETCH_TRIES (curl tries, default 4) and FETCH_MAX_S
# (the caller's max-try-seconds: a cap on the budget, counted from the start of the fetch).
#
# Why: download-artifact prints only "Artifact download failed after 5 retries." Its retry loop
# logs the cause with core.debug, which a run shows only with step debug logging on, so a failure
# named nothing. `diagnose` asks the same blob storage the same question with two other clients:
# Node.js's https (the runtime download-artifact uses, probe.mjs) and curl, and prints the
# resolver's answer, every stage's timing, the HTTP status and Azure's error code and request id.
# `fetch` then gets the artifacts by another route: the REST API's own signed URL
# (GET /repos/{repo}/actions/artifacts/{id}/zip, a 302 to the blob), downloaded by curl, cut when
# it stalls and resumed with a range request, checked against the size and SHA-256 digest the API
# recorded at upload, and only then unzipped where download-artifact would have put it.
set -u

# The limits of try 1 (download.mjs; fetch-artifact.test.ts checks that they are the same): the
# budget is LIMIT_BASE_S, PER_ARTIFACT_S for each artifact and the bytes at RATE_FLOOR_BPS. Every
# request gets at most what is left of it, so try 2 ends within its budget, stalled or not.
RATE_FLOOR_BPS=4000000
LIMIT_BASE_S=45
PER_ARTIFACT_S=1
# The listing before the budget is known; the whole of the diagnostics.
LIST_S=30
DIAG_S=45
# A curl download slower than STALL_BPS for STALL_S seconds has stalled: it is cut and resumed.
STALL_BPS=102400
STALL_S=30
# The end of the current budget, as a value of $SECONDS.
DEADLINE=$((SECONDS + LIST_S))

API="${GITHUB_API_URL:-https://api.github.com}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURL_TIMES='http=%{http_code} ip=%{remote_ip} dns=%{time_namelookup}s tcp=%{time_connect}s tls=%{time_appconnect}s first-byte=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download} speed=%{speed_download}B/s curl-exit=%{exitcode}'

# One log line; control characters (CR, LF, ESC...) in what the API, curl or Azure said become
# spaces, so no answer can forge a log line or a workflow command.
say() { printf 'fetch-artifact: %s\n' "$(printf '%s' "$*" | tr '\000-\037\177' ' ')"; }

# Seconds left before DEADLINE, at most $1, never below 0.
left() {
  local l=$((DEADLINE - SECONDS))
  [ "$l" -le "$1" ] || l="$1"
  [ "$l" -ge 0 ] || l=0
  echo "$l"
}

# curl to the REST API: each request at most 20 s, tried again on any error (its own short
# outages) while the budget lasts, never past DEADLINE.
api() {
  local t m retry=()
  t="$(left 60)"
  if [ "$t" -lt 3 ]; then
    say "no time left for the REST API" >&2
    return 1
  fi
  m=$((t < 20 ? t : 20))
  [ $((t - m)) -ge 5 ] && retry=(--retry 3 --retry-all-errors --retry-delay 5 --retry-max-time $((t - m)))
  curl -sS --connect-timeout 10 --max-time "$m" ${retry[@]+"${retry[@]}"} \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# The run's artifacts that NAME or PATTERN selects, as JSON lines (id, name, size, digest,
# expired), the newest per name (a re-run can upload a name again). PATTERN is a glob with the
# download-artifact syntax used here: *, ? and {a,b}.
list_artifacts() {
  local page=1 out body code all="[]"
  out="$(mktemp)"
  while :; do
    local q="per_page=100&page=$page"
    [ -n "$NAME" ] && q="$q&name=$NAME"
    code="$(api -o "$out" -w '%{http_code}' "$API/repos/$REPO/actions/runs/$RUN_ID/artifacts?$q")" || code="${code:-000}"
    body="$(cat "$out")"
    if [ "$code" != 200 ]; then
      say "listing the artifacts of run $RUN_ID: HTTP $code: $(head -c 300 <<<"$body")" >&2
      rm -f "$out"
      return 1
    fi
    all="$(jq -c --argjson prev "$all" '$prev + .artifacts' <<<"$body")"
    [ "$(jq '.artifacts | length' <<<"$body")" -lt 100 ] && break
    page=$((page + 1))
  done
  rm -f "$out"
  jq -c --arg name "$NAME" --arg pattern "$PATTERN" '
    def glob2re: reduce (split("")[]) as $c ({d: 0, s: "^"};
      if $c == "*" then .s += "[^/]*"
      elif $c == "?" then .s += "[^/]"
      elif $c == "{" then .d += 1 | .s += "("
      elif $c == "}" and .d > 0 then .d -= 1 | .s += ")"
      elif $c == "," and .d > 0 then .s += "|"
      elif ("\\.^$|()[]+{}" | index($c)) != null then .s += "\\" + $c
      else .s += $c end) | .s + "$";
    (if $name != "" then null else ($pattern | glob2re) end) as $re
    | map(select(if $re == null then .name == $name else (.name | test($re)) end))
    | group_by(.name) | map(max_by(.id))[]
    | {id, name, size: .size_in_bytes, digest: (.digest // ""), expired}' <<<"$all"
}

# The blob URL the REST API signs for artifact ID (the Location of its 302), on stdout.
signed_url() {
  local res code loc
  res="$(api -o /dev/null -w '%{http_code} %{redirect_url}' "$API/repos/$REPO/actions/artifacts/$1/zip")" || true
  code="${res%% *}" loc="${res#* }"
  if [ "$code" != 302 ] || [ -z "$loc" ] || [ "$loc" = "$res" ]; then
    say "GET /actions/artifacts/$1/zip: HTTP ${code:-none}, no redirect" >&2
    return 1
  fi
  echo "$loc"
}

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

file_size() { wc -c <"$1" | tr -d ' '; }

host_of() { sed -E 's#^https?://([^/:?]+).*#\1#' <<<"$1"; }

# The URL without its query string (the signature), for logs.
bare() { echo "${1%%\?*}"; }

resolver() {
  local host="$1"
  case "${RUNNER_OS:-}" in
    macOS) dscacheutil -q host -a name "$host" 2>&1 | grep -E 'address' | tr '\n' ' ' ;;
    Linux) getent ahosts "$host" 2>&1 | awk '{print $1}' | sort -u | tr '\n' ' ' ;;
    Windows) nslookup "$host" 2>&1 | tail -n +3 | tr -s ' \r\n' ' ' ;;
  esac
  echo
}

# The budget of try 2 for the artifacts in ROWS (JSON lines), in seconds: what try 1 has
# (download.mjs, tryLimitMs), capped by FETCH_MAX_S.
fetch_budget() {
  local rows="$1" count bytes budget
  count="$(grep -c . <<<"$rows")"
  bytes="$(jq -s 'map(.size) | add // 0' <<<"$rows")"
  budget=$((LIMIT_BASE_S + PER_ARTIFACT_S * count + (bytes + RATE_FLOOR_BPS - 1) / RATE_FLOOR_BPS))
  if [ -n "${FETCH_MAX_S:-}" ] && [ "$FETCH_MAX_S" -gt 0 ] && [ "$FETCH_MAX_S" -lt "$budget" ]; then budget="$FETCH_MAX_S"; fi
  echo "$budget"
}

diagnose() {
  local try="$1" rows url host body t
  DEADLINE=$((SECONDS + DIAG_S))
  echo "::group::fetch-artifact diagnostics after failed try $try (${NAME:-$PATTERN})"
  say "$(date -u +%FT%TZ) runner ${RUNNER_NAME:-?} (${RUNNER_OS:-?} ${RUNNER_ARCH:-?}, image ${ImageOS:-?} ${ImageVersion:-?})"
  say "$(curl --version | head -n 1)"
  say "node $(node --version 2>/dev/null || echo 'not found')"
  if ! rows="$(list_artifacts)"; then
    echo "::endgroup::"
    return 0
  fi
  [ -n "$rows" ] || say "no artifact of run $RUN_ID matches '${NAME:-$PATTERN}'"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    say "artifact $(jq -r '"\(.name): id \(.id), \(.size) bytes, digest \(if .digest == "" then "none" else .digest end), expired \(.expired)"' <<<"$row")"
  done <<<"$rows"
  # The probes ask for the first artifact only: the others are on the same blob storage, and the
  # diagnostics must leave try 2 its time.
  if [ -n "$rows" ] && url="$(signed_url "$(head -n 1 <<<"$rows" | jq -r .id)")"; then
    host="$(host_of "$url")"
    say "blob URL: $(bare "$url")"
    say "resolver ($RUNNER_OS) for $host: $(resolver "$host")"
    # curl: the first 8 MiB, so a probe costs seconds, not the whole file.
    body="$(mktemp)"
    t="$(left 15)"
    [ "$t" -ge 1 ] && say "curl: $(curl -sS -o "$body" -r 0-8388607 --connect-timeout "$t" --max-time "$t" -w "$CURL_TIMES" "$url" 2>&1 | tr '\n' ' ')"
    if [ "$(file_size "$body")" -lt 4096 ] && grep -q '<Error>' "$body" 2>/dev/null; then
      say "blob storage said: $(tr -d '\r\n' <"$body" | head -c 600)"
    fi
    rm -f "$body"
    # Node.js: a whole-file GET like download-artifact's, stopped after 8 MiB or what is left.
    t="$(left 15)"
    [ "$t" -ge 1 ] && { node "$HERE/probe.mjs" "$url" "$t" 2>&1 | sed 's/^/fetch-artifact: node: /' || true; }
  fi
  echo "::endgroup::"
}

# unzip ZIP into DIR: Info-ZIP where there is one, else Windows's own bsdtar (Git Bash's GNU tar
# cannot read zip).
extract() {
  local zip="$1" dir="$2"
  mkdir -p "$dir"
  if command -v unzip >/dev/null; then
    unzip -o -q "$zip" -d "$dir"
  elif [ -x /c/Windows/System32/tar.exe ]; then
    /c/Windows/System32/tar.exe -xf "$(cygpath -w "$zip")" -C "$(cygpath -w "$dir")"
  else
    say "no unzip on this runner" >&2
    return 1
  fi
}

# Download one artifact into DIR: up to TRIES curl tries within the budget (DEADLINE), each with
# a fresh signed URL, resuming the partial file; a file of the wrong size or digest is thrown
# away and fetched again.
fetch_one() {
  local id="$1" name="$2" size="$3" digest="$4" dir="$5"
  local zip="$TMP_DIR/$id.zip" try=0 url got hash wait t
  : >"$zip"
  while :; do
    try=$((try + 1))
    if url="$(signed_url "$id")"; then
      got="$(file_size "$zip")"
      [ "$got" -gt 0 ] && say "$name: try $try resumes at byte $got of $size"
      t="$(left 100000)"
      if [ "$t" -ge 1 ]; then
        say "$name: try $try (at most $t s): $(curl -sS -o "$zip" -C - --connect-timeout "$((t < 20 ? t : 20))" \
          --speed-limit "$STALL_BPS" --speed-time "$STALL_S" --max-time "$t" -w "$CURL_TIMES" "$url" 2>&1 | tr '\n' ' ')"
      fi
      got="$(file_size "$zip")"
      if [ "$got" = "$size" ]; then
        hash="$(sha256 "$zip")"
        if [ -z "$digest" ] || [ "sha256:$hash" = "$digest" ]; then
          say "$name: $got bytes, sha256:$hash ${digest:+(matches the digest recorded at upload)}"
          extract "$zip" "$dir" || return 1
          rm -f "$zip"
          return 0
        fi
        say "$name: sha256:$hash is not the recorded $digest; starting over"
        : >"$zip"
      elif [ "$got" -gt "$size" ]; then
        say "$name: $got bytes, more than the $size recorded; starting over"
        : >"$zip"
      fi
    fi
    wait=$((15 * try))
    if [ "$try" -ge "$TRIES" ] || [ "$((SECONDS + wait + 5))" -ge "$DEADLINE" ]; then
      say "$name: try 2 gave up after $try curl tries and $((SECONDS - START)) s of its $BUDGET s (got $(file_size "$zip") of $size bytes)"
      return 1
    fi
    say "$name: curl try $try did not finish; next one in $wait s"
    sleep "$wait"
  done
}

# An artifact that is not there (or expired) is no infrastructure failure: action.yml says so.
missing() { [ -z "${GITHUB_OUTPUT:-}" ] || echo "missing=true" >>"$GITHUB_OUTPUT"; }

fetch() {
  local rows ok=0 failed=0 count
  START=$SECONDS TRIES="${FETCH_TRIES:-4}" BUDGET=$LIST_S
  DEADLINE=$((SECONDS + LIST_S))
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  rows="$(list_artifacts)" || { say "try 2 could not list the artifacts"; return 1; }
  if [ -z "$rows" ]; then
    echo "::error::fetch-artifact: no artifact of run $RUN_ID matches '${NAME:-$PATTERN}'"
    missing
    return 1
  fi
  BUDGET="$(fetch_budget "$rows")"
  DEADLINE=$((START + BUDGET))
  count="$(grep -c . <<<"$rows")"
  say "try 2 of 2 (REST API and curl): $count artifact(s), $(jq -s 'map(.size) | add' <<<"$rows") bytes, $BUDGET s from its start"
  local out="$DEST"
  [ "${RUNNER_OS:-}" = Windows ] && out="$(cygpath -u "$out")"
  while IFS= read -r row; do
    local id name size digest expired dir
    id="$(jq -r .id <<<"$row")" name="$(jq -r .name <<<"$row")" size="$(jq -r .size <<<"$row")"
    digest="$(jq -r .digest <<<"$row")" expired="$(jq -r .expired <<<"$row")"
    if [ "$expired" = true ]; then
      echo "::error::fetch-artifact: $name (id $id) has expired"
      missing
      failed=$((failed + 1))
      continue
    fi
    # Where download-artifact puts it: path itself for a name, merge-multiple or a pattern that
    # matches one artifact, else path/<name>.
    dir="$out"
    [ -z "$NAME" ] && [ "$MERGE" != true ] && [ "$count" -gt 1 ] && dir="$out/$name"
    if fetch_one "$id" "$name" "$size" "$digest" "$dir"; then ok=$((ok + 1)); else failed=$((failed + 1)); fi
  done <<<"$rows"
  if [ "$failed" -gt 0 ]; then
    say "try 2 got $ok of $((ok + failed)) artifacts"
    return 1
  fi
  echo "::warning::fetch-artifact: infra recovery: try 1 (download-artifact) failed; try 2 (REST API and curl, digest checked) got ${NAME:-$PATTERN} ($ok artifact(s)) in $((SECONDS - START)) s"
}

case "${1:-}" in
  diagnose) diagnose "${2:-?}" ;;
  fetch) fetch ;;
  *) echo "usage: rest.sh diagnose TRY | fetch" >&2; exit 2 ;;
esac
