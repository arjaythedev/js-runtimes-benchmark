#!/usr/bin/env bash
# Foreground: src/server.ts is a node:cluster primary that forks one worker per core.
set -euo pipefail
[ -d /opt/js/bun-1.4.4 ] && export PATH=/opt/js/bun-1.4.4:$PATH
cd "$(dirname "$0")"
export NODE_ENV=production
exec bun src/server.ts
