// The core loop: observe → plan → compile → check → simulate → gate → execute → verify → record.
// It fails closed at every step: anything unexpected ends the cycle with a receipt and no transaction.
import { formatUnits, decodeEventLog, zeroHash } from "viem";
import { observe } from "./observe.js";
import { propose } from "./planner.js";
import { classifyUntrusted } from "./firewall.js";
import { compile } from "./compile.js";
import { checkPlan } from "./risk/engine.js";
import { assignTiers } from "./tier.js";
import { simulate } from "./simulate.js";
import { actualDeltas, compareDeltas, fmtDeltas } from "./verify.js";
import { draftReceipt, finalizeReceipt, anchorReceipt } from "./receipts.js";
import { allocationPlan } from "./templates.js";
import { intentHashOf } from "@covenant/shared";

function mutex() {
  let last = Promise.resolve();
  return (fn) => {
    const run = last.then(fn, fn);
    last = run.catch(() => {});
    return run;
  };
}

export function createAgent({ ctx, config, store, model, notify = async () => {} }) {
  const exclusive = mutex();

  async function poolQuotes(calls, state) {
    const quotes = {};
    for (const c of calls.filter((x) => x.type === "swap")) {
      const [, tokenIn, tokenOut, amountIn] = c.args;
      const poolOut = await ctx.publicClient.readContract({ address: ctx.deployment.contracts.amm, abi: ctx.abis.amm, functionName: "quote", args: [tokenIn, tokenOut, amountIn] });
      const aIn = state.assets[c.asset];
      const aOut = state.assets[c.toAsset];
      const oracleOut = (Number(formatUnits(amountIn, aIn.decimals)) * aIn.price) / aOut.price;
      quotes[tokenIn + tokenOut] = { poolOut: Number(formatUnits(poolOut, aOut.decimals)), oracleOut };
    }
    return quotes;
  }

  async function record(receiptDraft, { detail, ...extra } = {}) {
    // Intent fields are frozen at draft time (the action tx commits to them); outcomes go into signals.
    const r = { ...receiptDraft, ...extra, signals: { ...(extra.signals ?? {}), ...(detail ? { detail } : {}) } };
    const { receipt, receiptHash } = finalizeReceipt(r);
    let anchorTx = null;
    try {
      anchorTx = await anchorReceipt(ctx, receiptHash, receipt.intentHash, config.anchorMode);
      if (anchorTx) store.recordTx({ hash: anchorTx, kind: "anchor", tier: "T1", outcome: "success", receiptId: receipt.receiptId, scenario: extra.scenario });
    } catch (e) {
      receipt.signals.anchorError = e.shortMessage ?? e.message;
    }
    store.saveReceipt({ receipt, receiptHash, anchorTx });
    return { receipt, receiptHash, anchorTx };
  }

  async function sendCall(c, scenario, receiptId) {
    const hash = await ctx.walletClient.writeContract({ address: ctx.vault.address, abi: ctx.abis.vault, functionName: c.fn, args: c.args });
    const r = await ctx.publicClient.waitForTransactionReceipt({ hash });
    store.recordTx({ hash, kind: c.fn, tier: c.tier, outcome: r.status === "success" ? "success" : "reverted", receiptId, scenario, gasUsed: r.gasUsed?.toString() });
    return r;
  }

  function message(status, receipt, detail = "") {
    const head = {
      executed: "Done.", awaiting_owner: "Needs your approval.", blocked: "Not done.", held: "On hold.",
      refused: "Refused.", sim_mismatch: "Stopped before sending.", failed: "Failed.", verify_mismatch: "Paused for safety.", no_action: "",
    }[status];
    return [head, receipt.explanation, detail].filter(Boolean).join(" ");
  }

  async function runCycleInner(trigger) {
    if (trigger.id && store.hasTrigger(trigger.id)) return { status: "duplicate" };
    if (trigger.id) store.markTrigger(trigger.id, trigger.type);
    if (!ctx.walletClient) throw new Error("AGENT_PRIVATE_KEY is not configured");
    const scenario = trigger.scenario ?? null;
    const state = await observe(ctx, store);
    const untrusted = trigger.untrusted ?? [];
    const provider = trigger.provider ?? config.model.provider;
    const signal = untrusted.length ? await classifyUntrusted(model, untrusted, provider === "hijacked" ? "hijacked" : undefined) : null;

    // 1. PLAN
    let plan;
    let plannerModel = "none";
    try {
      if (trigger.plan) {
        plan = trigger.plan;
        plannerModel = trigger.planSource ?? "template";
      } else {
        const res = await propose({ model, state, trigger, untrusted, provider });
        plan = res.plan;
        plannerModel = res.model;
        if (trigger.type === "incoming_transfer" && !plan.actions.some((a) => a.type === "allocate") && !untrusted.length) {
          plan = allocationPlan(state) ?? plan;
          plannerModel += " → template";
        }
      }
    } catch (e) {
      const d = draftReceipt({ state, trigger, plan: null, checks: [], tier: null, explanation: `No plan: ${e.message}`, modelInfo: { planner: plannerModel, classifier: signal?.model ?? null } });
      const rec = await record(d, { status: "blocked", scenario, detail: e.message });
      return { status: "blocked", ...rec, message: message("blocked", rec.receipt) };
    }
    const modelInfo = { planner: plannerModel, classifier: signal?.model ?? null };

    // 2. COMPILE (intentHash placeholder; filled in once the receipt draft exists)
    const { calls, ownerActions } = compile(plan, state, zeroHash);

    // 3. CHECK
    const history = { recentPayments: store.recentPayments(), paymentAmounts: store.paymentAmounts() };
    const quotes = await poolQuotes(calls, state).catch(() => ({}));
    const verdict = checkPlan({ plan, calls, ownerActions, state, trigger, history, quotes, params: ctx.deployment.params });
    const signals = { injection: signal, scam: verdict.scam ? { score: verdict.scam.score, features: verdict.scam.features } : null };
    const { tiers, tier } = assignTiers(calls, state, verdict.checks.some((c) => c.status === "t2"));
    calls.forEach((c, i) => (c.tier = tiers[i].tier));

    const d = draftReceipt({ state, trigger, plan, checks: verdict.checks, tier, explanation: plan.explanation, modelInfo });
    for (const c of calls) c.args[c.args.length - 1] = d.intentHash;

    if (verdict.verdict !== "ok") {
      const status = verdict.verdict === "held" ? "held" : verdict.verdict === "clarify" ? "no_action" : "blocked";
      const detail = verdict.reasons.join(" ");
      const rec = await record(d, { status, signals, scenario, detail });
      if (status === "held") {
        await notify({ to: "guardian", kind: "scam_hold", text: `Covenant held a payment request. ${detail}`, receiptId: rec.receipt.receiptId });
        await notify({ to: "owner", kind: "scam_hold", text: `I paused this request. ${detail} New recipients wait 24 hours, and your guardian has been told. If it is genuine, it can go ahead after the wait.`, receiptId: rec.receipt.receiptId });
      }
      return { status, ...rec, reasons: verdict.reasons, clarification: plan.clarification, message: message(status, rec.receipt, detail) };
    }

    if (ownerActions.length) {
      const rec = await record(d, { status: "awaiting_owner", signals: { ...signals, ownerActions: ownerActions.map(({ data, ...o }) => o) }, scenario });
      for (const o of ownerActions) {
        store.saveOwnerAction({ ...o, receiptId: rec.receipt.receiptId });
        await notify({ to: "owner", kind: "add_payee", text: `To pay "${o.label}" you must add them as a payee yourself. New payees can be paid after a 24-hour cooling-off.`, link: `/payees?add=${o.address}&label=${encodeURIComponent(o.label)}` });
      }
      if (!calls.length) return { status: "awaiting_owner", ...rec, ownerActions, message: message("awaiting_owner", rec.receipt) };
    }

    if (!calls.length) {
      const rec = await record(d, { status: "no_action", signals, scenario });
      return { status: "no_action", ...rec, clarification: plan.clarification, message: plan.clarification ?? plan.explanation };
    }

    if (tier === "T3") {
      const why = tiers.filter((t) => t.tier === "T3").map((t) => t.why).join(", ");
      const rec = await record(d, { status: "refused", signals, scenario, detail: `Refused: ${why}.` });
      return { status: "refused", ...rec, message: message("refused", rec.receipt, `Refused: ${why}.`) };
    }

    // 4. SIMULATE (T1 calls as-is; T2 payments as proposals)
    const t1 = calls.filter((c) => c.tier === "T1");
    const t2 = calls.filter((c) => c.tier === "T2");
    const sim = await simulate(ctx, t1, state, config);
    if (!sim.ok) {
      const rec = await record(d, { status: "sim_mismatch", signals: { ...signals, simulation: sim }, scenario, detail: `Simulation failed: ${sim.error}.` });
      return { status: "sim_mismatch", ...rec, message: message("sim_mismatch", rec.receipt, `Simulation failed: ${sim.error}.`) };
    }

    // 5. EXECUTE T1
    const receipts = [];
    const txHashes = [];
    try {
      for (const c of t1) {
        const r = await sendCall(c, scenario, d.receiptId);
        receipts.push(r);
        txHashes.push(r.transactionHash);
        if (r.status !== "success") throw new Error(`${c.fn} reverted on-chain`);
        if (c.type === "pay") store.addPayment({ payeeId: c.payee.id, amount: c.amount.toString(), units: formatUnits(c.amount, state.assets[c.asset].decimals), at: state.now });
      }
    } catch (e) {
      const rec = await record(d, { status: "failed", txHashes, signals, scenario, detail: e.shortMessage ?? e.message });
      return { status: "failed", ...rec, message: message("failed", rec.receipt, e.shortMessage ?? e.message) };
    }

    // 6. VERIFY
    let actual = {};
    if (t1.length) {
      actual = actualDeltas(ctx, receipts);
      const cmp = compareDeltas(sim.deltas, actual, t1, config.simTolerance);
      if (!cmp.ok) {
        try {
          const ph = await ctx.walletClient.writeContract({ address: ctx.vault.address, abi: ctx.abis.vault, functionName: "pause" });
          await ctx.publicClient.waitForTransactionReceipt({ hash: ph });
          store.recordTx({ hash: ph, kind: "pause", tier: "T1", outcome: "success", receiptId: d.receiptId, scenario });
          txHashes.push(ph);
        } catch { /* pausing is best effort; the guardian is alerted either way */ }
        await notify({ to: "guardian", kind: "pause", text: "Covenant paused itself: a transaction's real effect did not match its simulation." });
        const rec = await record(d, { status: "verify_mismatch", txHashes, deltas: { simulated: sim.simulated, actual: fmtDeltas(actual, state) }, signals, scenario });
        return { status: "verify_mismatch", ...rec, message: message("verify_mismatch", rec.receipt) };
      }
    }

    // 7. PROPOSE T2
    const proposals = [];
    for (const c of t2) {
      const action = { kind: 0, payeeId: c.payee.id, asset: c.args[1], amount: c.amount, bucket: c.args[3] };
      const hash = await ctx.walletClient.writeContract({ address: ctx.vault.address, abi: ctx.abis.vault, functionName: "propose", args: [action, d.intentHash] });
      const r = await ctx.publicClient.waitForTransactionReceipt({ hash });
      store.recordTx({ hash, kind: "propose", tier: "T2", outcome: r.status === "success" ? "success" : "reverted", receiptId: d.receiptId, scenario });
      txHashes.push(hash);
      const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: ctx.abis.vault, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "Proposed");
      if (!ev) continue;
      const p = {
        id: Number(ev.args.id), payeeAlias: c.payee.alias, payeeId: c.payee.id, asset: c.asset,
        amount: formatUnits(c.amount, state.assets[c.asset].decimals), bucket: c.bucket, purpose: c.purpose,
        intentHash: d.intentHash, expiresAt: Number(ev.args.expiresAt), status: "open", proposeTx: hash, receiptId: d.receiptId,
        why: tiers[calls.indexOf(c)].why,
      };
      store.saveProposal(p);
      proposals.push(p);
      await notify({ to: "owner", kind: "proposal", proposal: p, text: `${c.payee.alias} needs ${p.amount} ${c.asset} (${c.purpose || "payment"}). This is ${p.why}, so it needs your approval. Expires in 24 hours.`, link: `/approve/${p.id}` });
    }

    const warn = verdict.checks.find((x) => x.id === "R-11" && x.status === "t2");
    if (warn && proposals.length) await notify({ to: "guardian", kind: "scam_warn", text: `Covenant asked for a co-signature on a payment that looks unusual. ${warn.detail}` });
    const status = proposals.length && !t1.length ? "awaiting_owner" : "executed";
    const rec = await record(d, {
      status, txHashes, scenario,
      deltas: t1.length ? { simulated: sim.simulated, actual: fmtDeltas(actual, state) } : null,
      signals: { ...signals, simulation: { mode: sim.mode, predicted: Boolean(sim.predicted) }, proposals: proposals.map((p) => p.id) },
    });
    return { status, ...rec, proposals, txHashes, message: message(status, rec.receipt) };
  }

  return {
    runCycle: (trigger) => exclusive(() => runCycleInner(trigger)),
    observe: () => observe(ctx, store),
    intentHashOf,
  };
}
