#!/bin/sh
# Starts an anvil fork for pre-trade simulation (when SIM_FORK_URL is set), then the server.
set -e
if [ -n "$SIM_FORK_URL" ] && command -v anvil >/dev/null 2>&1; then
  anvil --fork-url "$SIM_FORK_URL" --port 8546 --silent &
  export SIM_RPC_URL="${SIM_RPC_URL:-http://127.0.0.1:8546}"
  sleep 2
fi
exec node server/src/index.js
