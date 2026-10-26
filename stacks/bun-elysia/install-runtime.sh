#!/usr/bin/env bash
# Installs Bun 1.4.4 (official release zip) into /opt/js/bun-1.4.4. Run as root. Idempotent.
set -euo pipefail
V=1.4.4; D=/opt/js/bun-$V
[ -x "$D/bun" ] && exit 0
apt-get install -y -q curl unzip ca-certificates >/dev/null
mkdir -p "$D"; T=$(mktemp -d)
curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$V/bun-linux-x64.zip" -o "$T/bun.zip"
unzip -q "$T/bun.zip" -d "$T" && mv "$T/bun-linux-x64/bun" "$D/bun" && rm -rf "$T"
ln -sf bun "$D/bunx"
"$D/bun" --version
