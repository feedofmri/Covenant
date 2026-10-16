// Fails when any production dependency (transitively) uses a licence outside the allowlist.
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ALLOW = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "CC-BY-4.0", "Python-2.0"]);
const tree = JSON.parse(execSync("npm ls --omit=dev --all --json", { maxBuffer: 64 * 1024 * 1024 }).toString() || "{}");
const seen = new Map();
(function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (seen.has(name) || name.startsWith("@covenant/")) { walk(info.dependencies); continue; }
    const pkgFile = path.join("node_modules", name, "package.json");
    if (info.missing || !existsSync(pkgFile)) continue; // optional peer not installed: not shipped
    let lic = "UNKNOWN";
    {
      const p = JSON.parse(readFileSync(pkgFile, "utf8"));
      lic = typeof p.license === "string" ? p.license : p.license?.type ?? (Array.isArray(p.licenses) ? p.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN");
    }
    seen.set(name, lic);
    walk(info.dependencies);
  }
})(tree.dependencies);

const ok = (lic) => lic.replace(/[()]/g, "").split(/\s+OR\s+/i).some((l) => ALLOW.has(l.trim())) || lic.replace(/[()]/g, "").split(/\s+AND\s+/i).every((l) => ALLOW.has(l.trim()));
const bad = [...seen].filter(([, lic]) => !ok(lic));
console.log(`${seen.size} production packages checked`);
if (bad.length) {
  console.error("Disallowed or unknown licences:\n" + bad.map(([n, l]) => `  ${n}: ${l}`).join("\n"));
  process.exit(1);
}
console.log("all licences allowed");
