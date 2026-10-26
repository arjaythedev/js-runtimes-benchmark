#!/usr/bin/env bash
# Installs the npm packages pinned in deno.lock into ./node_modules (bcrypt ships prebuilt N-API binaries,
# so its install script is not needed) and caches the module graph.
set -euo pipefail
[ -d /opt/js/deno-2.9.8 ] && export PATH=/opt/js/deno-2.9.8:$PATH
cd "$(dirname "$0")"
deno install --frozen --entrypoint src/main.ts
