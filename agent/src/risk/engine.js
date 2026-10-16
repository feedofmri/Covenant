// Deterministic risk engine. Rules, not the model, decide whether a plan may proceed. Every rule id appears in
// the receipt's checks list.
import { formatUnits } from "viem";
import { RISK } from "@covenant/shared";
import { allowedTypes } from "../firewall.js";
import { isDenied } from "./denylist.js";
import { scamScore, explainScam } from "./scam.js";

const R = (id, status, detail = "") => ({ id, status, detail });

/**
 * @returns {{ checks: Array<{id,status,detail}>, verdict: 'ok'|'blocked'|'held'|'clarify', reasons: string[], scam: object|null }}
 */
export function checkPlan({ plan, calls, ownerActions, state, trigger, history = {}, quotes = {}, params = {} }) {
  const checks = [];
  const allowed = allowedTypes(trigger);
  const instruction = trigger.type === "owner_chat";

  // R-13 vault usable
  if (state.paused) checks.push(R("R-13", "block", "vault is paused"));
  else if (state.now > state.agentExpiresAt) checks.push(R("R-13", "block", "agent key expired"));
  else checks.push(R("R-13", "pass"));

  // R-01 trigger-scoped capabilities
  const forbidden = plan.actions.filter((a) => !allowed.has(a.type)).map((a) => a.type);
  checks.push(forbidden.length ? R("R-01", "block", `trigger ${trigger.type} may not produce: ${[...new Set(forbidden)].join(", ")}`) : R("R-01", "pass"));

  const planned = {}; // per-asset planned pay outflow in this cycle
  let scam = null;
  const running = Object.fromEntries(Object.entries(state.assets).map(([k, v]) => [k, { ...v.buckets }]));
  for (const c of calls) {
    const a = { ...state.assets[c.asset], buckets: running[c.asset] };
    const fmt = (v) => `${formatUnits(v, a.decimals)} ${a.symbol}`;
    // R-03 asset
    if (!a.policy.allowed) checks.push(R("R-03", "block", `${a.symbol} not allowed`));
    else if (c.amount <= 0n && c.type !== "allocate") checks.push(R("R-03", "block", "amount must be positive"));
    else checks.push(R("R-03", "pass"));

    if (c.type === "pay") {
      // R-02 payee
      if (!c.resolved || !c.payee?.active) checks.push(R("R-02", "block", `"${c.payeeAlias}" is not a registered payee`));
      else if (c.payee.coolingOff) checks.push(R("R-02", "hold", `${c.payee.alias} is in the 24 h cooling-off period`));
      else checks.push(R("R-02", "pass"));
      // R-04 ceiling (T3)
      if (c.amount > a.policy.t2Ceiling) checks.push(R("R-04", "block", `${fmt(c.amount)} is above the co-sign ceiling of ${fmt(a.policy.t2Ceiling)}`));
      else checks.push(R("R-04", "pass"));
      // R-05 sanctions
      checks.push(isDenied(c.payee?.address) ? R("R-05", "block", "recipient is on the sanctions denylist") : R("R-05", "pass"));
      // R-08 bucket funds
      const bal = a.buckets[c.bucket] ?? 0n;
      const fromEmergency = c.bucket === "EMERGENCY" && !instruction;
      if (fromEmergency) checks.push(R("R-08", "block", "emergency fund is only used on the owner's request"));
      else if (bal < c.amount) checks.push(R("R-08", "block", `${c.bucket.toLowerCase()} bucket has ${fmt(bal)}, needs ${fmt(c.amount)}`));
      else checks.push(R("R-08", "pass"));
      running[c.asset][c.bucket] = bal - c.amount;
      // R-12 duplicates
      const dup = (history.recentPayments ?? []).find((p) => p.payeeId === c.payee?.id && p.amount === c.amount.toString() && state.now - p.at < RISK.duplicateWindowSec);
      checks.push(dup && trigger.type !== "redteam" ? R("R-12", "block", "same payment was made less than 10 minutes ago") : R("R-12", "pass"));
      // R-14 purpose code
      const units = Number(formatUnits(c.amount, a.decimals));
      checks.push(units > RISK.purposeCodeAbove && !c.purpose ? R("R-14", "clarify", `payments above ${RISK.purposeCodeAbove} need a purpose`) : R("R-14", "pass"));
      // R-11 scam pattern
      const s = scamScore({
        text: trigger.text ?? "", payee: c.payee, amount: units,
        history: (history.paymentAmounts ?? []).map(Number), untrustedOrigin: Boolean(trigger.forwarded), now: state.now,
      });
      scam = !scam || s.score > scam.score ? s : scam;
      checks.push(s.held ? R("R-11", "hold", explainScam(s)) : s.warn ? R("R-11", "t2", explainScam(s)) : R("R-11", `pass(${s.score})`));
      planned[c.asset] = (planned[c.asset] ?? 0n) + c.amount;
    }

    if (c.type === "swap" || c.type === "supply") {
      // R-07 peg
      const depegBps = params.depegBps ?? 200;
      const stable = a.policy.isStable;
      checks.push(stable && Math.abs(a.price - 1) * 10000 > depegBps ? R("R-07", "block", `${a.symbol} is off its peg (${a.price.toFixed(4)} USD)`) : R("R-07", "pass"));
      const bal = a.buckets[c.bucket] ?? 0n;
      checks.push(bal < c.amount ? R("R-08", "block", `${c.bucket.toLowerCase()} bucket has ${fmt(bal)}, needs ${fmt(c.amount)}`) : R("R-08", "pass"));
      running[c.asset][c.bucket] = bal - c.amount;
    }
    if (c.type === "supply") {
      // R-09 lending exposure + liquid buffer
      const wouldBe = a.supplied + c.amount;
      const buffer = state.mandate ? BigInt(Math.round(Number(state.mandate.savings.liquidBuffer) * 10 ** a.decimals)) : 0n;
      if (wouldBe > a.policy.lendingCap) checks.push(R("R-09", "block", `lending would reach ${fmt(wouldBe)}, cap is ${fmt(a.policy.lendingCap)}`));
      else if (!instruction && c.bucket === "SAVINGS" && (a.buckets.SAVINGS ?? 0n) < buffer) checks.push(R("R-09", "block", "would leave savings below the liquid buffer")); // running balance is already debited
      else checks.push(R("R-09", "pass"));
    }
    if (c.type === "swap") {
      // R-06 oracle vs pool
      const q = quotes[c.args[1] + c.args[2]];
      if (!q) checks.push(R("R-06", "block", "no pool quote"));
      else {
        const dev = Math.abs(q.poolOut / q.oracleOut - 1);
        checks.push(dev > RISK.poolOracleMaxDeviation ? R("R-06", "block", `pool price deviates ${(dev * 100).toFixed(2)}% from the oracle`) : R("R-06", "pass"));
      }
      if (c.amount > a.policy.perTxCap) checks.push(R("R-04", "block", `swap above the per-transaction cap of ${fmt(a.policy.perTxCap)}`));
      if (a.swap24h + c.amount > a.policy.dailySwapCap) checks.push(R("R-04", "block", "daily swap volume cap reached"));
    }
    if (c.type === "reallocate" || c.type === "withdraw") {
      if (c.type === "reallocate") {
        const bal = a.buckets[c.bucket] ?? 0n;
        const fromEmergency = c.bucket === "EMERGENCY" && !instruction;
        checks.push(fromEmergency ? R("R-08", "block", "emergency fund is only used on the owner's request") : bal < c.amount ? R("R-08", "block", `${c.bucket.toLowerCase()} bucket has ${fmt(bal)}`) : R("R-08", "pass"));
        running[c.asset][c.bucket] = bal - c.amount;
        running[c.asset][c.to] = (running[c.asset][c.to] ?? 0n) + c.amount;
      }
    }
    if (c.type === "allocate") {
      checks.push(c.amount > a.unallocated ? R("R-08", "block", `only ${fmt(a.unallocated)} is unallocated`) : R("R-08", "pass"));
    }
    if (!c.resolved && c.type !== "pay") checks.push(R("R-03", "block", "action could not be resolved"));
  }

  // R-10 plan outflow share
  for (const [sym, out] of Object.entries(planned)) {
    const bal = state.assets[sym].balance;
    if (bal > 0n && Number(out) / Number(bal) > RISK.maxPlanOutflowShare) checks.push(R("R-10", "t2", `plan sends more than half of the ${sym} balance`));
  }

  // New-payee requests: sanctions + scam check, then an owner action (never executed by the agent)
  for (const o of ownerActions) {
    checks.push(isDenied(o.address) ? R("R-05", "block", "requested recipient is on the sanctions denylist") : R("R-05", "pass"));
    const amountGuess = Number((trigger.text ?? "").match(/\d+(\.\d+)?/)?.[0] ?? 0);
    const s = scamScore({ text: trigger.text ?? "", newPayee: true, amount: amountGuess, history: (history.paymentAmounts ?? []).map(Number), untrustedOrigin: Boolean(trigger.forwarded), now: state.now });
    scam = !scam || s.score > scam.score ? s : scam;
    checks.push(s.held ? R("R-11", "hold", explainScam(s)) : R("R-11", `pass(${s.score})`));
  }

  const has = (st) => checks.some((c) => c.status === st);
  const reasons = checks.filter((c) => ["block", "hold", "clarify"].includes(c.status)).map((c) => c.detail);
  const verdict = has("block") ? "blocked" : has("hold") ? "held" : has("clarify") ? "clarify" : "ok";
  return { checks, verdict, reasons, scam, planned };
}
