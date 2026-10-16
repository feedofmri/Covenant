// Offline rule planner: deterministic intent parsing for EN + BN phrases. Used in CI and when no model key
// is configured. Its output goes through exactly the same checks as a model's output.
import { findAmounts, findAddress, findAsset, findPayee } from "./text.js";

const action = (a) => ({
  type: "none", payee: null, asset: null, to_asset: null, amount: null, bucket: null, to_bucket: null,
  splits: null, purpose: null, new_payee_label: null, new_payee_address: null, reason: null, ...a,
});

export function offlineComplete(req) {
  if (req.task === "classify") return classify(req.input ?? "");
  if (req.task === "mandate") return draftMandate(req.input ?? "", req.context ?? {});
  return plan(req);
}

function plan(req) {
  const { text = "", payees = [], trigger = {}, mandate, unallocated = "0" } = req.context ?? {};
  if (trigger.type === "incoming_transfer" && mandate) {
    const total = Number(unallocated);
    const splits = Object.entries(mandate.buckets).filter(([, pct]) => pct > 0)
      .map(([bucket, pct]) => ({ bucket, amount: (Math.floor(total * pct) / 100).toFixed(2) }));
    return {
      intent: `Split ${unallocated} USDC of new income into buckets`,
      actions: [action({ type: "allocate", asset: "USDC", splits })],
      explanation: `Income split by your mandate: ${splits.map((s) => `${s.bucket.toLowerCase()} ${s.amount}`).join(", ")}.`,
      clarification: null,
    };
  }

  const t = text.toLowerCase();
  const amounts = findAmounts(text);
  const amount = amounts[0] ?? null;
  const asset = findAsset(text);
  const address = findAddress(text);
  const payee = findPayee(text, payees);

  if (/\b(balance|how much|status|limits?)\b|কত|ব্যালেন্স/i.test(text)) {
    return { intent: "Show balances", actions: [action({ type: "none", reason: "information request" })], explanation: "Here is your current balance.", clarification: null };
  }
  if (/\b(swap|convert|exchange)\b/i.test(t) && amount) {
    const to = asset === "EURC" && /to\s+(usdc|dollars?)/i.test(t) ? "USDC" : asset === "EURC" ? "EURC" : "EURC";
    const from = to === "EURC" ? "USDC" : "EURC";
    return { intent: `Convert ${amount} ${from} to ${to}`, actions: [action({ type: "swap", asset: from, to_asset: to, amount, bucket: "SAVINGS" })], explanation: `Convert ${amount} ${from} from savings into ${to} at no worse than the oracle price minus 0.5%.`, clarification: null };
  }
  if (/\b(withdraw|take back|redeem)\b/i.test(t) && /\b(lend|lending|pool|yield|savings)\b/i.test(t) && amount) {
    return { intent: `Withdraw ${amount} from lending`, actions: [action({ type: "withdraw", asset: "USDC", amount, bucket: "SAVINGS" })], explanation: `Bring ${amount} USDC back from the lending pool into savings.`, clarification: null };
  }
  if (/\b(lend|supply|earn|yield|invest)\b/i.test(t) && amount) {
    return { intent: `Lend ${amount} of savings`, actions: [action({ type: "supply", asset: "USDC", amount, bucket: "SAVINGS" })], explanation: `Put ${amount} USDC of idle savings into the lending pool, within the exposure cap.`, clarification: null };
  }
  if (/\b(move|put|save)\b/i.test(t) && /\bsavings?\b/i.test(t) && amount) {
    return { intent: `Move ${amount} to savings`, actions: [action({ type: "reallocate", asset: "USDC", amount, bucket: "FAMILY", to_bucket: "SAVINGS" })], explanation: `Move ${amount} USDC from the family bucket to savings.`, clarification: null };
  }
  const payVerb = /\b(send|pay|transfer|give|remit)\b|পাঠা|দাও|দিন/i.test(text);
  if (payVerb && address) {
    const label = (text.match(/\bto\s+(?:the\s+)?([a-z][a-z ]{2,30}?)(?:\s+at|\s+0x|,|\.|$)/i)?.[1] ?? "New payee").trim();
    return {
      intent: `Pay ${amount ?? "?"} ${asset} to a new address`,
      actions: [action({ type: "request_new_payee", new_payee_label: label, new_payee_address: address })],
      explanation: "This address is not one of your registered payees. New payees must be added by you and wait 24 hours before they can be paid.",
      clarification: null,
    };
  }
  if (payVerb && payee && amount) {
    const purpose = /hospital|medical|doctor|হাসপাতাল/i.test(text) ? "medical" : /school|tuition|fees/i.test(text) ? "education" : "family support";
    return {
      intent: `Send ${amount} ${asset} to ${payee}`,
      actions: [action({ type: "pay", payee, asset, amount, bucket: "FAMILY", purpose })],
      explanation: `Pay ${amount} ${asset} to ${payee} (${purpose}) from the family bucket.`,
      clarification: null,
    };
  }
  if (payVerb && !payee) {
    return { intent: "Payment request", actions: [action({ type: "none", reason: "unknown recipient" })], explanation: "I can only pay your registered payees.", clarification: `Who should receive it? Registered payees: ${payees.join(", ") || "none"}.` };
  }
  if (payVerb && !amount) {
    return { intent: "Payment request", actions: [action({ type: "none", reason: "missing amount" })], explanation: "I need an amount.", clarification: `How much should I send to ${payee}?` };
  }
  return { intent: "Unclear request", actions: [action({ type: "none", reason: "not understood" })], explanation: "I did not take any action.", clarification: "Try: 'send 200 to Mother', 'lend 100 of savings', or 'balance'." };
}

