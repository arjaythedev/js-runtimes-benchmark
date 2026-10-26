#!/usr/bin/env bash
# Generates the HTTP/2 side-test stacks: js/stacks/<name> -> js/stacks/<name>-h2c (gitignored), identical code with
# `export H2C=1` in start.sh. Then push them like any stack: bash js/score/push.sh node-fastify-h2c ...
set -euo pipefail
cd "$(dirname "$0")/../stacks"
for n in "${@:-node-fastify node-hono node-native bun-native deno-native}"; do
  for name in $n; do
    rm -rf "$name-h2c"; rsync -a --exclude node_modules --exclude dist --exclude .built "$name/" "$name-h2c/"
    sed -i.bak 's/^exec /export H2C=1  # HTTP\/2 side test: cleartext h2 (prior knowledge)\nexec /' "$name-h2c/start.sh" && rm "$name-h2c/start.sh.bak"
    grep -q '^export H2C=1' "$name-h2c/start.sh" || { echo "$name: no exec line in start.sh"; exit 1; }
    echo "$name-h2c"
  done
done
