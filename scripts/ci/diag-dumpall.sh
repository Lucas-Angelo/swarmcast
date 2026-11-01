#!/bin/bash
# DIAG only: diag-dumpall.sh OUT TITLE - every live WebKit process: state, then all thread stacks (gdb, sudo).
OUT=$1
command -v gdb >/dev/null || sudo apt-get install -y -qq gdb >/dev/null 2>&1
{ date -u; echo "test: $2"; ps -eo pid,ppid,stat,wchan:30,etime,comm,args | grep -E "WPE|MiniBrowser|WebKit" | grep -v grep; } > "$OUT"
for pid in $(ps -eo pid,stat,comm | awk '$2 !~ /Z/ && $3 ~ /WPEWebProcess|WPENetworkProce|MiniBrowser|WebKitWebProce|WebKitNetworkP/ {print $1}'); do
  echo "===== PID $pid $(tr '\0' ' ' < /proc/$pid/cmdline | cut -c1-160) wchan=$(cat /proc/$pid/wchan)" >> "$OUT"
  sudo timeout 60 gdb -p "$pid" -batch -ex "set pagination off" -ex "thread apply all bt 40" >> "$OUT" 2>&1
done
echo "DIAG dumped $OUT"