const INJECTION = [
  /ignore (all |any |your )?(previous|prior|above) (instructions|rules)/i, /\bsystem\s*:/i, /developer mode/i,
  /send (all|everything|entire|the whole)/i, /transfer (all|everything|entire)/i, /\boverride\b/i,
  /you are now/i, /new instructions/i, /raise (your|the) (daily )?limit/i, /add (a )?payee/i, /0x[0-9a-fA-F]{40}/,
];

function classify(input) {
  const hits = INJECTION.filter((re) => re.test(input));
  const score = Math.min(1, hits.length * 0.35);
  return { injection: score >= 0.35, score, reason: hits.length ? `matched ${hits.length} injection pattern(s)` : "no injection patterns" };
}

function draftMandate(text, ctx) {
  const pct = (name, d) => Number(text.match(new RegExp(`(\\d{1,3})\\s*%\\s*(?:to\\s+|for\\s+)?(?:the\\s+)?${name}`, "i"))?.[1] ?? d);
  const family = pct("family", ctx.buckets?.FAMILY ?? 50);
  const emergency = pct("emergency", ctx.buckets?.EMERGENCY ?? 20);
  const savings = pct("savings?", 100 - family - emergency);
  const remitAmount = text.match(/(?:send|remit)\s+(?:my\s+)?(?:mother|mom|ma)\s+(\d{1,7})|(\d{1,7})\s*(?:usdc|dollars?)?\s+(?:to|for)\s+(?:my\s+)?(?:mother|mom)/i);
  const day = Number(text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?:each|every)\s+month/i)?.[1] ?? 1);
  const perTx = text.match(/(?:per[- ]payment|per transaction|each payment)[^\d]{0,20}(\d{1,7})/i)?.[1] ?? ctx.limits?.perTx ?? "250";
  const daily = text.match(/(?:daily|per day|a day)[^\d]{0,20}(\d{1,7})/i)?.[1] ?? ctx.limits?.daily ?? "300";
  const t2 = text.match(/(?:co-?sign|approve|approval)[^\d]{0,30}(\d{1,7})/i)?.[1] ?? ctx.limits?.t2Ceiling ?? "1000";
  return {
    buckets: { FAMILY: family, EMERGENCY: emergency, SAVINGS: savings },
    remittances: remitAmount ? [{ payee: "Mother", amount: remitAmount[1] ?? remitAmount[2], asset: "USDC", cron: `0 9 ${day} * *`, bucket: "FAMILY" }] : ctx.remittances ?? [],
    emergencyTargetMonths: Number(text.match(/(\d{1,2})\s+months?/i)?.[1] ?? ctx.emergencyTargetMonths ?? 3),
    savings: { liquidBuffer: ctx.savings?.liquidBuffer ?? "100", lendingCapPct: Number(text.match(/lend(?:ing)?[^\d]{0,20}(\d{1,3})\s*%/i)?.[1] ?? ctx.savings?.lendingCapPct ?? 50) },
    limits: { perTx: String(perTx), daily: String(daily), t2Ceiling: String(t2) },
    summary: `Family ${family}%, emergency ${emergency}%, savings ${savings}%. Limits: ${perTx} per payment, ${daily} per day, co-sign up to ${t2}.`,
  };
}
