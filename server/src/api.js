// HTTP API (Fastify). Public read endpoints serve the dashboard and judges; owner endpoints need a wallet
// signature session; admin endpoints (scenario runs) need ADMIN_TOKEN.
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { randomBytes } from "node:crypto";
import { verifyMessage, getAddress, formatUnits, encodeFunctionData } from "viem";
import { payeeId, labelId, CHAINS, txUrl, addressUrl, Mandate, hashCanonical } from "@covenant/shared";
import { draftMandate } from "@covenant/agent";
import { ledgerRows, ledgerSummary, toCsv, toMarkdown } from "./ledger.js";
import { verifyReceipt } from "./verify-receipt.js";

const json = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function createApi({ ctx, store, agent, model, indexer, scheduler, log, config }) {
  const app = Fastify({ loggerInstance: log, trustProxy: true, disableRequestLogging: process.env.LOG_REQUESTS !== "1" });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  const sessions = new Map(); // token → { address, role, expires }
  const nonces = new Map(); // nonce → expires
  const dep = ctx.deployment;

  function roleOf(address) {
    const a = getAddress(address);
    if (a === getAddress(dep.accounts.owner)) return "owner";
    if (dep.accounts.guardian && a === getAddress(dep.accounts.guardian)) return "guardian";
    return null;
  }
  const auth = (roles) => async (req, reply) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const s = sessions.get(token);
    if (!s || s.expires < Date.now() || !roles.includes(s.role)) return reply.code(401).send({ error: "sign in with the owner or guardian wallet" });
    req.session = s;
  };
  const admin = async (req, reply) => {
    if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) return reply.code(401).send({ error: "admin token required" });
  };

  // ── health & public reads ───────────────────────────────────────────
  app.get("/health", async () => {
    const block = await ctx.publicClient.getBlockNumber();
    return { ok: true, chainId: dep.chainId, block: Number(block), cursor: store.kvGet("cursor"), model: config.model.provider, unattended: process.env.UNATTENDED === "1" };
  });

  app.get("/api/deployment", async () => ({
    chainId: dep.chainId, chain: CHAINS[dep.chainId]?.name, explorer: CHAINS[dep.chainId]?.explorer ?? null,
    contracts: dep.contracts, accounts: { owner: dep.accounts.owner, guardian: dep.accounts.guardian, agent: dep.accounts.agent },
    mocks: dep.mocks, vaultUrl: addressUrl(dep.chainId, dep.contracts.vault), mandateHash: dep.mandateHash,
  }));

  app.get("/api/state", async () => {
    const s = await agent.observe();
    const fmt = (a, v) => formatUnits(v, a.decimals);
    return json({
      ...s,
      formatted: Object.fromEntries(Object.values(s.assets).map((a) => [a.symbol, {
        balance: fmt(a, a.balance), unallocated: fmt(a, a.unallocated), lent: fmt(a, a.supplied), price: a.price,
        buckets: Object.fromEntries(Object.entries(a.buckets).map(([k, v]) => [k, fmt(a, v)])),
        limits: { perTx: fmt(a, a.policy.perTxCap), daily: fmt(a, a.policy.dailyCap), t2Ceiling: fmt(a, a.policy.t2Ceiling), lendingCap: fmt(a, a.policy.lendingCap) },
        paid24h: fmt(a, a.outflow24h),
      }])),
      yieldPaused: store.kvGet("yieldPaused") === "1",
    });
  });

  app.get("/api/receipts", async (req) => json(store.listReceipts({ limit: Number(req.query.limit ?? 50), status: req.query.status })));
  app.get("/api/receipts/:id", async (req, reply) => store.getReceipt(req.params.id) ?? reply.code(404).send({ error: "not found" }));
  app.get("/api/receipts/:id/verify", async (req, reply) => {
    const r = store.getReceipt(req.params.id);
    if (!r) return reply.code(404).send({ error: "not found" });
    return json(await verifyReceipt(ctx, store, r.receipt));
  });
  app.post("/api/verify", async (req) => json(await verifyReceipt(ctx, store, req.body?.receipt ?? req.body)));

  app.get("/api/proposals", async (req) => store.listProposals({ status: req.query.status }));
  app.get("/api/proposals/:id", async (req, reply) => {
    const p = store.getProposal(req.params.id);
    if (!p) return reply.code(404).send({ error: "not found" });
    const onchain = await ctx.vault.read.getProposal([BigInt(p.id)]);
    return json({ ...p, onchainStatus: ["open", "executed", "cancelled"][onchain.status], receipt: store.getReceipt(p.receiptId)?.receipt ?? null, proposeTxUrl: txUrl(dep.chainId, p.proposeTx) });
  });

  app.get("/api/ledger.json", async () => {
    const rows = ledgerRows(store, dep);
    return { summary: ledgerSummary(rows, dep), rows };
  });
  app.get("/api/ledger.csv", async (req, reply) => reply.type("text/csv").send(toCsv(ledgerRows(store, dep))));
  app.get("/api/ledger.md", async (req, reply) => {
    const rows = ledgerRows(store, dep);
    return reply.type("text/markdown").send(toMarkdown(rows, ledgerSummary(rows, dep)));
  });
  app.get("/api/stats", async () => ({ cycles: store.cycleStats() }));
  app.get("/api/notifications", { preHandler: auth(["owner", "guardian"]) }, async (req) => store.listNotifications(req.session.role));
  app.get("/api/payees", async () => (await agent.observe()).payees.map(({ alias, id, address, active, coolingOff, activeFrom, firstPaid, purpose }) => ({ alias, id, address, active, coolingOff, activeFrom, firstPaid, purpose })));
  app.get("/api/mandate", async () => ({ mandate: store.getMandate(), onchainHash: await ctx.vault.read.mandateHash() }));

  // ── wallet sign-in ──────────────────────────────────────────────────
  app.post("/api/auth/nonce", async () => {
    const nonce = randomBytes(12).toString("hex");
    nonces.set(nonce, Date.now() + 5 * 60_000);
    return { nonce, message: `Sign in to Covenant\nVault: ${dep.contracts.vault}\nNonce: ${nonce}` };
  });
  app.post("/api/auth/verify", async (req, reply) => {
    const { address, signature, nonce } = req.body ?? {};
    const exp = nonces.get(nonce);
    if (!exp || exp < Date.now()) return reply.code(400).send({ error: "nonce expired" });
    nonces.delete(nonce);
    const message = `Sign in to Covenant\nVault: ${dep.contracts.vault}\nNonce: ${nonce}`;
    const ok = await verifyMessage({ address, message, signature }).catch(() => false);
    const role = ok ? roleOf(address) : null;
    if (!role) return reply.code(401).send({ error: "this wallet is not the vault's owner or guardian" });
    const token = randomBytes(24).toString("hex");
    sessions.set(token, { address: getAddress(address), role, expires: Date.now() + 12 * 3600_000 });
    return { token, role, address: getAddress(address) };
  });

  // ── owner actions ───────────────────────────────────────────────────
  app.post("/api/chat", { preHandler: auth(["owner"]) }, async (req) => {
    const text = String(req.body?.text ?? "").slice(0, 1000);
    const res = await agent.runCycle({ type: "owner_chat", channel: "web-owner", id: `web-${Date.now()}-${randomBytes(3).toString("hex")}`, text, scenario: store.kvGet("scenarioTag") });
    return json({ status: res.status, message: res.message, clarification: res.clarification, receipt: res.receipt, proposals: res.proposals, ownerActions: res.ownerActions });
  });

  app.post("/api/mandate/draft", { preHandler: auth(["owner"]) }, async (req) => {
    const current = store.getMandate();
    const policy = await ctx.vault.read.getAssetPolicy([dep.contracts.usdc]);
    return json(await draftMandate({ model, text: String(req.body?.text ?? ""), current, onchain: { vaultAbi: ctx.abis.vault, vault: dep.contracts.vault, usdc: dep.contracts.usdc, policy } }));
  });

  app.post("/api/mandate/activate", { preHandler: auth(["owner"]) }, async (req, reply) => {
    const parsed = Mandate.safeParse(req.body?.mandate);
    if (!parsed.success) return reply.code(400).send({ error: "invalid mandate", issues: parsed.error.issues });
    const hash = hashCanonical(parsed.data);
    const onchain = await ctx.vault.read.mandateHash();
    if (onchain !== hash) return reply.code(409).send({ error: "the vault's mandate hash does not match yet; send setMandateHash first", onchain, hash });
    store.setMandate(parsed.data, hash, req.body?.txHash ?? null);
    scheduler.reload();
    return { ok: true, hash };
  });

  app.post("/api/payees/prepare", { preHandler: auth(["owner"]) }, async (req, reply) => {
    const { alias, address, purpose = "" } = req.body ?? {};
    if (!alias || !/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) return reply.code(400).send({ error: "alias and address required" });
    store.kvSet(`label:${getAddress(address)}`, JSON.stringify({ alias, purpose }));
    const id = payeeId(alias);
    return { payeeId: id, to: dep.contracts.vault, data: encodeFunctionData({ abi: ctx.abis.vault, functionName: "addPayee", args: [id, getAddress(address), labelId(`${alias} — ${purpose}`)] }), coolingOffHours: Number(dep.params.coolingOff) / 3600 };
  });

  app.post("/api/telegram/link-code", { preHandler: auth(["owner", "guardian"]) }, async (req) => ({ code: store.createLinkCode(req.session.role, req.session.address), bot: process.env.TELEGRAM_BOT_USERNAME ?? null }));

  /** Relay an owner's EIP-712 approval so the owner needs no gas. */
  app.post("/api/proposals/:id/relay-approval", async (req, reply) => {
    const { deadline, signature } = req.body ?? {};
    if (!ctx.walletClient) return reply.code(503).send({ error: "relayer not configured" });
    try {
      const hash = await ctx.walletClient.writeContract({ address: dep.contracts.vault, abi: ctx.abis.vault, functionName: "approveWithSig", args: [BigInt(req.params.id), BigInt(deadline), signature] });
      const r = await ctx.publicClient.waitForTransactionReceipt({ hash });
      store.recordTx({ hash, kind: "approve", tier: "T2", outcome: r.status === "success" ? "success" : "reverted", actor: "owner (relayed)", note: `proposal #${req.params.id} co-signed via EIP-712`, scenario: store.kvGet("scenarioTag") });
      return { hash, status: r.status };
    } catch (e) {
      return reply.code(400).send({ error: e.shortMessage ?? e.message });
    }
  });

  // ── admin (demo recording, red-team) ────────────────────────────────
  app.post("/api/admin/trigger", { preHandler: admin }, async (req) => {
    const b = req.body ?? {};
    if (b.provider === "hijacked" && process.env.ALLOW_HIJACKED !== "1") return { error: "hijacked planner is red-team only (set ALLOW_HIJACKED=1)" };
    const res = await indexer.runAndLog({ type: b.type ?? "owner_chat", channel: b.channel ?? "cli-owner", id: b.id ?? `admin-${Date.now()}`, text: b.text, untrusted: b.untrusted, provider: b.provider, scenario: b.scenario, plan: b.plan, forwarded: b.forwarded });
    return json(res);
  });
  app.post("/api/admin/scenario", { preHandler: admin }, async (req) => {
    store.kvSet("scenarioTag", req.body?.tag ?? "");
    return { tag: req.body?.tag ?? "" };
  });
  app.post("/api/admin/record-tx", { preHandler: admin }, async (req) => {
    store.recordTx(req.body);
    return { ok: true };
  });
  app.post("/api/admin/peg-check", { preHandler: admin }, async () => {
    await scheduler.pegCheck();
    return { yieldPaused: store.kvGet("yieldPaused") === "1" };
  });
  app.post("/api/admin/tick", { preHandler: admin }, async () => {
    await indexer.tick();
    return { ok: true };
  });

  return app;
}
