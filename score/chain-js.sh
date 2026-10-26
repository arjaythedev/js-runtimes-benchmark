#!/usr/bin/env bash
# JS experiment variant of the challenge chain (switch-js.sh, Postgres box monitored as "db"). Runs a batch of submissions one after another, unattended. Run ON the load generator (it has an ssh key into the
# target), under nohup. The submission folders must already be on the target in /opt/challenge/subs/<name>
# (score/push.sh).
#
#   nohup bash chain.sh batch.txt > /root/results/chain.out 2>&1 &
#
# batch.txt: one submission folder name per line ('#' comments ok). Per submission: prepare.sh (install + build) on
# the target, then `conduit-loadgen search` (switch with conformance on the full seed, warm-up, probes, holds).
# A name with results/<name>/SUMMARY.txt already is skipped, so re-launching resumes the batch.
# Progress: /root/results/chain.log, one line per step.
set -u
LIST="${1:?usage: chain.sh <batch.txt>}"
TARGET="${TARGET:-root@mc-target}"
URLS="${URLS:-http://mc-target,http://mc-target-2,http://mc-target-3,http://mc-target-4}"
MAX="${MAX:-200000}"
START="${START:-2000}"
OUT=/root/js-results
LOG="$OUT/chain.log"
export CONDUIT_JWT_SECRET=multicore-server-challenge
mkdir -p "$OUT"
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }

grep -v '^\s*#' "$LIST" | awk 'NF{print $1}' | while read -r name; do
  if [ -s "$OUT/$name/SUMMARY.txt" ]; then say "$name: already scored, skipping"; continue; fi
  say "$name: prepare"
  if ! ssh -n -o BatchMode=yes "$TARGET" "/opt/conduit-tools/prepare.sh '$name'" > "$OUT/$name.prepare.log" 2>&1; then
    say "$name: PREPARE FAILED (see $name.prepare.log)"; continue
  fi
  say "$name: search"
  "${LOADGEN:-conduit-loadgen}" search -target-ssh "$TARGET" -target-url "$URLS" -boxes "${BOXES:-local=1}" -switch /opt/conduit-tools/switch-js.sh -extra-ssh db=root@mu-lg4 -lang "$name" -label "$name" \
    -start "$START" -max "$MAX" -outdir "$OUT/$name" < /dev/null > "$OUT/$name.out" 2>&1 &
  pid=$!
  # Watchdog: the search doesn't notice a dead server (it keeps stepping holds down). Once the switch is done,
  # two checks in a row with challenge.service not active = crashed: stop the search.
  down=0; crashed=0
  while kill -0 $pid 2>/dev/null; do
    sleep 60
    grep -q 'switch ok' "$OUT/$name.out" 2>/dev/null || continue
    if ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'systemctl is-active -q challenge.service'; then down=0; else down=$((down + 1)); fi
    if [ $down -ge 2 ]; then crashed=1; kill $pid; sleep 5; pkill -f '^/usr/local/bin/[c]onduit-loadgen run'; break; fi
  done
  wait $pid; rc=$?
  if [ $crashed = 1 ]; then
    say "$name: CRASHED during the search: $(ssh -n "$TARGET" 'journalctl -u challenge.service -n 3 --no-pager -o cat' | tr '\n' ' ' | cut -c1-250)"
    continue
  fi
  if [ -s "$OUT/$name/SUMMARY.txt" ]; then
    say "$name: done rc=$rc: $(grep -m1 '^SCORE' "$OUT/$name/SUMMARY.txt")"
  else
    say "$name: SEARCH FAILED rc=$rc: $(grep -m1 -iE 'fail|error' "$OUT/$name.out" | cut -c1-200)"
  fi
  ssh -n -o BatchMode=yes "$TARGET" 'systemctl stop challenge.service' >/dev/null 2>&1
done
say "batch done"
