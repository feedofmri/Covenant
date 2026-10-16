import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet, sendAndWait } from "../lib/wallet.jsx";
import { api } from "../lib/api.js";
import { short } from "../lib/format.js";
import { Card, Chip, ErrorNote, Empty } from "../components/ui.jsx";
import { useAuth } from "../components/useAuth.js";

export default function Payees() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const auth = useAuth();
  const w = useWallet();
  const { data: payees } = useQuery({ queryKey: ["payees"], queryFn: api.payees });
  const [form, setForm] = useState({ alias: params.get("label") ?? "", address: params.get("add") ?? "", purpose: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null); setDone(null);
    try {
      const tx = await api.preparePayee(form.alias, form.address, form.purpose);
      await sendAndWait(w, { to: tx.to, data: tx.data });
      setDone(`${form.alias} added. They can be paid in ${tx.coolingOffHours} hours.`);
      qc.invalidateQueries();
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Registered payees">
        {!payees?.length ? <Empty>No payees yet.</Empty> : (
          <ul className="divide-y divide-line">
            {payees.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{p.alias}</p>
                  <p className="mono text-muted">{short(p.address, 10)}{p.purpose ? ` · ${p.purpose}` : ""}</p>
                </div>
                {!p.active ? <Chip>removed</Chip> : p.coolingOff ? <Chip tone="warn">cooling off until {new Date(p.activeFrom * 1000).toLocaleString()}</Chip> : !p.firstPaid ? <Chip tone="warn">first payment needs you</Chip> : <Chip tone="ok">active</Chip>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">The agent can only pay these people. It cannot add anyone: only your wallet can.</p>
      </Card>
      <Card title="Add a payee">
        {auth.role !== "owner" ? <p className="text-sm text-muted">Sign in with the owner's wallet to add a payee.</p> : (
          <form onSubmit={add} className="space-y-3">
            <div><label className="label">Name</label><input className="input mt-1" value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} required /></div>
            <div><label className="label">Wallet address</label><input className="input mt-1 font-mono" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} pattern="0x[0-9a-fA-F]{40}" required /></div>
            <div><label className="label">Purpose</label><input className="input mt-1" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} placeholder="e.g. rent, school fees" /></div>
            <p className="rounded-xl bg-warn/10 p-3 text-sm text-warn">New payees wait 24 hours before they can be paid, and the first payment needs your approval. Scammers rely on urgency; this pause protects you.</p>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Waiting for your wallet…" : "Add payee"}</button>
            <ErrorNote error={err} />
            {done && <p className="text-sm text-ok">{done}</p>}
          </form>
        )}
      </Card>
    </div>
  );
}
