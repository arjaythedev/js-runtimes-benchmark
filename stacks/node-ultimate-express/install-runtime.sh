#!/usr/bin/env bash
# Installs Node.js 26.12.1 (official tarball) into /opt/js/node-26.12.1. Run as root. Idempotent.
set -euo pipefail
V=26.12.1; D=/opt/js/node-$V
[ -x "$D/bin/node" ] && exit 0
apt-get install -y -q curl xz-utils ca-certificates build-essential python3 >/dev/null
mkdir -p /opt/js; T=$(mktemp -d)
curl -fsSL "https://nodejs.org/dist/v$V/node-v$V-linux-x64.tar.xz" -o "$T/node.tar.xz"
curl -fsSL "https://nodejs.org/dist/v$V/SHASUMS256.txt" | grep " node-v$V-linux-x64.tar.xz\$" | awk '{print $1"  '"$T"'/node.tar.xz"}' | sha256sum -c -
tar -xJf "$T/node.tar.xz" -C "$T" && mv "$T/node-v$V-linux-x64" "$D" && rm -rf "$T"
"$D/bin/node" -v
