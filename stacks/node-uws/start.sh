#!/usr/bin/env bash
set -euo pipefail
[ -d /opt/js/node-26.12.1/bin ] && export PATH=/opt/js/node-26.12.1/bin:$PATH
cd "$(dirname "$0")"
export NODE_ENV=production
exec node dist/index.js
