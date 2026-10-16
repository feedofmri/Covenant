// Compiler: Plan → exact vault calls. Deterministic, no model. Decimals come from the chain, payee ids from
// the on-chain registry; anything that cannot be resolved is marked unresolved and blocked by the risk engine.
import { parseUnits, encodeFunctionData } from "viem";
import { BUCKETS, payeeId, labelId } from "@covenant/shared";

export function compile(plan, state, intentHash) {
  const calls = [];
  const ownerActions = [];
  for (const action of plan.actions) {
    const asset = state.assets[action.asset ?? action.from ?? "USDC"];
    const units = (v) => parseUnits(v, asset.decimals);
    switch (action.type) {
      case "pay": {
        const payee = state.payees.find((p) => p.alias.toLowerCase() === action.payee.toLowerCase());
        const id = payee?.id ?? payeeId(action.payee);
        calls.push({
          type: "pay", fn: "pay", args: [id, asset.address, units(action.amount), BUCKETS[action.bucket], intentHash],
          asset: asset.symbol, amount: units(action.amount), payee: payee ?? null, payeeAlias: action.payee, bucket: action.bucket,
          purpose: action.purpose, resolved: Boolean(payee),
        });
        break;
      }
      case "allocate":
        calls.push({
          type: "allocate", fn: "allocate",
          args: [asset.address, action.splits.map((s) => BUCKETS[s.bucket]), action.splits.map((s) => units(s.amount)), intentHash],
          asset: asset.symbol, amount: action.splits.reduce((t, s) => t + units(s.amount), 0n), splits: action.splits, resolved: true,
        });
        break;
      case "reallocate":
        calls.push({ type: "reallocate", fn: "reallocate", args: [asset.address, BUCKETS[action.from], BUCKETS[action.to], units(action.amount), intentHash], asset: asset.symbol, amount: units(action.amount), bucket: action.from, resolved: action.from !== action.to });
        break;
      case "supply":
      case "withdraw":
        calls.push({ type: action.type, fn: action.type, args: [BUCKETS[action.bucket], asset.address, units(action.amount), intentHash], asset: asset.symbol, amount: units(action.amount), bucket: action.bucket, resolved: true });
        break;
      case "swap": {
        const out = state.assets[action.to];
        calls.push({ type: "swap", fn: "swap", args: [BUCKETS[action.bucket], asset.address, out.address, units(action.amount), intentHash], asset: asset.symbol, toAsset: out.symbol, amount: units(action.amount), bucket: action.bucket, resolved: action.from !== action.to });
        break;
      }
      case "request_new_payee": {
        const id = payeeId(action.label);
        ownerActions.push({
          type: "add_payee", label: action.label, address: action.address, payeeId: id,
          data: encodeFunctionData({ abi: [{ type: "function", name: "addPayee", inputs: [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }], outputs: [], stateMutability: "nonpayable" }], functionName: "addPayee", args: [id, action.address, labelId(action.label)] }),
        });
        break;
      }
      default:
        break;
    }
  }
  return { calls, ownerActions };
}
