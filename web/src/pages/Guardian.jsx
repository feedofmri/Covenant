import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet, sendAndWait } from "../lib/wallet.jsx";
import { api } from "../lib/api.js";
import { vaultAbi } from "../lib/vault.js";
import { Card, ErrorNote, Empty, Chip } from "../components/ui.jsx";
import { useAuth } from "../components/useAuth.js";

export default function Guardian() {
  const auth = useAuth();
  const qc = useQueryClient();
  const w = useWallet();
  const { data: dep } = useQuery({ queryKey: ["deployment"], queryFn: api.deployment, refetchInterval: false });
  const { data: state } = useQuery({ queryKey: ["state"], queryFn: api.state });
  const { data: notes } = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, enabled: Boolean(auth.session) });
  const [err, setErr] = useState(null);
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);

  const call = async (functionName) => {
    setBusy(true); setErr(null);
    try {
      await sendAndWait(w, { address: dep.contracts.vault, abi: vaultAbi, functionName });
      qc.invalidateQueries();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Safety controls" action={state && <Chip tone={state.paused ? "bad" : "ok"}>{state.paused ? "paused" : "active"}</Chip>}>
        <p className="mb-4 text-sm text-muted">The owner and the guardian can stop the agent instantly. Only the owner can restart it.</p>
        {!auth.session ? <p className="text-sm text-muted">Sign in with the owner's or guardian's wallet.</p> : (
          <div className="flex flex-wrap gap-2">
            <button className="btn-danger" disabled={busy || state?.paused} onClick={() => call("pause")}>Pause the agent</button>
            <button className="btn-ghost" disabled={busy} onClick={() => call("revokeAgent")}>Revoke the agent's key</button>
            {auth.role === "owner" && <button className="btn-primary" disabled={busy || !state?.paused} onClick={() => call("unpause")}>Unpause</button>}
          </div>
        )}
        <div className="mt-3"><ErrorNote error={err} /></div>
      </Card>
      <Card title="Telegram alerts">
        {!auth.session ? <p className="text-sm text-muted">Sign in to link a Telegram chat.</p> : (
          <div className="space-y-3 text-sm">
            <p className="text-muted">Get scam warnings, pauses and approval requests in Telegram.</p>
            <button className="btn-ghost" onClick={async () => setCode(await api.linkCode())}>Create link code</button>
            {code && <p>Send <span className="mono rounded bg-bg px-2 py-1">/link {code.code}</span> to {code.bot ? `@${code.bot}` : "the Covenant bot"} within 15 minutes.</p>}
          </div>
        )}
      </Card>
      <Card title="Alerts" className="lg:col-span-2">
        {!auth.session ? <Empty>Sign in to see alerts for your role.</Empty> : !notes?.length ? <Empty>No alerts.</Empty> : (
          <ul className="divide-y divide-line text-sm">
            {notes.map((n, i) => <li key={i} className="py-2"><span className="mr-2 text-xs text-muted">{new Date(n.at * 1000).toLocaleString()}</span>{n.text}</li>)}
          </ul>
        )}
      </Card>
    </div>
  );
}
