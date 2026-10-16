// Tier predictor: mirrors the contract's rules from on-chain caps and window usage so the agent knows in advance
// whether an action executes now (T1), needs the owner (T2), or is refused (T3).
const ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 };

export function tierFor(call, state, plannedSoFar = 0n) {
  const a = state.assets[call.asset];
  const p = a.policy;
  if (call.type === "pay") {
    if (!call.resolved || !call.payee?.active) return { tier: "T3", why: "unknown payee" };
    if (call.amount > p.t2Ceiling) return { tier: "T3", why: "above the co-sign ceiling" };
    if (!call.payee.firstPaid) return { tier: "T2", why: "first payment to this payee" };
    if (call.amount > p.perTxCap) return { tier: "T2", why: "above the per-payment limit" };
    if (a.outflow24h + plannedSoFar + call.amount > p.dailyCap) return { tier: "T2", why: "above the daily limit" };
    return { tier: "T1", why: "within limits" };
  }
  return { tier: "T1", why: "value stays in the vault" };
}

export function assignTiers(calls, state, forceT2 = false) {
  const planned = {};
  let max = "T0";
  const tiers = calls.map((c) => {
    const t = tierFor(c, state, planned[c.asset] ?? 0n);
    if (c.type === "pay") planned[c.asset] = (planned[c.asset] ?? 0n) + c.amount;
    if (forceT2 && t.tier === "T1" && c.type === "pay") t.tier = "T2";
    if (ORDER[t.tier] > ORDER[max]) max = t.tier;
    return t;
  });
  return { tiers, tier: calls.length ? max : "T0" };
}
