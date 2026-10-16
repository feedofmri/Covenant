// Observe: one consistent snapshot of everything the agent may reason about. Read-only (tier T0).
import { formatUnits } from "viem";
import { BUCKETS, BUCKET_NAMES } from "@covenant/shared";

export async function observe(ctx, store) {
  const { vault, publicClient } = ctx;
  const block = await publicClient.getBlock();
  const [paused, agent, agentExpiresAt, mandateHash, coolingOff] = await Promise.all([
    vault.read.paused(), vault.read.agent(), vault.read.agentExpiresAt(), vault.read.mandateHash(), vault.read.coolingOff(),
  ]);

  const assets = {};
  for (const [sym, t] of Object.entries(ctx.tokens)) {
    const [decimals, balance, unallocated, policy, outflow24h, swap24h, supplied, round] = await Promise.all([
      t.contract.read.decimals(),
      t.contract.read.balanceOf([vault.address]),
      vault.read.unallocated([t.address]),
      vault.read.getAssetPolicy([t.address]),
      vault.read.outflowLast24h([t.address]),
      vault.read.swapVolumeLast24h([t.address]),
      vault.read.supplied([t.address]),
      publicClient.readContract({ address: t.oracle, abi: ctx.abis.oracle, functionName: "latestRoundData" }),
    ]);
    const buckets = {};
    for (const b of BUCKET_NAMES) buckets[b] = await vault.read.bucketBalance([t.address, BUCKETS[b]]);
    assets[sym] = {
      symbol: sym, address: t.address, decimals: Number(decimals), balance, unallocated, buckets, policy,
      outflow24h, swap24h, supplied, price: Number(round[1]) / 1e8, priceUpdatedAt: Number(round[3]),
    };
  }

  const known = store.listPayees();
  const payees = [];
  for (const p of known) {
    const onchain = await vault.read.getPayee([p.id]);
    payees.push({
      alias: p.alias, id: p.id, address: onchain.wallet, purpose: p.purpose ?? "",
      active: onchain.active, activeFrom: Number(onchain.activeFrom), firstPaid: onchain.firstPaid,
      coolingOff: onchain.active && Number(onchain.activeFrom) > Number(block.timestamp),
      addedAt: p.addedAt ?? null,
    });
  }

  return {
    chainId: ctx.deployment.chainId,
    vault: vault.address,
    now: Number(block.timestamp),
    blockNumber: Number(block.number),
    paused, agent, agentExpiresAt: Number(agentExpiresAt), mandateHash, coolingOff: Number(coolingOff),
    assets, payees,
    mandate: store.getMandate(),
    openProposals: store.listProposals({ status: "open" }),
  };
}

/** A compact, model-safe view of state: aliases instead of addresses, human units, no PII. */
export function stateForModel(state) {
  const fmt = (a, v) => formatUnits(v, a.decimals);
  return {
    paused: state.paused,
    assets: Object.fromEntries(Object.values(state.assets).map((a) => [a.symbol, {
      balance: fmt(a, a.balance), unallocated: fmt(a, a.unallocated),
      buckets: Object.fromEntries(Object.entries(a.buckets).map(([k, v]) => [k, fmt(a, v)])),
      limits: { perPayment: fmt(a, a.policy.perTxCap), daily: fmt(a, a.policy.dailyCap), coSignCeiling: fmt(a, a.policy.t2Ceiling) },
      paidLast24h: fmt(a, a.outflow24h), lent: fmt(a, a.supplied), priceUsd: a.price,
    }])),
    payees: state.payees.filter((p) => p.active).map((p) => ({ alias: p.alias, purpose: p.purpose, coolingOff: p.coolingOff })),
    mandate: state.mandate ? {
      buckets: state.mandate.buckets, remittances: state.mandate.remittances.map((r) => ({ payee: r.payee, amount: r.amount, asset: r.asset })),
      savings: state.mandate.savings, emergencyTargetMonths: state.mandate.emergencyTargetMonths,
    } : null,
  };
}
