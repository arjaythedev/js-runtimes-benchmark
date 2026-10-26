#!/usr/bin/env bash
# Foreground: src/cluster.ts spawns one src/server.ts per core (reusePort: true).
set -euo pipefail
[ -d /opt/js/bun-1.4.4 ] && export PATH=/opt/js/bun-1.4.4:$PATH
cd "$(dirname "$0")"
export NODE_ENV=production
exec bun src/cluster.ts
