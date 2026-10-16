// RFC 8785 canonical JSON + keccak256: the hashing used for mandates, intents and receipts.
import canonicalize from "canonicalize";
import { keccak256, toBytes } from "viem";

/** Canonical JSON string (bigints become decimal strings first). */
export function canonicalJson(value) {
  return canonicalize(JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))));
}

export const hashCanonical = (value) => keccak256(toBytes(canonicalJson(value)));

/** Simple binary Merkle root over bytes32 leaves (sorted pairs), for hourly batch anchoring. */
export function merkleRoot(leaves) {
  if (leaves.length === 0) return "0x" + "00".repeat(32);
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? level[i];
      const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
      next.push(keccak256(`0x${x.slice(2)}${y.slice(2)}`));
    }
    level = next;
  }
  return level[0];
}

/** Merkle proof for leaf at index (sorted-pair scheme above). */
export function merkleProof(leaves, index) {
  const proof = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    const sib = i % 2 === 0 ? (level[i + 1] ?? level[i]) : level[i - 1];
    proof.push(sib);
    const next = [];
    for (let j = 0; j < level.length; j += 2) {
      const a = level[j];
      const b = level[j + 1] ?? level[j];
      const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
      next.push(keccak256(`0x${x.slice(2)}${y.slice(2)}`));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkle(leaf, proof, root) {
  let h = leaf;
  for (const p of proof) {
    const [x, y] = h.toLowerCase() <= p.toLowerCase() ? [h, p] : [p, h];
    h = keccak256(`0x${x.slice(2)}${y.slice(2)}`);
  }
  return h.toLowerCase() === root.toLowerCase();
}
