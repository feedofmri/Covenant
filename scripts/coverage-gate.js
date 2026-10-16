// Fails CI when production contracts drop below the coverage targets (reads istanbul's coverage-final.json).
import { readFileSync } from "node:fs";

const MIN_LINES = Number(process.env.MIN_LINES ?? 95);
const MIN_BRANCHES = Number(process.env.MIN_BRANCHES ?? 80);
const data = JSON.parse(readFileSync("contracts/coverage/coverage-final.json", "utf8"));
let failed = false;
for (const [file, cov] of Object.entries(data)) {
  if (/mocks|interfaces/.test(file)) continue;
  const lines = new Map();
  for (const [id, loc] of Object.entries(cov.statementMap)) {
    const l = loc.start.line;
    lines.set(l, (lines.get(l) ?? 0) + cov.s[id]);
  }
  const lineHit = [...lines.values()].filter((n) => n > 0).length;
  const branches = Object.values(cov.b).flat();
  const branchHit = branches.filter((n) => n > 0).length;
  const lp = lines.size ? (100 * lineHit) / lines.size : 100;
  const bp = branches.length ? (100 * branchHit) / branches.length : 100;
  const name = file.split("/contracts/src/").pop();
  const msg = `${name}: lines ${lp.toFixed(1)}% (${lineHit}/${lines.size}) branches ${bp.toFixed(1)}% (${branchHit}/${branches.length})`;
  if (lp < MIN_LINES || bp < MIN_BRANCHES) {
    console.error(`✗ ${msg} — minimum ${MIN_LINES}% / ${MIN_BRANCHES}%`);
    failed = true;
  } else console.log(`✓ ${msg}`);
}
process.exit(failed ? 1 : 0);
