#!/usr/bin/env bash
# Installs the pinned dependencies from package-lock.json and type-checks the TypeScript.
# Node 26 runs the .ts sources directly (built-in type stripping), so there is no emit step.
set -euo pipefail
[ -d /opt/js/node-26.12.1/bin ] && export PATH=/opt/js/node-26.12.1/bin:$PATH
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
npx tsc --noEmit
