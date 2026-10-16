// Deterministic plans for scheduled mandates. The unattended run never depends on a model.
import { formatUnits } from "viem";

export function remittancePlan(remittance) {
  return {
    intent: `Send scheduled support to ${remittance.payee}`,
    actions: [{ type: "pay", payee: remittance.payee, asset: remittance.asset ?? "USDC", amount: remittance.amount, bucket: remittance.bucket ?? "FAMILY", purpose: "scheduled remittance" }],
    explanation: `Scheduled ${remittance.amount} ${remittance.asset ?? "USDC"} to ${remittance.payee}, as set in your mandate.`,
  };
}

/** Split all unallocated USDC by the mandate's bucket percentages (floor to cents, remainder to SAVINGS). */
export function allocationPlan(state) {
  const a = state.assets.USDC;
  const m = state.mandate;
  const total = a.unallocated;
  if (!m || total === 0n) return null;
  const cents = 10n ** BigInt(Math.max(a.decimals - 2, 0));
  const splits = [];
  let used = 0n;
  for (const [bucket, pct] of Object.entries(m.buckets)) {
    if (!pct) continue;
    const amt = ((total * BigInt(pct)) / 100n / cents) * cents;
    splits.push({ bucket, raw: amt });
    used += amt;
  }
  const savings = splits.find((s) => s.bucket === "SAVINGS") ?? splits.at(-1);
  savings.raw += total - used;
  return {
    intent: `Split ${formatUnits(total, a.decimals)} USDC of new income into buckets`,
    actions: [{ type: "allocate", asset: "USDC", splits: splits.filter((s) => s.raw > 0n).map((s) => ({ bucket: s.bucket, amount: formatUnits(s.raw, a.decimals) })) }],
    explanation: `New income split by your mandate: ${splits.map((s) => `${s.bucket.toLowerCase()} ${formatUnits(s.raw, a.decimals)}`).join(", ")}.`,
  };
}

/** Keep the liquid buffer in SAVINGS and lend the excess, within the lending cap. */
export function savingsSweepPlan(state) {
  const a = state.assets.USDC;
  const m = state.mandate;
  if (!m) return null;
  const buffer = BigInt(Math.round(Number(m.savings.liquidBuffer) * 10 ** a.decimals));
  const idle = a.buckets.SAVINGS > buffer ? a.buckets.SAVINGS - buffer : 0n;
  const capLeft = a.policy.lendingCap > a.supplied ? a.policy.lendingCap - a.supplied : 0n;
  const pctCap = ((a.buckets.SAVINGS + a.supplied) * BigInt(m.savings.lendingCapPct)) / 100n;
  const pctLeft = pctCap > a.supplied ? pctCap - a.supplied : 0n;
  let amt = [idle, capLeft, pctLeft].reduce((x, y) => (x < y ? x : y));
  amt -= amt % 10n ** BigInt(Math.max(a.decimals - 2, 0));
  if (amt < 10n ** BigInt(a.decimals)) return null; // less than 1 unit: nothing to do
  const amount = formatUnits(amt, a.decimals);
  return {
    intent: `Lend ${amount} USDC of idle savings`,
    actions: [{ type: "supply", asset: "USDC", amount, bucket: "SAVINGS" }],
    explanation: `Savings above the ${m.savings.liquidBuffer} USDC buffer go to the lending pool (cap ${m.savings.lendingCapPct}% of savings).`,
  };
}
