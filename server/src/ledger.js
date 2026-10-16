// Evidence ledger: every transaction the system sent or observed, with scenario, tier, outcome and explorer link.
import { txUrl, CHAINS } from "@covenant/shared";

const OPS = {
  allocate: "asset management", reallocate: "asset management", supply: "asset management", withdraw: "asset management", swap: "asset management",
  pay: "transaction execution", approve: "transaction execution", propose: "risk control (T2)", income: "income received",
  pause: "risk control", anchor: "audit (receipt anchor)", anchorBatch: "audit (receipt anchor)", createVault: "setup (mandate on-chain)",
  addPayee: "owner action", MandateSet: "owner action", forced: "risk control (attack reverted)",
};

export function ledgerRows(store, deployment) {
  const rows = store.listTxs();
  const setup = (deployment.setupTxs ?? []).filter((t) => !rows.some((r) => r.hash === t.hash)).map((t) => ({ hash: t.hash, kind: t.kind, scenario: t.scenario, tier: null, outcome: "success", actor: "owner", note: "vault created with the mandate hash", at: Date.parse(deployment.deployedAt) / 1000 }));
  return [...setup, ...rows].map((r) => ({
    time: new Date(r.at * 1000).toISOString(),
    scenario: r.scenario ?? "",
    operation: OPS[r.kind] ?? r.kind,
    kind: r.kind,
    tier: r.tier ?? "",
    outcome: r.outcome,
    actor: r.actor ?? "",
    note: r.note ?? "",
    receiptId: r.receipt_id ?? r.receiptId ?? "",
    hash: r.hash,
    explorer: txUrl(deployment.chainId, r.hash) ?? "",
  }));
}

export function ledgerSummary(rows, deployment) {
  const by = (k) => rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {});
  return {
    chain: CHAINS[deployment.chainId]?.name ?? deployment.chainId,
    total: rows.length,
    reverted: rows.filter((r) => r.outcome === "reverted").length,
    byOperation: by("operation"),
    byScenario: by("scenario"),
  };
}

export function toCsv(rows) {
  const cols = ["time", "scenario", "operation", "kind", "tier", "outcome", "actor", "note", "receiptId", "hash", "explorer"];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c] ?? "")).join(","))].join("\n") + "\n";
}

export function toMarkdown(rows, summary) {
  const head = `# Covenant execution evidence\n\nChain: **${summary.chain}** · ${summary.total} transactions · ${summary.reverted} reverted attacks/refusals on-chain\n\n`;
  const ops = Object.entries(summary.byOperation).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const table = ["| Time (UTC) | Scenario | Operation | Tier | Outcome | Note | Tx |", "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.time.slice(0, 16).replace("T", " ")} | ${r.scenario} | ${r.operation} | ${r.tier} | ${r.outcome} | ${r.note.replace(/\|/g, "/")} | ${r.explorer ? `[${r.hash.slice(0, 10)}…](${r.explorer})` : `\`${r.hash.slice(0, 10)}…\``} |`)].join("\n");
  return `${head}## By operation\n\n${ops}\n\n## Transactions\n\n${table}\n`;
}
