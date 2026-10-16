// Scam-pattern score: protects the user from human scammers (the second direction of the two-way guardrails).
import { SCAM } from "@covenant/shared";

/**
 * @param {object} p
 * @param {string} p.text owner's request text (may be empty for scheduled actions)
 * @param {object|null} p.payee payee record from observe() (null for a new-payee request)
 * @param {boolean} p.newPayee true when the request is to pay or add an unregistered recipient
 * @param {number} p.amount amount in asset units
 * @param {number[]} p.history past payment amounts (asset units)
 * @param {boolean} p.untrustedOrigin the request came from a forwarded/untrusted channel
 * @param {number} p.now unix seconds; p.tzOffsetMin owner timezone offset
 */
export function scamScore({ text = "", payee = null, newPayee = false, amount = 0, history = [], untrustedOrigin = false, now = Date.now() / 1000, tzOffsetMin = 360 }) {
  const w = SCAM.weights;
  const features = {};
  if (newPayee || payee?.coolingOff) features.payeeCoolingOff = w.payeeCoolingOff;
  else if (payee?.addedAt && now - payee.addedAt < SCAM.youngPayeeDays * 86400) features.payeeYoung = w.payeeYoung;
  const lower = text.toLowerCase();
  const hits = SCAM.keywords.filter((k) => lower.includes(k));
  if (hits.length) features.urgencyLanguage = w.urgencyLanguage;
  if (history.length >= 1 && amount > 0) {
    const sorted = [...history].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0 && amount > SCAM.unusualMultiple * median) features.unusualAmount = w.unusualAmount;
  }
  if (untrustedOrigin) features.untrustedOrigin = w.untrustedOrigin;
  const hour = Math.floor(((now / 60 + tzOffsetMin) % 1440) / 60);
  if (hour >= 0 && hour < 5) features.oddHour = w.oddHour;
  const score = Math.round(Object.values(features).reduce((a, b) => a + b, 0) * 100) / 100;
  return { score, held: score >= SCAM.threshold, features, keywords: hits };
}

export function explainScam(result) {
  const parts = [];
  if (result.features.payeeCoolingOff) parts.push("the recipient is new to you");
  if (result.features.payeeYoung) parts.push("the recipient was added only recently");
  if (result.features.urgencyLanguage) parts.push(`the request uses pressure words (${result.keywords.slice(0, 3).join(", ")})`);
  if (result.features.unusualAmount) parts.push("the amount is much larger than your usual payments");
  if (result.features.untrustedOrigin) parts.push("the request came from a forwarded message");
  if (result.features.oddHour) parts.push("it is the middle of the night");
  return parts.length ? `This looks like a common scam pattern: ${parts.join(", ")}.` : "";
}
