// Text helpers shared by the offline and hijacked planners.
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

export const normalizeDigits = (s) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

export function findAmounts(text) {
  return [...normalizeDigits(text).matchAll(/(?<![\w.])(\d{1,9}(?:\.\d{1,6})?)(?![\w.])/g)].map((m) => m[1]);
}

export const findAddress = (text) => text.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? null;

export function findAsset(text) {
  if (/\beurc?\b|€|euro/i.test(text)) return "EURC";
  return "USDC";
}

const SYNONYMS = {
  mother: ["mother", "mom", "mum", "ma", "amma", "ammu", "maa", "মা", "মাকে", "আম্মু", "আম্মা"],
  school: ["school", "tuition", "school fees", "স্কুল"],
};

export function findPayee(text, aliases) {
  const t = text.toLowerCase();
  for (const alias of aliases) {
    if (t.includes(alias.toLowerCase())) return alias;
    for (const syn of SYNONYMS[alias.toLowerCase()] ?? []) {
      const re = new RegExp(`(^|[^\\p{L}])${syn}([^\\p{L}]|$)`, "iu");
      if (re.test(text)) return alias;
    }
  }
  return null;
}
