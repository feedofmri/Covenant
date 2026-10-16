// Pre-trade simulation. Preferred: run the exact calls on a fork node (anvil or hardhat) impersonating the agent,
// measure real balance deltas, then revert. Fallback: eth_call each call (no chained state, predicted deltas).
import { createPublicClient, createWalletClient, http, formatUnits, decodeErrorResult } from "viem";

export function expectedDeltas(calls, state) {
  const d = {};
  const add = (sym, v) => (d[sym] = (d[sym] ?? 0n) + v);
  for (const c of calls) {
    if (c.type === "pay" || c.type === "supply") add(c.asset, -c.amount);
    if (c.type === "swap") add(c.asset, -c.amount);
  }
  for (const sym of Object.keys(state.assets)) d[sym] ??= 0n;
  return d;
}

const fmtDeltas = (d, state) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, formatUnits(v, state.assets[k].decimals)]));

/** Do measured deltas match the plan? pay/supply exact, swap: input exact and output positive, withdraw ≥ 0. */
export function matchesPlan(measured, calls, state, tolerance = 1n) {
  const exp = expectedDeltas(calls, state);
  const swapsOut = new Set(calls.filter((c) => c.type === "swap").map((c) => c.toAsset));
  const withdraws = new Set(calls.filter((c) => c.type === "withdraw").map((c) => c.asset));
  for (const [sym, e] of Object.entries(exp)) {
    const m = measured[sym] ?? 0n;
    if (swapsOut.has(sym) || withdraws.has(sym)) {
      if (m < e) return { ok: false, asset: sym, expected: e, measured: m };
      continue;
    }
    const diff = m > e ? m - e : e - m;
    if (diff > tolerance) return { ok: false, asset: sym, expected: e, measured: m };
  }
  return { ok: true };
}

function revertReason(e, abi) {
  for (let c = e, i = 0; c && i < 8; c = c.cause, i++) {
    if (c.data?.errorName) return `${c.data.errorName}(${(c.data.args ?? []).map(String).join(", ")})`;
    const raw = typeof c.data === "string" ? c.data : c.data?.data;
    if (typeof raw === "string" && raw.startsWith("0x") && raw.length >= 10) {
      try {
        const d = decodeErrorResult({ abi, data: raw });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch { /* not a known error */ }
    }
  }
  return e.shortMessage ?? e.message;
}

export async function simulate(ctx, calls, state, config) {
  const vaultAddr = ctx.vault.address;
  const agent = ctx.account?.address ?? state.agent;
  if (!calls.length) return { ok: true, mode: "none", deltas: {}, simulated: {} };

  // Modes: "fork" (a separate anvil/hardhat fork node, production), "snapshot" (evm_snapshot/evm_revert on the
  // local dev chain itself, chain 31337 only), "eth_call" (fallback).
  const mode = config.simMode || (config.simRpcUrl ? "fork" : ctx.deployment.chainId === 31337 ? "snapshot" : "eth_call");
  if (mode === "snapshot" && ctx.deployment.chainId !== 31337) throw new Error("snapshot simulation is only allowed on a local dev chain");
  const simUrl = mode === "fork" ? config.simRpcUrl : mode === "snapshot" ? config.rpcUrls[0] : null;

  if (simUrl) {
    const transport = http(simUrl, { timeout: 30000 });
    const sim = createPublicClient({ chain: ctx.chain, transport, pollingInterval: 50 });
    const req = (method, params = []) =>
      sim.request({ method, params }).catch((e) => {
        e.shortMessage = `${method}: ${e.shortMessage ?? e.message}`;
        throw e;
      });
    try {
      if (mode === "fork" && config.simForkUrl) {
        const latest = await ctx.publicClient.getBlockNumber();
        await req("hardhat_reset", [{ forking: { jsonRpcUrl: config.simForkUrl, blockNumber: Number(latest) } }]).catch(() =>
          req("anvil_reset", [{ forking: { jsonRpcUrl: config.simForkUrl, blockNumber: Number(latest) } }]));
      }
      const snap = await req("evm_snapshot");
      try {
        await req("hardhat_impersonateAccount", [agent]);
        if (mode === "fork") await req("hardhat_setBalance", [agent, "0x56BC75E2D63100000"]);
        const wallet = createWalletClient({ account: agent, chain: ctx.chain, transport });
        const bal = async () => {
          const out = {};
          for (const [sym, t] of Object.entries(ctx.tokens)) out[sym] = await sim.readContract({ address: t.address, abi: ctx.abis.erc20, functionName: "balanceOf", args: [vaultAddr] });
          return out;
        };
        const before = await bal();
        for (const c of calls) {
          try {
            await sim.simulateContract({ account: agent, address: vaultAddr, abi: ctx.abis.vault, functionName: c.fn, args: c.args });
          } catch (e) {
            return { ok: false, mode, error: revertReason(e, ctx.abis.vault), call: c.type };
          }
          const hash = await wallet.writeContract({ address: vaultAddr, abi: ctx.abis.vault, functionName: c.fn, args: c.args, gas: 1_500_000n });
          const r = await sim.waitForTransactionReceipt({ hash });
          if (r.status !== "success") return { ok: false, mode, error: "reverted in simulation", call: c.type };
        }
        const after = await bal();
        const deltas = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
        return { ok: true, mode, deltas, simulated: fmtDeltas(deltas, state) };
      } finally {
        await req("evm_revert", [snap]).catch(() => {});
        if (mode === "fork") await req("hardhat_stopImpersonatingAccount", [agent]).catch(() => {});
      }
    } catch (e) {
      return { ok: false, mode, error: `simulation node error: ${e.shortMessage ?? e.message}${e.details ? ` (${e.details})` : ""}` };
    }
  }

  // Fallback: eth_call each call against current state (first call exact; later calls see unchained state).
  for (const c of calls) {
    try {
      await ctx.publicClient.simulateContract({ account: agent, address: vaultAddr, abi: ctx.abis.vault, functionName: c.fn, args: c.args });
    } catch (e) {
      return { ok: false, mode: "eth_call", error: revertReason(e, ctx.abis.vault), call: c.type };
    }
    if (calls.length > 1) break; // later calls depend on earlier state; rely on the contract + post-trade verify
  }
  const deltas = expectedDeltas(calls, state);
  return { ok: true, mode: "eth_call", deltas, simulated: fmtDeltas(deltas, state), predicted: true };
}

export { revertReason };
