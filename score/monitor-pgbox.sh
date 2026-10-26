#!/usr/bin/env bash
# Server-side sampler for benchmark runs (installed at /opt/conduit-tools/monitor.sh by score/install-tools.sh). Only /proc, cgroup v2
# files and one psql query per sample. No agents or daemons. Run as root; it's built to run for hours.
#
#   monitor.sh                      # CSV to stdout every 1 s
#   monitor.sh 1 /root/run-x.csv    # every 1 s, appended to a file (header written once)
#
# Columns (CSV):
#   ts            unix time (s, ms precision) at the end of the sample; time = HH:MM:SS
#   cpu steal iow  whole-box busy % (user+nice+sys+irq+softirq), steal %, iowait %, from /proc/stat
#   load1
#   app_core pg_core ngx_core   CPU of the app / Postgres / Nginx systemd unit cgroup in % of ONE core
#                               (cpu.stat usage_usec over wall time; 800 = 8 cores fully busy)
#   app_box pg_box ngx_box      the same in % of the WHOLE box (x_core / nproc)
#   mem_used mem_avail          MB, /proc/meminfo (used = MemTotal - MemAvailable)
#   app_pss                     MB, PSS summed over every process in the app's cgroup
#   disk_r disk_w               KB/s on the root disk
#   net_rx net_tx               KB/s on the default-route interface (the load arrives on the VPC interface:
#                               see vpc_rx/vpc_tx)
#   vpc_rx vpc_tx               KB/s on the private (10.116/20) interface
#   pg_active pg_total          client backends running a query / connected (the monitor's own excluded)
#
# The app unit is challenge.service (the submission); empty while it is stopped.
set -u
INTERVAL="${1:-1}"
OUT="${2:-/dev/stdout}"
NCPU="$(nproc)"
DISK="$(lsblk -ndo NAME,TYPE | awk '$2=="disk"{print $1; exit}')"
IFACE="$(ip -o -4 route show to default | awk '{print $5; exit}')"
VPC_IF="$(ip -o -4 addr show | awk '$4 ~ /^10\.116\./{print $2; exit}')"; VPC_IF="${VPC_IF:-$IFACE}"
PG_UNIT="${PG_UNIT:-postgresql@18-conduit.service}"

