#!/usr/bin/env bash
# One-line-per-box health check for the JS experiment (run from the laptop). Lines starting with WARN need a look.
#   bash js/score/health.sh
chk() {  # name host remote-extra
  local out
  out=$(ssh -n -o ConnectTimeout=8 -o BatchMode=yes "$2" "
    l=\$(cut -d' ' -f1 /proc/loadavg); m=\$(awk '/MemAvailable/{print int(\$2/1024)}' /proc/meminfo)
    d=\$(df --output=pcent / | tail -1 | tr -d ' %'); oom=\$(journalctl -k --since '-15 min' -q 2>/dev/null | grep -ci 'out of memory')
    echo \"load \$l, mem_avail \${m} MB, disk \${d}%, oom15m \$oom\"; $3" 2>&1) || { echo "WARN $1: ssh failed: $out"; return; }
  local flag=OK; grep -qE 'STRAY|oom15m [1-9]|disk (9[0-9]|100)%|DOWN|FAILED|CRASHED' <<<"$out" && flag=WARN
  echo "$flag $1: $(tr '\n' ' ' <<<"$out")"
}
chk app mc-target 'm=$(ps -eo args= | grep "^bash /opt/conduit-tools/[m]onitor.sh" | sort -u | wc -l); [ "$m" -gt 1 ] && echo "STRAY $m monitors"; echo "challenge.service $(systemctl is-active challenge.service | sed s/inactive/idle/)"; curl -s -m 5 -o /dev/null -w "tags %{http_code} %{time_total}s" http://127.0.0.1/api/tags 2>/dev/null || true'
chk db  mu-lg4    'systemctl is-active -q postgresql@18-conduit && echo "pg conduit up, $(runuser -u postgres -- psql -p 5433 -qtAX -c "select count(*) from pg_stat_activity where backend_type='"'"'client backend'"'"'") conns" || echo "pg conduit DOWN"'
chk lg  mc-lg1    'echo "loadgen procs $(pgrep -c -f "^conduit-loadgen|^/usr/local/bin/conduit-loadgen")"; tail -1 /root/js-results/chain.log 2>/dev/null; f=$(ls -t /root/js-results/*.out 2>/dev/null | grep -v chain.out | head -1); [ -n "$f" ] && tail -1 "$f" | cut -c1-160'
