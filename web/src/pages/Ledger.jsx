import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { Card, Chip, Empty } from "../components/ui.jsx";

export default function Ledger() {
  const { data } = useQuery({ queryKey: ["ledger"], queryFn: api.ledger });
  const s = data?.summary;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Transactions" value={s?.total ?? "–"} />
        <Stat label="Attacks reverted on-chain" value={s?.reverted ?? "–"} />
        <Stat label="Chain" value={s?.chain ?? "–"} />
      </div>
      <Card title="Execution evidence" action={<span className="flex gap-3 text-sm"><a className="text-brand underline" href={`${import.meta.env.VITE_API_URL ?? ""}/api/ledger.csv`}>CSV</a><a className="text-brand underline" href={`${import.meta.env.VITE_API_URL ?? ""}/api/ledger.md`}>Markdown</a></span>}>
        {!data?.rows?.length ? <Empty>No transactions yet.</Empty> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-muted"><tr>{["Time", "Scenario", "Operation", "Tier", "Outcome", "Note", "Tx"].map((h) => <th key={h} className="px-5 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {data.rows.slice().reverse().map((r) => (
                  <tr key={r.hash}>
                    <td className="whitespace-nowrap px-5 py-2 text-muted">{r.time.slice(5, 16).replace("T", " ")}</td>
                    <td className="px-5 py-2">{r.scenario}</td>
                    <td className="px-5 py-2">{r.operation}</td>
                    <td className="px-5 py-2">{r.tier}</td>
                    <td className="px-5 py-2"><Chip tone={r.outcome === "success" ? "ok" : "bad"}>{r.outcome}</Chip></td>
                    <td className="max-w-xs truncate px-5 py-2 text-muted" title={r.note}>{r.note}</td>
                    <td className="px-5 py-2">{r.explorer ? <a className="mono text-brand underline" href={r.explorer} target="_blank" rel="noreferrer">{r.hash.slice(0, 10)}…</a> : <span className="mono">{r.hash.slice(0, 10)}…</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }) {
  return <div className="card p-4"><p className="label">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p></div>;
}
