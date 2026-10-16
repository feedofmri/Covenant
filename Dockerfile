# Covenant server image: Node 22 + anvil (for fork simulation).
# The full bookworm image already ships curl, git, python3, make and g++ (needed if better-sqlite3 compiles).
FROM node:22-bookworm AS base
# Foundry's anvil is run (not shipped in the app bundle) for pre-trade simulation on a fork.
# --build-arg INSTALL_ANVIL=0 skips it (the server then simulates with eth_call).
ARG INSTALL_ANVIL=1
RUN if [ "$INSTALL_ANVIL" = "1" ]; then curl -L https://foundry.paradigm.xyz | bash && /root/.foundry/bin/foundryup --install stable; fi
ENV PATH="/root/.foundry/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
COPY contracts/package.json contracts/
COPY shared/package.json shared/
COPY agent/package.json agent/
COPY server/package.json server/
COPY redteam/package.json redteam/
COPY web/package.json web/
RUN npm ci --workspace server --workspace agent --workspace shared --include-workspace-root=false
COPY shared shared
COPY agent agent
COPY server server
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/covenant.sqlite
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8787/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
