// Scheduler: recurring mandates (remittances, savings sweep), the unattended track-record run, the peg monitor,
// receipt batch anchoring and mock-oracle upkeep. Scheduled plans are templates: no model is involved.
import cron from "node-cron";
import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { remittancePlan, savingsSweepPlan, anchorBatch } from "@covenant/agent";

export function createScheduler({ ctx, store, agent, indexer, notify, log, config }) {
  const tasks = [];
  const env = process.env;
  const stamp = () => new Date().toISOString().slice(0, 19); // per-second idempotency key: one run per scheduled fire
  const run = (trigger) => indexer.runAndLog({ scenario: env.UNATTENDED === "1" ? "UR" : store.kvGet("scenarioTag"), ...trigger });

  function scheduleMandate() {
    const m = store.getMandate();
    if (!m) return;
    for (const r of m.remittances) {
      const cronExpr = env.UNATTENDED === "1" ? env.UNATTENDED_REMIT_CRON || "0 1-23/6 * * *" : r.cron;
      tasks.push(cron.schedule(cronExpr, async () => {
        const res = await run({ type: "schedule:remittance", id: `remit-${r.payee}-${stamp()}`, plan: remittancePlan(r) });
        if (res) await notify({ to: "owner", kind: "remittance", text: res.message });
      }));
    }
    tasks.push(cron.schedule(env.SWEEP_CRON || (env.UNATTENDED === "1" ? "0 2-23/6 * * *" : "0 10 * * *"), async () => {
      if (store.kvGet("yieldPaused") === "1") return;
      const state = await agent.observe();
      const plan = savingsSweepPlan(state);
      if (plan) await run({ type: "schedule:sweep", id: `sweep-${stamp()}`, plan });
    }));
  }

  function scheduleUnattended() {
    if (env.UNATTENDED !== "1" || !env.EMPLOYER_PRIVATE_KEY) return;
    // Simulated employer (demo infrastructure, clearly labelled): deposits wages on a compressed cadence.
    const employer = createWalletClient({ account: privateKeyToAccount(env.EMPLOYER_PRIVATE_KEY), chain: ctx.chain, transport: http(config.rpcUrls[0]) });
    tasks.push(cron.schedule(env.UNATTENDED_PAYDAY_CRON || "0 */6 * * *", async () => {
      try {
        const hash = await employer.writeContract({ address: ctx.tokens.USDC.address, abi: ctx.abis.erc20, functionName: "transferWithMemo", args: [ctx.vault.address, parseUnits(env.UNATTENDED_WAGE || "1000", 6), `Wages ${stamp()} (simulated employer)`] });
        log.info({ hash }, "unattended payday deposit");
      } catch (e) {
        log.error({ err: e.shortMessage ?? e.message }, "payday deposit failed");
      }
    }));
  }

  // Peg monitor: on a USD-stablecoin depeg, pull lending exposure back and pause new yield.
  async function pegCheck() {
      try {
        const state = await agent.observe();
        const usdc = state.assets.USDC;
        const bps = Math.abs(usdc.price - 1) * 10000;
        const limit = ctx.deployment.params.depegBps ?? 200;
        if (bps > limit && store.kvGet("yieldPaused") !== "1") {
          store.kvSet("yieldPaused", "1");
          await notify({ to: "owner", kind: "depeg", text: `USDC is trading at ${usdc.price.toFixed(4)} USD. Yield is paused and lent savings are being brought back.` });
          await notify({ to: "guardian", kind: "depeg", text: "Stablecoin price warning: Covenant paused savings yield." });
          if (usdc.supplied > 0n) {
            await run({ type: "price_event", id: `depeg-${stamp()}`, scenario: "D9", plan: { intent: "Withdraw lent savings during a depeg", actions: [{ type: "withdraw", asset: "USDC", amount: (Number(usdc.supplied) / 1e6).toFixed(6), bucket: "SAVINGS" }], explanation: "USDC is off its peg, so lent savings come back into the vault." } });
          }
        } else if (bps <= limit / 2 && store.kvGet("yieldPaused") === "1") {
          store.kvSet("yieldPaused", "0");
          await notify({ to: "owner", kind: "repeg", text: "USDC is back at its peg. Savings yield can resume." });
        }
      } catch (e) {
        log.warn({ err: e.message }, "peg monitor failed");
      }
  }

  function scheduleUpkeep() {
    tasks.push(cron.schedule(env.PEG_CRON || "*/5 * * * *", pegCheck));
    if (config.anchorMode === "batch") {
      tasks.push(cron.schedule("7 * * * *", async () => {
        const rows = store.unanchoredReceiptHashes();
        if (!rows.length) return;
        const res = await anchorBatch(ctx, rows.map((r) => r.receipt_hash));
        if (res) {
          store.markBatch(rows.map((r) => r.id), res.root, res.hash);
          store.recordTx({ hash: res.hash, kind: "anchorBatch", tier: "T1", outcome: "success", note: `${rows.length} receipts` });
        }
      }));
    }
    // Mock oracles on testnets need fresh timestamps; anyone may poke them.
    if (ctx.deployment.mocks?.includes("usdcOracle") && ctx.walletClient) {
      tasks.push(cron.schedule(env.POKE_CRON || "13 */12 * * *", async () => {
        for (const o of [ctx.deployment.contracts.usdcOracle, ctx.deployment.contracts.eurcOracle]) {
          try {
            const hash = await ctx.walletClient.writeContract({ address: o, abi: ctx.abis.oracle, functionName: "poke" });
            await ctx.publicClient.waitForTransactionReceipt({ hash });
          } catch (e) {
            log.warn({ err: e.shortMessage ?? e.message }, "oracle poke failed");
          }
        }
      }));
    }
  }

  return {
    start() {
      scheduleMandate();
      scheduleUnattended();
      scheduleUpkeep();
      log.info({ tasks: tasks.length, unattended: env.UNATTENDED === "1" }, "scheduler started");
    },
    reload() {
      tasks.splice(0).forEach((t) => t.stop());
      this.start();
    },
    stop: () => tasks.splice(0).forEach((t) => t.stop()),
    pegCheck,
  };
}
