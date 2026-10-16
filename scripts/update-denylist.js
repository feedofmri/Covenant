// Refreshes shared/denylist.json from the official OFAC SDN export ("Digital Currency Address - ETH").
import { writeFileSync } from "node:fs";
import { getAddress } from "viem";

const URL = process.env.SDN_URL || "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
const xml = await (await fetch(URL)).text();
const found = new Set();
for (const m of xml.matchAll(/Digital Currency Address - ETH<\/idType>\s*<idNumber>(0x[0-9a-fA-F]{40})<\/idNumber>/g)) found.add(getAddress(m[1]));
if (found.size < 10) throw new Error(`only ${found.size} addresses parsed — export format may have changed; keeping the current list`);
writeFileSync("shared/denylist.json", JSON.stringify({ source: `OFAC SDN list (${URL})`, updated: new Date().toISOString().slice(0, 10), addresses: [...found].sort() }, null, 2) + "\n");
console.log(`wrote ${found.size} addresses to shared/denylist.json`);
