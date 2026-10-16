// RED-TEAM: "assume the agent is hijacked". Sends worst-case calls straight to the vault with the agent key,
// skipping every off-chain layer. Explicit gas and nonce skip estimation so reverts are broadcast and get a hash.
import { encodeFunctionData } from "viem";
import { revertReason } from "./simulate.js";

export async function forcedCall(ctx, { fn, args, to, abi, data, from = ctx.walletClient }) {
  const target = to ?? ctx.vault.address;
  const calldata = data ?? encodeFunctionData({ abi: abi ?? ctx.abis.vault, functionName: fn, args });
  let reason = null;
  try {
    await ctx.publicClient.call({ account: from.account, to: target, data: calldata });
  } catch (e) {
    reason = revertReason(e, [...ctx.abis.vault, ...ctx.abis.erc20, ...ctx.abis.amm, ...(abi ?? [])]);
  }
  const nonce = await ctx.publicClient.getTransactionCount({ address: from.account.address, blockTag: "pending" });
  const hash = await from.sendTransaction({ to: target, data: calldata, gas: 400_000n, nonce });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, reason, gasUsed: receipt.gasUsed };
}
