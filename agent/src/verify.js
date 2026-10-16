// Post-trade verification: actual vault deltas (from Transfer logs) must match the simulation. A mismatch trips
// the circuit breaker (the agent may pause; only the owner can unpause).
import { decodeEventLog, formatUnits, parseAbi } from "viem";

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export function actualDeltas(ctx, receipts) {
  const vault = ctx.vault.address.toLowerCase();
  const bySym = Object.fromEntries(Object.keys(ctx.tokens).map((k) => [k, 0n]));
  const symOf = Object.fromEntries(Object.entries(ctx.tokens).map(([k, t]) => [t.address.toLowerCase(), k]));
  for (const r of receipts) {
    for (const log of r.logs) {
      const sym = symOf[log.address.toLowerCase()];
      if (!sym) continue;
      let ev;
      try {
        ev = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (ev.args.from.toLowerCase() === vault) bySym[sym] -= ev.args.value;
      if (ev.args.to.toLowerCase() === vault) bySym[sym] += ev.args.value;
    }
  }
  return bySym;
}

export function compareDeltas(simulated, actual, calls, tolerance = 1n) {
  const swapsOut = new Set(calls.filter((c) => c.type === "swap").map((c) => c.toAsset));
  for (const [sym, s] of Object.entries(simulated ?? {})) {
    const a = actual[sym] ?? 0n;
    if (swapsOut.has(sym)) {
      // output within 1% of the simulation
      const diff = a > s ? a - s : s - a;
      if (s !== 0n && diff * 100n > (s < 0n ? -s : s)) return { ok: false, asset: sym, simulated: s, actual: a };
      continue;
    }
    const diff = a > s ? a - s : s - a;
    if (diff > tolerance && !calls.some((c) => c.type === "withdraw" && c.asset === sym)) return { ok: false, asset: sym, simulated: s, actual: a };
  }
  return { ok: true };
}

export const fmtDeltas = (d, state) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, formatUnits(v, state.assets[k].decimals)]));
