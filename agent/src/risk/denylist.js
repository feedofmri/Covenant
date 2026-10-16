// Sanctions denylist (R-05). Built from the public OFAC SDN list's digital-currency addresses
// (shared/denylist.json), plus any locally configured addresses.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "shared", "denylist.json");
let cache = null;

export function denylist() {
  if (cache) return cache;
  const list = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).addresses : [];
  const extra = (process.env.DENYLIST_EXTRA || "").split(",").filter(Boolean);
  cache = new Set([...list, ...extra].map((a) => a.toLowerCase()));
  return cache;
}

export const isDenied = (address) => Boolean(address) && denylist().has(address.toLowerCase());