cg() { local g; g="$(systemctl show -p ControlGroup --value "$1" 2>/dev/null)"; [ -n "$g" ] && echo "/sys/fs/cgroup$g" || echo /nonexistent; }
app_unit() { systemctl is-active -q challenge.service && echo challenge.service; }
cg_usec() { local v; v="$(awk '$1=="usage_usec"{print $2}' "$1/cpu.stat" 2>/dev/null)"; echo "${v:-0}"; }
cg_pss() { local t=0 k p; for p in $(cat "$1/cgroup.procs" 2>/dev/null); do k=$(awk '$1=="Pss:"{print $2}' "/proc/$p/smaps_rollup" 2>/dev/null); t=$((t + ${k:-0})); done; echo $((t / 1024)); }
read_cpu() { awk '/^cpu /{print $2+$3+$4+$7+$8, $6, $9, $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat; }   # busy iowait steal total
read_disk() { awk -v d="$DISK" '$3==d{print $6*512, $10*512}' /proc/diskstats; }
read_net() { awk -v i="$1:" '$1==i{print $2, $10}' /proc/net/dev; }
now_usec() { echo "${EPOCHREALTIME/./}"; }
# One persistent psql session (a new connection per sample would cost Postgres a fork every second);
# restarted automatically if Postgres restarts.
PGQ="select count(*) filter (where state='active') || ' ' || count(*) from pg_stat_activity where backend_type='client backend' and pid <> pg_backend_pid();"
pg_start() { coproc PG { exec runuser -u postgres -- psql -p "${PGPORT:-5433}" -qtAX 2>/dev/null; }; }
trap 'exit 0' INT TERM HUP
trap '[ -n "${PG_PID:-}" ] && kill "$PG_PID" 2>/dev/null; pkill -P $$ psql 2>/dev/null' EXIT
pg_conns() {  # sets PGLINE="active total" (client backends except this one); no subshell: the coproc must persist
  local line=""
  [ -n "${PG_PID:-}" ] && kill -0 "$PG_PID" 2>/dev/null || pg_start
  { echo "$PGQ" >&"${PG[1]}"; } 2>/dev/null && read -r -t 2 line <&"${PG[0]}" 2>/dev/null
  if [ -z "$line" ]; then kill "${PG_PID:-0}" 2>/dev/null; PG_PID=""; fi
  PGLINE="$line"
}

APP_UNIT="$(app_unit)"; APP_CG="$(cg "${APP_UNIT:-none}")"; PG_CG="$(cg $PG_UNIT)"; NGX_CG="$(cg nginx.service)"
echo "# $(hostname) ${NCPU} vCPU; app=${APP_UNIT:-none} disk=$DISK if=$IFACE vpc=$VPC_IF interval=${INTERVAL}s" >&2
HDR="ts,time,cpu,steal,iow,load1,app_core,pg_core,ngx_core,app_box,pg_box,ngx_box,mem_used,mem_avail,app_pss,disk_r,disk_w,net_rx,net_tx,vpc_rx,vpc_tx,pg_active,pg_total,app_unit"
if [ "$OUT" = /dev/stdout ] || [ ! -s "$OUT" ]; then echo "$HDR" >> "$OUT"; fi

read -r b0 w0 s0 t0 <<<"$(read_cpu)"; read -r dr0 dw0 <<<"$(read_disk)"
read -r rx0 tx0 <<<"$(read_net "$IFACE")"; read -r vr0 vt0 <<<"$(read_net "$VPC_IF")"
a0=$(cg_usec "$APP_CG"); p0=$(cg_usec "$PG_CG"); x0=$(cg_usec "$NGX_CG"); u0=$(now_usec)
n=0
next=$(( $(now_usec) ))
step=$(awk -v i="$INTERVAL" 'BEGIN{print int(i*1e6)}')
while :; do
  # fixed schedule (no drift from the sampling work itself)
  next=$((next + step)); rem=$((next - $(now_usec)))
  if [ "$rem" -gt 0 ]; then sleep "$(printf '%d.%06d' $((rem / 1000000)) $((rem % 1000000)))"; else next=$(now_usec); fi
  # re-resolve units every 5 samples (app switched / restarted, Postgres restarted -> new cgroup is same path)
  n=$((n + 1))
  if [ $((n % 5)) -eq 0 ] || [ ! -d "$APP_CG" ]; then
    u="$(app_unit)"
    if [ "$u" != "$APP_UNIT" ]; then APP_UNIT="$u"; APP_CG="$(cg "${APP_UNIT:-none}")"; a0=$(cg_usec "$APP_CG"); fi
  fi
  read -r b1 w1 s1 t1 <<<"$(read_cpu)"; read -r dr1 dw1 <<<"$(read_disk)"
  read -r rx1 tx1 <<<"$(read_net "$IFACE")"; read -r vr1 vt1 <<<"$(read_net "$VPC_IF")"
  a1=$(cg_usec "$APP_CG"); p1=$(cg_usec "$PG_CG"); x1=$(cg_usec "$NGX_CG"); u1=$(now_usec)
  pg_conns; read -r pga pgt <<<"$PGLINE"
  pss="$(cg_pss "$APP_CG")"
  read -r mu ma <<<"$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{print int((t-a)/1024), int(a/1024)}' /proc/meminfo)"
  load1="$(cut -d' ' -f1 /proc/loadavg)"; printf -v hms '%(%H:%M:%S)T' -1
  awk -v OFS=, -v ts="$u1" -v hms="$hms" -v ncpu="$NCPU" -v unit="${APP_UNIT:--}" -v load1="$load1" \
      -v db="$((b1-b0))" -v dw="$((w1-w0))" -v ds="$((s1-s0))" -v dt="$((t1-t0))" \
      -v da="$((a1-a0))" -v dp="$((p1-p0))" -v dx="$((x1-x0))" -v du="$((u1-u0))" \
      -v ddr="$((dr1-dr0))" -v ddw="$((dw1-dw0))" -v drx="$((rx1-rx0))" -v dtx="$((tx1-tx0))" -v dvr="$((vr1-vr0))" -v dvt="$((vt1-vt0))" \
      -v mu="$mu" -v ma="$ma" -v pss="$pss" -v pga="${pga:-}" -v pgt="${pgt:-}" 'BEGIN {
    if (dt <= 0) dt = 1; if (du <= 0) du = 1; if (da < 0) da = 0; if (dp < 0) dp = 0; if (dx < 0) dx = 0
    s = du / 1e6
    ac = da * 100 / du; pc = dp * 100 / du; xc = dx * 100 / du
    print sprintf("%.3f", ts / 1e6), hms, sprintf("%.1f", db*100/dt), sprintf("%.1f", ds*100/dt), sprintf("%.1f", dw*100/dt), load1,
          sprintf("%.1f", ac), sprintf("%.1f", pc), sprintf("%.1f", xc),
          sprintf("%.1f", ac/ncpu), sprintf("%.1f", pc/ncpu), sprintf("%.1f", xc/ncpu),
          mu, ma, pss, int(ddr/1024/s), int(ddw/1024/s), int(drx/1024/s), int(dtx/1024/s), int(dvr/1024/s), int(dvt/1024/s),
          pga, pgt, unit
  }' >> "$OUT"
  b0=$b1; w0=$w1; s0=$s1; t0=$t1; dr0=$dr1; dw0=$dw1; rx0=$rx1; tx0=$tx1; vr0=$vr1; vt0=$vt1; a0=$a1; p0=$p1; x0=$x1; u0=$u1
done
