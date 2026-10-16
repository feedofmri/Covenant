// API test against a local chain (skips when none is running).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { DEV_KEYS } from "@covenant/shared/dev-accounts.js";
import { ledgerRows, toCsv, toMarkdown, ledgerSummary } from "../src/ledger.js";
import { openDb, createSqliteStore } from "../src/db.js";

const RPC = "http://127.0.0.1:8545";
let up = false;
try {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  up = (await r.json()).result === "0x7a69";
} catch { up = false; }
const opts = { skip: up ? false : "no local node" };

let server, base, token;
before(async () => {
  if (!up) return;
  process.env.ADMIN_TOKEN = "test-admin";
  const { startServer } = await import("../src/index.js");
  server = await startServer({ deployment: "localhost", rpcUrls: [RPC], agentPrivateKey: DEV_KEYS.agent, dbPath: ":memory:", port: 0, indexer: false, scheduler: false, anchorMode: "each" });
  base = `http://127.0.0.1:${server.app.server.address().port}`;
});
after(async () => server && (await server.stop()));

const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (path, headers = {}) => fetch(base + path, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("health and public state", opts, async () => {
  assert.equal((await get("/health")).body.ok, true);
  const s = (await get("/api/state")).body;
  assert.ok(s.formatted.USDC.limits.perTx);
  assert.equal((await get("/api/deployment")).body.chainId, 31337);
});

test("wallet sign-in: owner yes, stranger no", opts, async () => {
  const signIn = async (key) => {
    const { body: n } = await post("/api/auth/nonce", {});
    const acct = privateKeyToAccount(key);
    return post("/api/auth/verify", { address: acct.address, nonce: n.nonce, signature: await acct.signMessage({ message: n.message }) });
  };
  const bad = await signIn(DEV_KEYS.attacker);
  assert.equal(bad.status, 401);
  const ok = await signIn(DEV_KEYS.owner);
  assert.equal(ok.body.role, "owner");
  token = ok.body.token;
  assert.equal((await post("/api/chat", { text: "balance" })).status, 401);
});

test("owner chat runs a cycle and produces a verifiable receipt", opts, async () => {
  const r = await post("/api/chat", { text: "what is my balance" }, { authorization: `Bearer ${token}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "no_action");
  const v = (await get(`/api/receipts/${r.body.receipt.receiptId}/verify`)).body;
  assert.equal(v.checks[0].ok, true, "intent hash recomputes");
  assert.ok(v.checks.some((c) => c.name.includes("anchored") && c.ok));
  const tampered = { ...r.body.receipt, explanation: "something else" };
  const bad = (await post("/api/verify", { receipt: tampered })).body;
  assert.equal(bad.ok, false);
});

test("admin endpoints require the admin token", opts, async () => {
  assert.equal((await post("/api/admin/scenario", { tag: "X" })).status, 401);
  assert.equal((await post("/api/admin/scenario", { tag: "D2" }, { "x-admin-token": "test-admin" })).body.tag, "D2");
  const hij = await post("/api/admin/trigger", { provider: "hijacked", text: "x" }, { "x-admin-token": "test-admin" });
  assert.match(hij.body.error, /red-team only/);
});

test("telegram link codes are single use", () => {
  const store = createSqliteStore(openDb(":memory:"));
  const code = store.createLinkCode("guardian", "0xabc");
  assert.deepEqual(store.consumeLinkCode(code, 42), { role: "guardian", wallet: "0xabc" });
  assert.equal(store.consumeLinkCode(code, 43), null);
  assert.deepEqual(store.chatsFor("guardian"), ["42"]);
});

test("ledger exports CSV and Markdown with explorer links on Base Sepolia", () => {
  const store = createSqliteStore(openDb(":memory:"));
  store.recordTx({ hash: "0x" + "ab".repeat(32), kind: "pay", tier: "T1", outcome: "success", scenario: "D2" });
  store.recordTx({ hash: "0x" + "cd".repeat(32), kind: "forced", tier: "T3", outcome: "reverted", scenario: "RT-08" });
  const dep = { chainId: 84532, deployedAt: new Date().toISOString(), setupTxs: [{ hash: "0x" + "ef".repeat(32), kind: "createVault", scenario: "D1" }] };
  const rows = ledgerRows(store, dep);
  assert.equal(rows.length, 3);
  assert.match(rows[1].explorer, /^https:\/\/sepolia\.basescan\.org\/tx\//);
  assert.match(toCsv(rows), /transaction execution/);
  const md = toMarkdown(rows, ledgerSummary(rows, dep));
  assert.match(md, /1 reverted/);
});
