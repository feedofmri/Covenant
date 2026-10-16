// Mandate: the owner's standing instructions in plain structured form. Its canonical hash is set on the vault
// and referenced by every receipt.
import { z } from "zod";
import { DecimalString, Address } from "./plan.js";

const Pct = z.number().int().min(0).max(100);

export const Remittance = z.object({
  payee: z.string().min(1),
  amount: DecimalString,
  asset: z.enum(["USDC", "EURC"]).default("USDC"),
  cron: z.string().min(9).describe("node-cron expression"),
  bucket: z.enum(["FAMILY", "EMERGENCY", "SAVINGS"]).default("FAMILY"),
});

export const MandatePayee = z.object({ alias: z.string().min(1), address: Address, purpose: z.string().max(80) });

export const Mandate = z
  .object({
    version: z.literal(1).default(1),
    owner: Address,
    guardian: Address.nullable(),
    currency: z.literal("USDC").default("USDC"),
    buckets: z.object({ FAMILY: Pct, EMERGENCY: Pct, SAVINGS: Pct }),
    emergencyTargetMonths: z.number().int().min(0).max(24).default(3),
    payees: z.array(MandatePayee).max(10).default([]),
    remittances: z.array(Remittance).max(10).default([]),
    savings: z.object({ liquidBuffer: DecimalString, lendingCapPct: Pct }),
    limits: z.object({ perTx: DecimalString, daily: DecimalString, t2Ceiling: DecimalString }),
    jurisdictionPack: z.string().default("demo-testnet"),
  })
  .superRefine((m, ctx) => {
    const sum = m.buckets.FAMILY + m.buckets.EMERGENCY + m.buckets.SAVINGS;
    if (sum !== 100) ctx.addIssue({ code: "custom", message: `bucket percentages must sum to 100 (got ${sum})`, path: ["buckets"] });
    const per = Number(m.limits.perTx);
    const daily = Number(m.limits.daily);
    const t2 = Number(m.limits.t2Ceiling);
    if (!(per <= daily)) ctx.addIssue({ code: "custom", message: "per-payment limit must not exceed the daily limit", path: ["limits"] });
    if (!(daily <= t2)) ctx.addIssue({ code: "custom", message: "daily limit must not exceed the co-sign ceiling", path: ["limits"] });
    for (const r of m.remittances) {
      if (!m.payees.some((p) => p.alias.toLowerCase() === r.payee.toLowerCase()))
        ctx.addIssue({ code: "custom", message: `remittance payee "${r.payee}" is not in payees`, path: ["remittances"] });
    }
  });
