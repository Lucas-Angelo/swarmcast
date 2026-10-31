#!/usr/bin/env bash
# The parts of fetch-artifact (action.yml) that do not go through actions/download-artifact.
#
#   rest.sh diagnose TRY   what a failed download-artifact try ran into, from this runner
#   rest.sh fetch          the fallback: the same artifacts through the REST API and curl
#
# Environment (from action.yml): NAME or PATTERN, DEST, MERGE (true/false), RUN_ID, REPO, TOKEN
# (needs actions: read), and for `fetch` FETCH_TRIES (default 4) and FETCH_BUDGET (seconds,
# default 240: no new try starts after that).
#
# Why: download-artifact prints only "Artifact download failed after 5 retries." Its retry loop
# logs the cause with core.debug, which a run shows only with step debug logging on, so a failure
# named nothing. `diagnose` asks the same blob storage the same question with two other clients:
# Node.js's https (the runtime download-artifact uses, probe.mjs) and curl, and prints the
# resolver's answer, every stage's timing, the HTTP status and Azure's error code and request id.
# `fetch` then gets the artifacts by another route: the REST API's own signed URL
# (GET /repos/{repo}/actions/artifacts/{id}/zip, a 302 to the blob), downloaded by curl, resumed
# with a range request after a cut, checked against the size and SHA-256 digest the API recorded
# at upload, and only then unzipped where download-artifact would have put it.
set -u

API="${GITHUB_API_URL:-https://api.github.com}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURL_TIMES='http=%{http_code} ip=%{remote_ip} dns=%{time_namelookup}s tcp=%{time_connect}s tls=%{time_appconnect}s first-byte=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download} speed=%{speed_download}B/s curl-exit=%{exitcode}'

# One log line; control characters (CR, LF, ESC...) in what the API, curl or Azure said become
# spaces, so no answer can forge a log line or a workflow command.
say() { printf 'fetch-artifact: %s\n' "$(printf '%s' "$*" | tr '\000-\037\177' ' ')"; }

# curl to the REST API: bounded, retried on any error (its own short outages).
api() {
  curl -sS --connect-timeout 15 --max-time 60 --retry 3 --retry-all-errors --retry-delay 5 \
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

diagnose() {
  local try="$1" rows n=0 url host body
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
    n=$((n + 1))
    local id name size digest expired
    id="$(jq -r .id <<<"$row")" name="$(jq -r .name <<<"$row")" size="$(jq -r .size <<<"$row")"
    digest="$(jq -r .digest <<<"$row")" expired="$(jq -r .expired <<<"$row")"
    say "artifact $name: id $id, $size bytes, digest ${digest:-none}, expired $expired"
    # Probe at most three artifacts; the rest of a pattern goes the same way.
    [ "$n" -le 3 ] || continue
    url="$(signed_url "$id")" || continue
    host="$(host_of "$url")"
    say "blob URL: $(bare "$url")"
    say "resolver ($RUNNER_OS) for $host: $(resolver "$host")"
    # curl: the first 8 MiB, so a probe costs seconds, not the whole file.
    body="$(mktemp)"
    say "curl: $(curl -sS -o "$body" -r 0-8388607 --connect-timeout 15 --max-time 30 -w "$CURL_TIMES" "$url" 2>&1 | tr '\n' ' ')"
    if [ "$(file_size "$body")" -lt 4096 ] && grep -q '<Error>' "$body" 2>/dev/null; then
      say "blob storage said: $(tr -d '\r\n' <"$body" | head -c 600)"
    fi
    rm -f "$body"
    # Node.js: a whole-file GET like download-artifact's, stopped after 8 MiB.
    node "$HERE/probe.mjs" "$url" 2>&1 | sed 's/^/fetch-artifact: node: /' || true
  done <<<"$rows"
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

# Download one artifact into DIR: up to FETCH_TRIES curl tries, each with a fresh signed URL,
# resuming the partial file; a file of the wrong size or digest is thrown away and fetched again.
fetch_one() {
  local id="$1" name="$2" size="$3" digest="$4" dir="$5"
  local zip="$TMP_DIR/$id.zip" try=0 url got hash wait
  : >"$zip"
  while :; do
    try=$((try + 1))
    if url="$(signed_url "$id")"; then
      got="$(file_size "$zip")"
      [ "$got" -gt 0 ] && say "$name: try $try resumes at byte $got of $size"
      say "$name: try $try: $(curl -sS -o "$zip" -C - --connect-timeout 20 --speed-limit 102400 --speed-time 30 \
        --max-time 300 -w "$CURL_TIMES" "$url" 2>&1 | tr '\n' ' ')"
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
    if [ "$try" -ge "$TRIES" ] || [ "$((SECONDS - START + wait))" -gt "$BUDGET" ]; then
      echo "::error::fetch-artifact: $name: the REST fallback gave up after $try tries and $((SECONDS - START)) s"
      return 1
    fi
    say "$name: try $try did not finish; next try in $wait s"
    sleep "$wait"
  done
}

fetch() {
  local rows ok=0 failed=0
  START=$SECONDS TRIES="${FETCH_TRIES:-4}" BUDGET="${FETCH_BUDGET:-240}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  rows="$(list_artifacts)" || { echo "::error::fetch-artifact: the REST fallback could not list the artifacts"; return 1; }
  if [ -z "$rows" ]; then
    echo "::error::fetch-artifact: no artifact of run $RUN_ID matches '${NAME:-$PATTERN}'"
    return 1
  fi
  local out="$DEST"
  [ "${RUNNER_OS:-}" = Windows ] && out="$(cygpath -u "$out")"
  while IFS= read -r row; do
    local id name size digest expired dir
    id="$(jq -r .id <<<"$row")" name="$(jq -r .name <<<"$row")" size="$(jq -r .size <<<"$row")"
    digest="$(jq -r .digest <<<"$row")" expired="$(jq -r .expired <<<"$row")"
    if [ "$expired" = true ]; then
      echo "::error::fetch-artifact: $name (id $id) has expired"
      failed=$((failed + 1))
      continue
    fi
    # Where download-artifact puts it: path itself for a name or merge-multiple, else path/<name>.
    dir="$out"
    [ -z "$NAME" ] && [ "$MERGE" != true ] && dir="$out/$name"
    if fetch_one "$id" "$name" "$size" "$digest" "$dir"; then ok=$((ok + 1)); else failed=$((failed + 1)); fi
  done <<<"$rows"
  if [ "$failed" -gt 0 ]; then
    echo "::error::fetch-artifact: the REST fallback got $ok of $((ok + failed)) artifacts"
    return 1
  fi
  echo "::warning::fetch-artifact: infra recovery: download-artifact failed twice; the REST fallback (curl, digest checked) got ${NAME:-$PATTERN} ($ok artifact(s)) in $((SECONDS - START)) s"
}

case "${1:-}" in
  diagnose) diagnose "${2:-?}" ;;
  fetch) fetch ;;
  *) echo "usage: rest.sh diagnose TRY | fetch" >&2; exit 2 ;;
esac
