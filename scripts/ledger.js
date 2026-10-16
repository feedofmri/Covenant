// Exports the evidence ledger from the server database: evidence/<network>/ledger.{csv,md,json}.
//   DEPLOYMENT=baseSepolia node scripts/ledger.js
import { mkdirSync, writeFileSync } from "node:fs";
import { loadDeployment } from "@covenant/shared";
import { openDb, createSqliteStore } from "@covenant/server/db.js";
import { ledgerRows, ledgerSummary, toCsv, toMarkdown } from "@covenant/server/ledger.js";

const network = process.env.DEPLOYMENT || "localhost";
const dep = loadDeployment(network);
const store = createSqliteStore(openDb(process.env.DB_PATH || `data/${network}.sqlite`));
const rows = ledgerRows(store, dep);
const summary = ledgerSummary(rows, dep);
const out = `evidence/${network}`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/ledger.csv`, toCsv(rows));
writeFileSync(`${out}/ledger.md`, toMarkdown(rows, summary));
writeFileSync(`${out}/ledger.json`, JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(`${summary.total} transactions (${summary.reverted} reverted) → ${out}/ledger.{csv,md,json}`);
