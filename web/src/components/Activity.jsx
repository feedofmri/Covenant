import { useState } from "react";
import { Link } from "react-router-dom";
import { StatusChip, TierChip, Empty } from "./ui.jsx";
import { when, txLink } from "../lib/format.js";

export function Activity({ receipts, explorer }) {
  if (!receipts?.length) return <Empty>No activity yet. Income, payments and refusals will appear here with their reasons.</Empty>;
  return (
    <ul className="divide-y divide-line">
      {receipts.map(({ receipt: r, anchorTx }) => (
        <ActivityItem key={r.receiptId} r={r} anchorTx={anchorTx} explorer={explorer} />
      ))}
    </ul>
  );
}

function ActivityItem({ r, anchorTx, explorer }) {
  const [open, setOpen] = useState(false);
  const failed = r.checks.filter((c) => /:(block|hold|clarify|t2)$/.test(c));
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={r.status} />
        <TierChip tier={r.tier} />
        <span className="font-medium">{r.intent || r.trigger.type}</span>
        <span className="ml-auto text-xs text-muted">{when(r.timestamp)}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{r.explanation} {r.signals?.detail ?? ""}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        {r.txHashes.map((h) => (txLink(explorer, h) ? <a key={h} className="text-brand underline" href={txLink(explorer, h)} target="_blank" rel="noreferrer">tx {h.slice(0, 10)}…</a> : <span key={h} className="mono text-muted">tx {h.slice(0, 10)}…</span>))}
        {anchorTx && <span className="text-muted">receipt anchored</span>}
        <Link className="text-brand underline" to={`/verify/${r.receiptId}`}>verify receipt</Link>
        <button className="text-muted underline" onClick={() => setOpen(!open)}>{open ? "hide" : "show"} checks ({r.checks.length})</button>
        {r.signals?.injection?.injection && <span className="text-warn">untrusted text looked like an instruction (ignored)</span>}
      </div>
      {open && (
        <div className="mt-2 rounded-xl bg-bg p-3 text-xs">
          <p className="mb-1 text-muted">Trigger: {r.trigger.type} · planner: {r.model.planner}</p>
          <div className="flex flex-wrap gap-1">
            {r.checks.map((c, i) => (
              <span key={i} className={`mono rounded px-1.5 py-0.5 ${failed.includes(c) ? "bg-bad/10 text-bad" : "bg-ok/10 text-ok"}`}>{c}</span>
            ))}
          </div>
          {r.deltas && <p className="mt-2 mono text-muted">simulated {JSON.stringify(r.deltas.simulated)} · actual {JSON.stringify(r.deltas.actual)}</p>}
        </div>
      )}
    </li>
  );
}
