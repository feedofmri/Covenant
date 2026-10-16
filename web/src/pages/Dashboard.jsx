import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { money, short } from "../lib/format.js";
import { Card, Meter, Chip, Empty, ErrorNote } from "../components/ui.jsx";
import { Activity } from "../components/Activity.jsx";
import { useAuth } from "../components/useAuth.js";

const BUCKET_INFO = {
  FAMILY: ["Family support", "Sent home on schedule"],
  EMERGENCY: ["Emergency fund", "Only on your request"],
  SAVINGS: ["Savings", "Idle savings above the buffer earn yield"],
};

export default function Dashboard() {
  const { data: state, error } = useQuery({ queryKey: ["state"], queryFn: api.state });
  const { data: receipts } = useQuery({ queryKey: ["receipts"], queryFn: () => api.receipts(25) });
  const { data: proposals } = useQuery({ queryKey: ["proposals", "open"], queryFn: () => api.proposals("open") });
  const { data: dep } = useQuery({ queryKey: ["deployment"], queryFn: api.deployment, refetchInterval: false });
  const auth = useAuth();
  if (error) return <ErrorNote error={error} />;
  if (!state) return <p className="text-muted">Loading…</p>;
  const usdc = state.formatted.USDC;
  const goal = state.mandate ? Number(state.mandate.remittances?.[0]?.amount ?? 0) * (state.mandate.emergencyTargetMonths ?? 3) : 0;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        {state.paused && <p className="rounded-2xl border border-bad/30 bg-bad/10 p-4 text-sm text-bad">The wallet is paused. The agent cannot act until the owner unpauses it.</p>}
        <section className="card p-6">
          <p className="label">Total balance</p>
          <p className="mt-1 text-4xl font-semibold tabular-nums">{money(usdc.balance)}</p>
          <p className="mt-1 text-sm text-muted">
            {Number(usdc.lent) > 0 && <>+ {money(usdc.lent)} lent · </>}
            {Number(usdc.unallocated) > 0 ? <>{money(usdc.unallocated)} not yet allocated</> : "All income allocated"}
            {state.yieldPaused && <> · <span className="text-warn">yield paused (stablecoin price warning)</span></>}
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {Object.entries(BUCKET_INFO).map(([k, [name, hint]]) => (
              <div key={k} className="rounded-xl border border-line p-4">
                <p className="text-sm font-medium">{name}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{money(usdc.buckets[k])}</p>
                <p className="mt-1 text-xs text-muted">{k === "EMERGENCY" && goal ? `Goal ${money(goal)} · ` : ""}{hint}</p>
              </div>
            ))}
          </div>
        </section>
        {auth.role === "owner" ? <Chat /> : (
          <Card title="Talk to Covenant">
            <p className="text-sm text-muted">Connect and sign in with the owner's wallet to give instructions here, or link Telegram from the Guardian page.</p>
          </Card>
        )}
        <Card title="Activity" action={<Link to="/ledger" className="text-sm text-brand underline">full evidence ledger</Link>}>
          <Activity receipts={receipts} explorer={dep?.explorer} />
        </Card>
      </div>
      <div className="space-y-5">
        <Card title="Limits enforced on-chain">
          <div className="space-y-4">
            <Meter label="Paid in the last 24 h" value={Number(usdc.paid24h)} max={Number(usdc.limits.daily)} />
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted">Per payment</dt><dd className="text-right tabular-nums">{money(usdc.limits.perTx)}</dd>
              <dt className="text-muted">With your co-sign</dt><dd className="text-right tabular-nums">up to {money(usdc.limits.t2Ceiling)}</dd>
              <dt className="text-muted">Lending cap</dt><dd className="text-right tabular-nums">{money(usdc.limits.lendingCap)}</dd>
            </dl>
            <p className="text-xs text-muted">Payments go only to registered payees. New payees wait 24 hours. Anything above the co-sign ceiling is refused by the contract.</p>
          </div>
        </Card>
        <Card title="Waiting for your approval">
          {proposals?.length ? (
            <ul className="space-y-2">
              {proposals.map((p) => (
                <li key={p.id}>
                  <Link to={`/approve/${p.id}`} className="flex items-center justify-between rounded-xl border border-line p-3 hover:bg-bg">
                    <span><span className="font-medium">{p.payeeAlias}</span> · {money(p.amount, p.asset)}<br /><span className="text-xs text-muted">{p.purpose || "payment"} — {p.why}</span></span>
                    <Chip tone="warn">#{p.id}</Chip>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <Empty>Nothing to approve.</Empty>}
        </Card>
        <Card title="Agent">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Session key</dt><dd className="mono">{short(state.agent)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Key expires</dt><dd>{state.agentExpiresAt ? new Date(state.agentExpiresAt * 1000).toLocaleDateString() : "revoked"}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Mandate</dt><dd className="mono">{short(state.mandateHash, 10)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Payees</dt><dd>{state.payees.filter((p) => p.active).map((p) => p.alias).join(", ")}</dd></div>
          </dl>
          {dep?.vaultUrl && <a className="mt-3 inline-block text-sm text-brand underline" href={dep.vaultUrl} target="_blank" rel="noreferrer">PolicyVault on the explorer</a>}
        </Card>
      </div>
    </div>
  );
}

function Chat() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const t = text;
    setText("");
    setBusy(true);
    setLog((l) => [...l, { who: "you", text: t }]);
    try {
      const r = await api.chat(t);
      setLog((l) => [...l, { who: "covenant", text: [r.message, r.clarification && r.clarification !== r.message ? r.clarification : ""].filter(Boolean).join(" "), status: r.status }]);
      qc.invalidateQueries();
    } catch (err) {
      setLog((l) => [...l, { who: "covenant", text: err.message, status: "failed" }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Talk to Covenant">
      <div className="mb-3 max-h-64 space-y-2 overflow-y-auto">
        {log.length === 0 && <p className="text-sm text-muted">Try “send 200 to Mother”, “Mother needs 400 for a hospital bill”, “lend 100 of my savings”, or “মাকে ২০০ পাঠাও”.</p>}
        {log.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.who === "you" ? "ml-auto bg-brand text-[rgb(var(--on-brand))]" : "bg-bg"}`}>{m.text}</div>
        ))}
      </div>
      <form onSubmit={send} className="flex gap-2">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell Covenant what to do…" disabled={busy} />
        <button className="btn-primary" disabled={busy}>{busy ? "…" : "Send"}</button>
      </form>
    </Card>
  );
}
