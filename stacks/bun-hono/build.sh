#!/usr/bin/env bash
# Installs the pinned dependencies from bun.lock. Bun runs the TypeScript directly, so there is no compile step.
set -euo pipefail
[ -d /opt/js/bun-1.4.4 ] && export PATH=/opt/js/bun-1.4.4:$PATH
cd "$(dirname "$0")"
bun install --frozen-lockfile --production
