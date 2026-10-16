# Covenant server image: Node 22 + anvil (for fork simulation).
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Foundry's anvil is run (not shipped in the app bundle) for pre-trade simulation on a fork.
RUN curl -L https://foundry.paradigm.xyz | bash && /root/.foundry/bin/foundryup --install stable
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
