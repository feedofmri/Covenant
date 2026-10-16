// Covenant server: one process with the agent, indexer, scheduler, API and Telegram bot.
import pino from "pino";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, createChainContext, createModel, createAgent } from "@covenant/agent";
import { loadDeployment, Mandate, hashCanonical } from "@covenant/shared";
import { openDb, createSqliteStore } from "./db.js";
import { createIndexer } from "./indexer.js";
import { createScheduler } from "./scheduler.js";
import { createApi } from "./api.js";
import { createNotifier } from "./notify.js";
import { createBot } from "./bot/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function startServer(overrides = {}) {
  const log = pino({ level: process.env.LOG_LEVEL || "info", redact: { paths: ["*.privateKey", "*.agentPrivateKey", "*.token", "headers.authorization", "headers['x-admin-token']"], censor: "[redacted]" } });
  const config = loadConfig(overrides);
  if (config.model.provider === "hijacked") throw new Error("MODEL_PROVIDER=hijacked is red-team only and cannot run the server");
  const deployment = loadDeployment(config.deployment);
  const ctx = createChainContext(config, deployment);
  const store = createSqliteStore(openDb(overrides.dbPath ?? process.env.DB_PATH ?? `data/${config.deployment}.sqlite`));

  // First boot: seed payees and the mandate from the deployment.
  if (!store.listPayees().length) for (const p of deployment.payees) store.upsertPayee({ id: p.id, alias: p.alias, address: p.address, purpose: "", addedAt: null });
  if (!store.getMandate()) {
    const file = path.join(here, "..", "..", "shared", "mandates", `${config.deployment}.json`);
    if (existsSync(file)) {
      const m = Mandate.parse(JSON.parse(readFileSync(file, "utf8")));
      store.setMandate(m, hashCanonical(m));
      for (const p of m.payees) store.upsertPayee({ id: deployment.payees.find((d) => d.alias === p.alias)?.id, alias: p.alias, address: p.address, purpose: p.purpose, addedAt: null });
    }
  }

  const notify = createNotifier({ store, log });
  const model = createModel(config.model);
  const agent = createAgent({ ctx, config, store, model, notify });
  const indexer = createIndexer({ ctx, store, agent, notify, log, confirmations: deployment.chainId === 31337 ? 0 : Number(process.env.CONFIRMATIONS ?? 1), pollMs: deployment.chainId === 31337 ? 1000 : 4000 });
  const scheduler = createScheduler({ ctx, store, agent, indexer, notify, log, config });
  const app = await createApi({ ctx, store, agent, model, indexer, scheduler, notify, log, config });

  let bot = null;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    bot = createBot({ token: process.env.TELEGRAM_BOT_TOKEN, store, agent, webUrl: process.env.WEB_URL || "http://localhost:5173", log, ctx });
    notify.attachBot(bot);
    bot.start();
  }
  if (overrides.indexer !== false) indexer.start();
  if (overrides.scheduler !== false) scheduler.start();
  const port = Number(overrides.port ?? process.env.PORT ?? 8787);
  await app.listen({ port, host: process.env.HOST || "0.0.0.0" });
  log.info({ port, deployment: config.deployment, vault: deployment.contracts.vault, model: config.model.provider, agent: ctx.account?.address }, "covenant server ready");
  return { app, ctx, store, agent, indexer, scheduler, bot, stop: async () => { indexer.stop(); scheduler.stop(); bot?.stop(); await app.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
