#!/usr/bin/env bash
# Installs Deno 2.9.8 (official release zip) into /opt/js/deno-2.9.8. Run as root. Idempotent.
set -euo pipefail
V=2.9.8; D=/opt/js/deno-$V
[ -x "$D/deno" ] && exit 0
apt-get install -y -q curl unzip ca-certificates build-essential python3 >/dev/null
mkdir -p "$D"; T=$(mktemp -d)
curl -fsSL "https://github.com/denoland/deno/releases/download/v$V/deno-x86_64-unknown-linux-gnu.zip" -o "$T/deno.zip"
unzip -q "$T/deno.zip" -d "$D" && rm -rf "$T"
"$D/deno" --version | head -1
