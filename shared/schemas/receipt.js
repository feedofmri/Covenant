// Verifiable Intent Receipt. intentHash commits to the pre-execution part; receiptHash to the whole receipt.
import { z } from "zod";
import { hashCanonical } from "../canonical.js";

export const Receipt = z.object({
  receiptId: z.string(),
  vault: z.string(),
  chainId: z.number(),
  trigger: z.object({ type: z.string(), id: z.string() }),
  mandateHash: z.string(),
  intent: z.string(),
  plan: z.any(),
  checks: z.array(z.string()),
  tier: z.enum(["T0", "T1", "T2", "T3"]).nullable(),
  explanation: z.string(),
  intentHash: z.string(),
  status: z.enum(["executed", "awaiting_owner", "blocked", "refused", "sim_mismatch", "held", "failed", "verify_mismatch", "no_action"]),
  txHashes: z.array(z.string()),
  deltas: z.object({ simulated: z.record(z.string(), z.string()), actual: z.record(z.string(), z.string()) }).nullable(),
  signals: z.record(z.string(), z.any()).default({}),
  model: z.object({ planner: z.string(), classifier: z.string().nullable() }),
  timestamp: z.string(),
});

/** The pre-execution fields the action transaction commits to. */
export const INTENT_FIELDS = ["receiptId", "vault", "chainId", "trigger", "mandateHash", "intent", "plan", "checks", "tier", "explanation"];

export function intentHashOf(r) {
  return hashCanonical(Object.fromEntries(INTENT_FIELDS.map((k) => [k, r[k]])));
}

export function receiptHashOf(r) {
  return hashCanonical(r);
}
