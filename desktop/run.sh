#!/bin/bash
# LaunchAgent entry point for the HermesOffice bridge.
#
# LaunchAgents get no login shell, so PATH is not inherited. Resolve node from
# a list of known locations rather than hardcoding one — a node upgrade that
# moves the binary would otherwise leave the bridge silently dead.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"

NODE=""
for candidate in \
  "$HOME/.hermes/node/bin/node" \
  "$HOME/.homebrew/bin/node" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$(command -v node 2>/dev/null || true)"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE="$candidate"
    break
  fi
done

if [ -z "$NODE" ]; then
  echo "hermesoffice-bridge: no node interpreter found" >&2
  exit 127
fi

exec "$NODE" "$DIR/server.mjs" "$@"
