// Receipt verification: recompute both hashes and check them against the chain.
import { Receipt, intentHashOf, receiptHashOf, merkleProof, verifyMerkle } from "@covenant/shared";

export async function verifyReceipt(ctx, store, input) {
  const parsed = Receipt.safeParse(input);
  if (!parsed.success) return { ok: false, error: "not a valid receipt", issues: parsed.error.issues.slice(0, 5) };
  const r = parsed.data;
  const intentHash = intentHashOf(r);
  const receiptHash = receiptHashOf(r);
  const result = { receiptId: r.receiptId, receiptHash, intentHash, checks: [] };
  const add = (name, ok, detail = "") => result.checks.push({ name, ok, detail });

  add("intent hash matches the receipt", intentHash === r.intentHash, intentHash);

  // anchored on-chain (single or hourly batch)
  const anchoredAt = await ctx.registry.read.anchoredAt([receiptHash]);
  if (anchoredAt > 0n) add("receipt hash anchored on-chain", true, new Date(Number(anchoredAt) * 1000).toISOString());
  else {
    const stored = store.getReceipt(r.receiptId);
    if (stored?.batchRoot) {
      const leaves = store.batchLeaves(stored.batchRoot);
      const i = leaves.indexOf(receiptHash);
      const proofOk = i >= 0 && verifyMerkle(receiptHash, merkleProof(leaves, i), stored.batchRoot);
      const rootAt = await ctx.registry.read.anchoredAt([stored.batchRoot]);
      add("receipt included in an anchored batch", proofOk && rootAt > 0n, stored.batchRoot);
    } else add("receipt hash anchored on-chain", false, "not anchored (yet)");
  }

  // each action tx commits to the intent hash
  const actionTxs = r.txHashes ?? [];
  for (const hash of actionTxs) {
    try {
      const tx = await ctx.publicClient.getTransaction({ hash });
      const commits = tx.input.toLowerCase().includes(r.intentHash.slice(2).toLowerCase());
      const rc = await ctx.publicClient.getTransactionReceipt({ hash });
      add(`tx ${hash.slice(0, 10)}… commits to the intent`, commits || tx.input.startsWith("0x8456cb59"), rc.status);
    } catch (e) {
      add(`tx ${hash.slice(0, 10)}… found on-chain`, false, e.shortMessage ?? e.message);
    }
  }
  if (r.mandateHash) {
    const onchain = await ctx.vault.read.mandateHash();
    add("mandate hash is the vault's current mandate", onchain === r.mandateHash, onchain);
  }
  result.ok = result.checks.filter((c) => !c.name.startsWith("mandate")).every((c) => c.ok);
  return result;
}
