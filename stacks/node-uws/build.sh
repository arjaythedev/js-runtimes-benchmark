#!/usr/bin/env bash
set -euo pipefail
[ -d /opt/js/node-26.12.1/bin ] && export PATH=/opt/js/node-26.12.1/bin:$PATH
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
rm -rf dist
npx tsc
