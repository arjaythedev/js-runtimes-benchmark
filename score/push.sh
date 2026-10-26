#!/usr/bin/env bash
# Copies stacks from js/stacks/ on this machine to the app box and builds them there.
#   bash js/score/push.sh node-express bun-native ...     (no args = every stack)
set -euo pipefail
TARGET="${TARGET:-mc-target}"
cd "$(dirname "$0")/../stacks"
[ $# -gt 0 ] || set -- $(ls -d */ | tr -d /)
for name in "$@"; do
  COPYFILE_DISABLE=1 tar -c --no-xattrs --exclude node_modules --exclude dist --exclude .built -C . "$name" | ssh "$TARGET" \
    "rm -rf '/opt/challenge/subs/$name' && tar -x -C /opt/challenge/subs -f -"
  if ssh "$TARGET" "/opt/conduit-tools/prepare.sh '$name'" > "/tmp/js-prepare-$name.log" 2>&1; then echo "$name built"
  else echo "$name BUILD FAILED"; tail -15 "/tmp/js-prepare-$name.log"; fi
done
