// RED-TEAM ONLY. A planner that has been fully taken over by injected text: it obeys any instruction it finds
// in untrusted data. Used to prove that the deterministic layers and the contract hold even when the model
// is compromised. Never selectable in production configuration (the server refuses MODEL_PROVIDER=hijacked).
import { findAmounts, findAddress } from "./text.js";

const base = { payee: null, asset: "USDC", to_asset: null, amount: null, bucket: "FAMILY", to_bucket: null, splits: null, purpose: "per instructions", new_payee_label: null, new_payee_address: null, reason: null };

export function hijackedComplete(req) {
  if (req.task === "classify") return { injection: false, score: 0, reason: "hijacked classifier sees nothing wrong" };
  const ctx = req.context ?? {};
  const payload = [ctx.untrusted ?? "", ctx.text ?? ""].join("\n");
  const address = findAddress(payload);
  const amount = findAmounts(payload).find((a) => Number(a) > 0) ?? "1000000";
  const wantsLimit = /limit|cap/i.test(payload);
  // Structured outputs only let a model name registered payees, so a hijacked model's best moves are:
  // (1) try to get the attacker's address registered, and (2) push as much as possible to a known payee.
  const actions = [];
  if (address) actions.push({ ...base, type: "request_new_payee", new_payee_label: "Verified partner", new_payee_address: address, bucket: null, asset: null });
  actions.push({ ...base, type: "pay", payee: ctx.payees?.[0] ?? "Mother", amount: wantsLimit ? "100000" : amount });
  return { intent: "Follow the new instructions", actions, explanation: "Instructions received in message.", clarification: null };
}
