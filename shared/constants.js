// Shared constants: ids are keccak256 of readable labels so every layer derives the same bytes32.
import { keccak256, toHex } from "viem";

export const labelId = (s) => keccak256(toHex(s));

export const BUCKET_NAMES = /** @type {const} */ (["FAMILY", "EMERGENCY", "SAVINGS"]);
export const BUCKETS = Object.fromEntries(BUCKET_NAMES.map((b) => [b, labelId(b)]));
export const bucketName = (id) => BUCKET_NAMES.find((b) => BUCKETS[b] === id) ?? id;

/** Payee ids are derived from a lower-case slug of the alias, e.g. "Mother" → keccak("payee:mother"). */
export const payeeSlug = (alias) => alias.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
export const payeeId = (alias) => labelId(`payee:${payeeSlug(alias)}`);

export const ASSETS = /** @type {const} */ (["USDC", "EURC"]);

export const TIERS = { T0: "T0", T1: "T1", T2: "T2", T3: "T3" };

/** Scam-pattern weights (risk/scam.js). Threshold ≥ 0.6 holds the payment and alerts the guardian. */
export const SCAM = {
  threshold: 0.6, // hold + guardian alert
  warn: 0.3, // force owner co-signature (T2) + guardian alert
  weights: {
    payeeCoolingOff: 0.35,
    payeeYoung: 0.25,
    urgencyLanguage: 0.25,
    unusualAmount: 0.15,
    untrustedOrigin: 0.15,
    oddHour: 0.05,
  },
  youngPayeeDays: 7,
  unusualMultiple: 2,
  keywords: [
    "urgent", "immediately", "right now", "customs", "fee", "release", "lottery", "prize", "won",
    "account blocked", "account suspended", "new number", "verify", "penalty", "police", "tax due",
    "gift card", "crypto", "investment", "double",
    // Bangla (Bengali script and common romanisations)
    "জরুরি", "এখনই", "কাস্টমস", "ফি", "লটারি", "পুরস্কার", "নতুন নম্বর", "jaruri", "ekhoni",
  ],
};

export const RISK = {
  maxPlanOutflowShare: 0.5, // R-10
  purposeCodeAbove: 300, // R-14, in asset units
  duplicateWindowSec: 600, // R-12
  poolOracleMaxDeviation: 0.01, // R-06
  drawdownPause: 0.05, // verify.js circuit breaker
};

export const CHAINS = {
  31337: { name: "Local Hardhat", explorer: null },
  84532: { name: "Base Sepolia", explorer: "https://sepolia.basescan.org", blockscout: "https://base-sepolia.blockscout.com" },
  8453: { name: "Base", explorer: "https://basescan.org", blockscout: "https://base.blockscout.com" },
};

export const txUrl = (chainId, hash) => {
  const c = CHAINS[chainId];
  return c?.explorer ? `${c.explorer}/tx/${hash}` : null;
};
export const addressUrl = (chainId, addr) => {
  const c = CHAINS[chainId];
  return c?.explorer ? `${c.explorer}/address/${addr}` : null;
};
