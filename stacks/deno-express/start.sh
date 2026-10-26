#!/usr/bin/env bash
# node:cluster on Deno's Node compatibility layer: the primary forks one worker per core
# (os.availableParallelism()); each worker opens its own postgres.js pool of floor(90 / workers) connections.
# -A: Deno spawns cluster workers as `deno run -A ...` whatever the primary was given, and the primary needs
# --allow-run on the deno binary to fork them, so narrower flags here would only be decoration.
set -euo pipefail
[ -d /opt/js/deno-2.9.8 ] && export PATH=/opt/js/deno-2.9.8:$PATH
cd "$(dirname "$0")"
export NODE_ENV=production NO_COLOR=1
exec deno run --frozen --cached-only -A src/main.ts
