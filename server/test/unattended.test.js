// The unattended track-record run with a compressed cadence (seconds instead of hours): the simulated employer
// pays wages, the indexer allocates them, the scheduler sends remittances and sweeps savings, untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_KEYS } from "@covenant/shared/dev-accounts.js";

const RPC = "http://127.0.0.1:8545";
let up = false;
try {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  up = (await r.json()).result === "0x7a69";
} catch { up = false; }

test("unattended run: wages → allocation → remittance → sweep, with no human input", { skip: up ? false : "no local node", timeout: 120000 }, async () => {
  Object.assign(process.env, {
    UNATTENDED: "1", EMPLOYER_PRIVATE_KEY: DEV_KEYS.employer, UNATTENDED_WAGE: "1000",
    UNATTENDED_PAYDAY_CRON: "*/6 * * * * *", UNATTENDED_REMIT_CRON: "3,9,15,21,27,33,39,45,51,57 * * * * *",
    SWEEP_CRON: "4,10,16,22,28,34,40,46,52,58 * * * * *", PEG_CRON: "0 0 1 1 *", POKE_CRON: "0 0 1 1 *",
  });
  const { startServer } = await import("../src/index.js");
  const server = await startServer({ deployment: "localhost", rpcUrls: [RPC], agentPrivateKey: DEV_KEYS.agent, dbPath: ":memory:", port: 0, anchorMode: "each" });
  const snap = await server.ctx.publicClient.request({ method: "evm_snapshot", params: [] });
  await server.ctx.publicClient.request({ method: "evm_increaseTime", params: [25 * 3600] });
  await server.ctx.publicClient.request({ method: "evm_mine", params: [] });
  server.store.kvSet("cursor", String(await server.ctx.publicClient.getBlockNumber({ cacheTime: 0 })));
  try {
    const deadline = Date.now() + 60000;
    let kinds = new Set();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      kinds = new Set(server.store.listTxs().filter((t) => t.outcome === "success").map((t) => t.kind));
      if (["income", "allocate", "pay", "supply"].every((k) => kinds.has(k))) break;
    }
    assert.ok(kinds.has("income"), "simulated employer paid wages");
    assert.ok(kinds.has("allocate"), "indexer allocated the wages");
    assert.ok(kinds.has("pay"), "scheduled remittance executed");
    assert.ok(kinds.has("supply"), "savings sweep executed");
    const urTagged = server.store.listTxs().filter((t) => t.scenario === "UR");
    assert.ok(urTagged.length > 0, "unattended cycles are tagged UR in the ledger");
    const stats = server.store.cycleStats();
    const errors = stats.filter((s) => s.status === "error" || s.status === "failed");
    assert.equal(errors.length, 0, JSON.stringify(stats));
    console.log(`      unattended cycles: ${JSON.stringify(stats.map((s) => `${s.type}:${s.status}×${s.n}`))}`);
  } finally {
    await server.stop();
    await server.ctx.publicClient.request({ method: "evm_revert", params: [snap] });
  }
});
