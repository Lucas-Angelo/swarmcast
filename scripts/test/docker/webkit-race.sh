#!/usr/bin/env bash
# Inside the container of webkit.sh race: COPIES harnesses per pattern at once (each with its own
# Xvfb), then one JSON line per harness and the totals. Exit 1 if any harness had a load that never
# committed in the end (or a load that failed).
#   webkit-race.sh COPIES "PATTERN..." [webkit_coop.py options...]
set -u
copies="$1"
read -ra patterns <<<"$2"
shift 2
out="$(mktemp -d)"
k=0
pids=()
for p in "${patterns[@]}"; do
  for ((i = 1; i <= copies; i++)); do
    k=$((k + 1))
    # Own WebKit data and cache folders: copies sharing one lock each other's HSTS database.
    home="$(mktemp -d)"
    XDG_DATA_HOME="$home/data" XDG_CACHE_HOME="$home/cache" xvfb-run -n $((100 + k)) python3 /tests/webkit_coop.py --pattern "$p" "$@" >"$out/$p-$i.json" 2>"$out/$p-$i.err" &
    pids+=($!)
  done
done
rc=0
for pid in "${pids[@]}"; do wait "$pid" || rc=1; done
for f in "$out"/*.json; do
  # The harness's own lines (its result, stalls, recoveries, failures; xvfb-run sends the
  # program's stderr to stdout), without GTK's and Mesa's noise.
  cat "$f" "${f%.json}.err" | grep -v -E 'dbind-WARNING|libEGL|^$|^\(webkit_coop\.py:' | head -40
done
python3 - "$out" <<'EOF' || rc=1
import glob, json, sys
tot = {}
missing = 0
for f in glob.glob(sys.argv[1] + '/*.json'):
    lines = [l for l in open(f) if l.startswith('{')]
    try:
        r = json.loads(lines[-1])
    except (IndexError, ValueError):
        print(f'no result in {f} (the harness died)')
        missing += 1
        continue
    t = tot.setdefault(r['pattern'], {})
    for k, v in r.items():
        if isinstance(v, int) and not isinstance(v, bool):
            t[k] = max(t.get(k, 0), v) if k in ('max_commit_ms', 'seconds') else t.get(k, 0) + v
for p, t in tot.items():
    print('TOTAL', p, json.dumps(t))
sys.exit(1 if missing else 0)
EOF
exit "$rc"
