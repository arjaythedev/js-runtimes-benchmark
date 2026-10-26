#!/usr/bin/env bash
# One `deno serve --parallel` process running DENO_JOBS isolates (one per core). The isolates share one listening
# socket and race to accept connections (deno serve's load-balanced listener; not SO_REUSEPORT, on Linux too).
# Each isolate opens its own postgres.js pool of floor(90 / DENO_JOBS) connections.
# Permissions: net (Postgres; deno serve grants the listen address itself), env, and read/ffi for the bcrypt N-API
# addon (node-gyp-build reads the package dir and, on Linux, probes /etc/alpine-release for the libc).
set -euo pipefail
[ -d /opt/js/deno-2.9.8 ] && export PATH=/opt/js/deno-2.9.8:$PATH
cd "$(dirname "$0")"
export DENO_JOBS="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
export NODE_ENV=production NO_COLOR=1
exec deno serve --parallel --frozen --cached-only --host "$HOST" --port "$PORT" \
  --allow-net --allow-env --allow-read=.,/etc/alpine-release --allow-ffi=./node_modules \
  src/main.ts
