#!/usr/bin/env bash
# The JS experiment's switch: like the challenge's score/switch.sh, but Postgres lives on its own box (mu-lg4,
# cluster 18/conduit on :5433) and every stack serves direct on :80. Run as root on the app box
# (installed as /opt/conduit-tools/switch-js.sh; `loadgen search -switch /opt/conduit-tools/switch-js.sh -lang <stack>`).
#
#   switch-js.sh node-express                    # conformance on the full seed, then a fresh DB and start
#   switch-js.sh node-express --no-conformance
#
# Steps: stop challenge.service, local Postgres and Nginx (nothing else on the app box uses CPU) -> /opt/challenge/current
# -> /etc/challenge/env -> fresh `conduit` from `conduit_seed` on the DB box -> [conformance, fresh DB again] ->
# restart the DB cluster + drop its page cache -> drop the app box's page cache -> start -> wait for GET /api/tags.
set -euo pipefail
NAME="${1:?usage: switch-js.sh <stack> [--no-conformance]}"
CONFORMANCE=1; [ "${2:-}" = --no-conformance ] && CONFORMANCE=0
SUB="/opt/challenge/subs/$NAME"
UNIT=challenge.service
CONF_BIN=/opt/conduit-tools/conformance
JWT_SECRET=multicore-server-challenge
# a stack folder ending in -h2c is the HTTP/2 side test: its server may speak only cleartext HTTP/2 (prior knowledge),
# so readiness uses curl --http2-prior-knowledge and conformance runs over h2c (the js/bench conformance build)
CURL=(curl -sf -m 2 -o /dev/null); CONF_FLAGS=()
case "$NAME" in *-h2c) CURL+=(--http2-prior-knowledge); CONF_BIN=/opt/conduit-tools/conformance-js; CONF_FLAGS=(-h2c) ;; esac
PGBOX="${PGBOX:-root@mu-lg4}"; PGHOST_IP="${PGBOX#*@}"; PGPORT=5433; PGCLUSTER=postgresql@18-conduit
say() { printf '[switch %s %s] %s\n' "$NAME" "$(date +%T)" "$*"; }
[ -f "$SUB/start.sh" ] || { echo "no $SUB/start.sh"; exit 1; }
[ -f "$SUB/.built" ] || { echo "$SUB not built (prepare.sh $NAME first)"; exit 1; }
pg() { ssh -n -o BatchMode=yes "$PGBOX" "$@"; }
PSQL="runuser -u postgres -- psql -p $PGPORT -qX -v ON_ERROR_STOP=1"

fresh_db() {
  pg "$PSQL -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('conduit','conduit_seed') AND pid <> pg_backend_pid()\" >/dev/null &&
      $PSQL -c 'DROP DATABASE IF EXISTS conduit WITH (FORCE)' -c 'CREATE DATABASE conduit TEMPLATE conduit_seed STRATEGY FILE_COPY' >/dev/null"
}
wait_ready() {
  local t0=$SECONDS
  while [ $((SECONDS - t0)) -lt 60 ]; do
    "${CURL[@]}" http://127.0.0.1/api/tags && return 0
    systemctl is-active -q "$UNIT" || break
    sleep 0.5
  done
  say "NOT READY after $((SECONDS - t0)) s (unit $(systemctl is-active "$UNIT"))"; journalctl -u "$UNIT" -n 40 --no-pager; exit 1
}
stop_app() {
  systemctl stop "$UNIT" 2>/dev/null || true
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  for _ in $(seq 1 40); do ss -ltnH '( sport = :80 )' | grep -q . || return 0; sleep 0.5; done
  say "something still listens on :80"; ss -ltnp '( sport = :80 )'; exit 1
}

say "app box: $(hostname), $(nproc) vCPU, $(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo) MiB, kernel $(uname -r)"
say "DB box: $PGBOX:$PGPORT ($(pg 'nproc') vCPU)"
say "stopping $UNIT, local Postgres, Nginx"; stop_app
# monitors orphaned by a killed search keep sampling forever (one ran 2 days, ~20% of a core): clear them on both boxes
pkill -f '^bash /opt/conduit-tools/monitor.sh' 2>/dev/null || true
pg "pkill -f '^bash /opt/conduit-tools/monitor.sh'" || true
systemctl stop nginx postgresql@18-main postgresql 2>/dev/null || true
pg "systemctl stop postgresql@18-main; systemctl start $PGCLUSTER"   # the DB box's other cluster stays off during runs

ln -sfn "$SUB" /opt/challenge/current
umask 027
{
  echo "DATABASE_URL=postgres://conduit:conduit@$PGHOST_IP:$PGPORT/conduit"
  echo "JWT_SECRET=$JWT_SECRET"
  echo "HOST=0.0.0.0"
  echo "PORT=80"
} > /etc/challenge/env.new
chgrp challenge /etc/challenge/env.new && mv /etc/challenge/env.new /etc/challenge/env
umask 022

say "fresh database conduit from conduit_seed"; t=$(date +%s); fresh_db; say "  done in $(( $(date +%s) - t )) s"
if [ "$CONFORMANCE" = 1 ]; then
  say "conformance on the full seed, through port 80"
  systemctl start "$UNIT"; wait_ready
  if ! "$CONF_BIN" -base http://127.0.0.1 -secret "$JWT_SECRET" -q "${CONF_FLAGS[@]}" > "/root/conformance-$NAME.txt" 2>&1; then
    cat "/root/conformance-$NAME.txt"; say "CONFORMANCE FAILED: not benchmarking this"; stop_app; exit 1
  fi
  tail -3 "/root/conformance-$NAME.txt"
  stop_app
  say "reset database after conformance"; fresh_db
fi

say "restart the DB cluster, drop page caches on both boxes"
pg "systemctl restart $PGCLUSTER && for _ in \$(seq 30); do runuser -u postgres -- pg_isready -q -p $PGPORT && break; sleep 1; done; sync; echo 3 > /proc/sys/vm/drop_caches"
sync; echo 3 > /proc/sys/vm/drop_caches

say "starting $UNIT"; t0=$(date +%s%N)
systemctl start "$UNIT"; wait_ready
say "ready after $(( ($(date +%s%N) - t0) / 1000000 )) ms"
sleep 3
cgdir="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$UNIT")"
pss=0
for p in $(cat "$cgdir/cgroup.procs"); do
  k=$(awk '$1=="Pss:"{print $2}' "/proc/$p/smaps_rollup" 2>/dev/null); pss=$((pss + ${k:-0}))
done
echo "---- /etc/challenge/env"; grep -v '^JWT_SECRET' /etc/challenge/env
echo "---- idle app memory: PSS $((pss / 1024)) MB, $(wc -l < "$cgdir/cgroup.procs") process(es)"
echo "---- $(systemctl status "$UNIT" --no-pager -n0 | sed -n '1p;3p' | xargs)"
say "READY"
