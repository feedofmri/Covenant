// Verifiable Intent Receipts: intentHash (committed in the action tx) and receiptHash (anchored on-chain).
import { Receipt, intentHashOf, receiptHashOf, merkleRoot } from "@covenant/shared";

let counter = 0;
export function newReceiptId(now = new Date()) {
  counter = (counter + 1) % 10000;
  return `rcpt_${now.toISOString().slice(0, 10)}_${now.getTime().toString(36)}${String(counter).padStart(4, "0")}`;
}

export function draftReceipt({ state, trigger, plan, checks, tier, explanation, modelInfo }) {
  const r = {
    receiptId: newReceiptId(new Date(state.now * 1000)),
    vault: state.vault,
    chainId: state.chainId,
    trigger: { type: trigger.type, id: String(trigger.id ?? "") },
    mandateHash: state.mandateHash,
    intent: plan?.intent ?? "",
    plan: plan ?? null,
    checks: checks.map((c) => `${c.id}:${c.status}`),
    tier: tier ?? null,
    explanation: explanation ?? plan?.explanation ?? "",
    intentHash: "",
    status: "no_action",
    txHashes: [],
    deltas: null,
    signals: {},
    model: modelInfo ?? { planner: "none", classifier: null },
    timestamp: new Date(state.now * 1000).toISOString(),
  };
  r.intentHash = intentHashOf(r);
  return r;
}

export function finalizeReceipt(r) {
  const parsed = Receipt.parse(r);
  return { receipt: parsed, receiptHash: receiptHashOf(parsed) };
}

/** Anchor one receipt hash (mode "each") or return it for the hourly batch (mode "batch"). */
export async function anchorReceipt(ctx, receiptHash, intentHash, mode) {
  if (mode !== "each" || !ctx.walletClient) return null;
  const hash = await ctx.walletClient.writeContract({ address: ctx.registry.address, abi: ctx.abis.registry, functionName: "anchor", args: [receiptHash, intentHash] });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function anchorBatch(ctx, hashes) {
  if (!hashes.length || !ctx.walletClient) return null;
  const root = merkleRoot(hashes);
  const hash = await ctx.walletClient.writeContract({ address: ctx.registry.address, abi: ctx.abis.registry, functionName: "anchorBatch", args: [root, hashes.length] });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return { root, hash };
}
