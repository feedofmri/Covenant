// Plan schemas. The model fills a flat LLM-facing schema whose `payee` field is an enum of the payees that
// are registered right now; deterministic code then converts it into the strict internal Plan.
// The model never writes addresses (except as a new-payee *request*), calldata or base-unit amounts.
import { z } from "zod";

export const ACTION_TYPES = /** @type {const} */ ([
  "pay", "allocate", "reallocate", "supply", "withdraw", "swap", "request_new_payee", "none",
]);
export const Bucket = z.enum(["FAMILY", "EMERGENCY", "SAVINGS"]);
export const Asset = z.enum(["USDC", "EURC"]);
/** Decimal string in asset units: no exponents, no negatives, no hex, at most 6 decimals. */
export const DecimalString = z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, "amount must be a plain decimal like 200 or 12.5");
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const Pay = z.object({
  type: z.literal("pay"),
  payee: z.string().min(1),
  asset: Asset,
  amount: DecimalString,
  bucket: Bucket,
  purpose: z.string().max(80).default(""),
});
const Split = z.object({ bucket: Bucket, amount: DecimalString });
const Allocate = z.object({ type: z.literal("allocate"), asset: Asset, splits: z.array(Split).min(1).max(3) });
const Reallocate = z.object({ type: z.literal("reallocate"), asset: Asset, from: Bucket, to: Bucket, amount: DecimalString });
const Supply = z.object({ type: z.literal("supply"), asset: Asset, amount: DecimalString, bucket: Bucket });
const Withdraw = z.object({ type: z.literal("withdraw"), asset: Asset, amount: DecimalString, bucket: Bucket });
const Swap = z.object({ type: z.literal("swap"), from: Asset, to: Asset, amount: DecimalString, bucket: Bucket });
const RequestNewPayee = z.object({
  type: z.literal("request_new_payee"),
  label: z.string().min(1).max(60),
  address: Address,
});
const None = z.object({ type: z.literal("none"), reason: z.string().max(200) });

export const Action = z.discriminatedUnion("type", [Pay, Allocate, Reallocate, Supply, Withdraw, Swap, RequestNewPayee, None]);

export const Plan = z.object({
  intent: z.string().min(1).max(140),
  actions: z.array(Action).max(5),
  explanation: z.string().max(400),
  clarification: z.string().max(200).optional(),
});

/**
 * Flat schema for the model (structured outputs work best with simple, non-recursive objects).
 * @param {string[]} payeeAliases registered payee aliases, e.g. ["Mother", "School"]
 */
export function buildLlmPlanSchema(payeeAliases) {
  const payees = payeeAliases.length ? payeeAliases : ["(none)"];
  const LlmAction = z.object({
    type: z.enum(ACTION_TYPES),
    payee: z.enum(payees).nullable().describe("Registered payee alias. Only for type=pay."),
    asset: Asset.nullable(),
    to_asset: Asset.nullable().describe("Only for type=swap."),
    amount: z.string().nullable().describe("Decimal amount in asset units, e.g. '200' or '12.5'."),
    bucket: Bucket.nullable().describe("Bucket to draw from (pay/supply/swap) or credit (withdraw)."),
    to_bucket: Bucket.nullable().describe("Only for type=reallocate."),
    splits: z.array(z.object({ bucket: Bucket, amount: z.string() })).nullable().describe("Only for type=allocate."),
    purpose: z.string().nullable(),
    new_payee_label: z.string().nullable().describe("Only for type=request_new_payee."),
    new_payee_address: z.string().nullable().describe("Only for type=request_new_payee."),
    reason: z.string().nullable().describe("Only for type=none."),
  });
  return z.object({
    intent: z.string(),
    actions: z.array(LlmAction),
    explanation: z.string(),
    clarification: z.string().nullable(),
  });
}

/** Convert the flat model output into a strict Plan. Throws a ZodError with readable issues on failure. */
export function llmPlanToPlan(raw) {
  const actions = (raw.actions ?? []).map((a) => {
    switch (a.type) {
      case "pay":
        return { type: "pay", payee: a.payee, asset: a.asset, amount: a.amount, bucket: a.bucket ?? "FAMILY", purpose: a.purpose ?? "" };
      case "allocate":
        return { type: "allocate", asset: a.asset ?? "USDC", splits: a.splits ?? [] };
      case "reallocate":
        return { type: "reallocate", asset: a.asset ?? "USDC", from: a.bucket, to: a.to_bucket, amount: a.amount };
      case "supply":
      case "withdraw":
        return { type: a.type, asset: a.asset ?? "USDC", amount: a.amount, bucket: a.bucket ?? "SAVINGS" };
      case "swap":
        return { type: "swap", from: a.asset, to: a.to_asset, amount: a.amount, bucket: a.bucket ?? "SAVINGS" };
      case "request_new_payee":
        return { type: "request_new_payee", label: a.new_payee_label, address: a.new_payee_address };
      default:
        return { type: "none", reason: a.reason ?? "" };
    }
  });
  return Plan.parse({
    intent: raw.intent,
    actions,
    explanation: raw.explanation ?? "",
    ...(raw.clarification ? { clarification: raw.clarification } : {}),
  });
}

/** Which action types each trigger may produce (trigger-scoped capabilities, firewall rule R-01). */
export const TRIGGER_CAPABILITIES = {
  owner_chat: new Set(ACTION_TYPES),
  incoming_transfer: new Set(["allocate", "none"]),
  schedule: new Set(["pay", "allocate", "supply", "none"]),
  price_event: new Set(["withdraw", "none"]),
  redteam: new Set(ACTION_TYPES),
};
