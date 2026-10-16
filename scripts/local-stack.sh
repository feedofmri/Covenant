#!/usr/bin/env bash
# Starts the whole stack locally without Docker: chain, deploy, server, web. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT
(cd contracts && npx hardhat node > ../data-hardhat.log 2>&1) &
npx wait-on -t 60000 tcp:127.0.0.1:8545
npm run deploy:local
DEPLOYMENT=localhost AGENT_PRIVATE_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 ADMIN_TOKEN=dev \
  DB_PATH=data/localhost.sqlite node server/src/index.js &
npx wait-on -t 60000 http://127.0.0.1:8787/health
(cd web && npx vite --host 127.0.0.1) &
echo ""
echo "  Covenant is running:  web http://127.0.0.1:5173   api http://127.0.0.1:8787"
echo "  Run the demo:         npm run demo      (in another terminal)"
echo ""
wait
