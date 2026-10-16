// Mandate builder: plain English → structured mandate → validation → the exact owner transactions.
import { z } from "zod";
import { encodeFunctionData, parseUnits, formatUnits } from "viem";
import { Mandate, hashCanonical, Remittance } from "@covenant/shared";

const Draft = z.object({
  buckets: z.object({ FAMILY: z.number().int(), EMERGENCY: z.number().int(), SAVINGS: z.number().int() }),
  remittances: z.array(Remittance.extend({ asset: z.enum(["USDC", "EURC"]), bucket: z.enum(["FAMILY", "EMERGENCY", "SAVINGS"]) })),
  emergencyTargetMonths: z.number().int(),
  savings: z.object({ liquidBuffer: z.string(), lendingCapPct: z.number().int() }),
  limits: z.object({ perTx: z.string(), daily: z.string(), t2Ceiling: z.string() }),
  summary: z.string(),
});

const SYSTEM = `You turn a migrant worker's plain-English description of how they want their wallet to behave into a
structured mandate. Bucket percentages must sum to 100. Remittances use node-cron expressions (minute hour day month
weekday), e.g. "0 9 1 * *" for 09:00 on the 1st of each month. Amounts are plain decimal strings. Keep any value the
person did not mention as in the current mandate. The summary is two short sentences in plain English.`;

export async function draftMandate({ model, text, current, onchain, provider }) {
  const { output, model: used } = await model.complete({
    task: "mandate",
    provider,
    system: SYSTEM,
    user: `Current mandate:\n${JSON.stringify({ buckets: current.buckets, remittances: current.remittances, emergencyTargetMonths: current.emergencyTargetMonths, savings: current.savings, limits: current.limits })}\n\nThe owner says:\n${text}`,
    schema: Draft,
    input: text,
    context: current,
  });
  const merged = { ...current, ...output, version: 1 };
  delete merged.summary;
  const parsed = Mandate.safeParse(merged);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), draft: merged, summary: output.summary, model: used };
  }
  const mandate = parsed.data;
  const mandateHash = hashCanonical(mandate);
  return { ok: true, mandate, mandateHash, summary: output.summary, model: used, txs: ownerTxs(mandate, mandateHash, onchain) };
}

/** Which owner transactions realise this mandate: tightening is instant, loosening is queued behind the timelock. */
export function ownerTxs(mandate, mandateHash, onchain) {
  const { vaultAbi, vault, usdc, policy } = onchain;
  const u = (v) => parseUnits(v, 6);
  const next = { perTxCap: u(mandate.limits.perTx), dailyCap: u(mandate.limits.daily), t2Ceiling: u(mandate.limits.t2Ceiling) };
  const txs = [{ to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "setMandateHash", args: [mandateHash] }), description: "Record the new mandate hash (instant)", timelocked: false }];
  const loosen = next.perTxCap > policy.perTxCap || next.dailyCap > policy.dailyCap || next.t2Ceiling > policy.t2Ceiling;
  const tighten = next.perTxCap < policy.perTxCap || next.dailyCap < policy.dailyCap || next.t2Ceiling < policy.t2Ceiling;
  if (loosen) {
    const change = encodeFunctionData({ abi: vaultAbi, functionName: "changeAssetPolicy", args: [usdc, { ...policy, ...next }] });
    txs.push({ to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "queueChange", args: [change] }), description: `Queue higher limits (${formatUnits(next.perTxCap, 6)} / ${formatUnits(next.dailyCap, 6)} / ${formatUnits(next.t2Ceiling, 6)}); they apply after the timelock`, timelocked: true, change });
  } else if (tighten) {
    txs.push({ to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "lowerCaps", args: [usdc, next.perTxCap, next.dailyCap, next.t2Ceiling, policy.dailySwapCap] }), description: "Lower the limits (instant)", timelocked: false });
  }
  return txs;
}
