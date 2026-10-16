import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet, sendAndWait } from "../lib/wallet.jsx";
import { api } from "../lib/api.js";
import { Card, Chip, ErrorNote } from "../components/ui.jsx";
import { useAuth } from "../components/useAuth.js";

export default function MandatePage() {
  const auth = useAuth();
  const qc = useQueryClient();
  const w = useWallet();
  const { data } = useQuery({ queryKey: ["mandate"], queryFn: api.mandate });
  const [text, setText] = useState("");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState([]);

  const m = data?.mandate;
  const makeDraft = async () => {
    setBusy(true); setErr(null); setSent([]);
    try { setDraft(await api.draftMandate(text)); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const sign = async () => {
    setBusy(true); setErr(null);
    try {
      const hashes = [];
      for (const tx of draft.txs) {
        const hash = await sendAndWait(w, { to: tx.to, data: tx.data });
        hashes.push(hash);
        setSent([...hashes]);
      }
      await api.activateMandate(draft.mandate, hashes[0]);
      qc.invalidateQueries();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Current mandate" action={m && data.onchainHash && <Chip tone="ok">on-chain</Chip>}>
        {!m ? <p className="text-sm text-muted">No mandate yet.</p> : (
          <div className="space-y-3 text-sm">
            <p><span className="text-muted">Income split:</span> family {m.buckets.FAMILY}% · emergency {m.buckets.EMERGENCY}% · savings {m.buckets.SAVINGS}%</p>
            <p><span className="text-muted">Remittances:</span> {m.remittances.map((r) => `${r.amount} ${r.asset} to ${r.payee} (${r.cron})`).join("; ") || "none"}</p>
            <p><span className="text-muted">Emergency goal:</span> {m.emergencyTargetMonths} months of support</p>
            <p><span className="text-muted">Savings:</span> keep {m.savings.liquidBuffer} USDC liquid, lend at most {m.savings.lendingCapPct}%</p>
            <p><span className="text-muted">Limits:</span> {m.limits.perTx} per payment · {m.limits.daily} per day · co-sign up to {m.limits.t2Ceiling}</p>
            <p className="mono break-all text-muted">hash {data.onchainHash}</p>
          </div>
        )}
      </Card>
      <Card title="Change it in plain words">
        {auth.role !== "owner" ? <p className="text-sm text-muted">Sign in with the owner's wallet.</p> : (
          <div className="space-y-3">
            <textarea className="input min-h-28" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Put 60% to family, 15% emergency and the rest in savings. Send my mother 250 on the 5th of every month. Daily limit 400." />
            <button className="btn-primary" disabled={busy || !text.trim()} onClick={makeDraft}>Preview</button>
            <ErrorNote error={err} />
            {draft && !draft.ok && <div className="rounded-xl bg-bad/10 p-3 text-sm text-bad">This would not be valid: {draft.issues.join("; ")}</div>}
            {draft?.ok && (
              <div className="space-y-3 rounded-xl border border-line p-4">
                <p className="text-sm">{draft.summary}</p>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {draft.txs.map((t, i) => <li key={i}>{t.description} {t.timelocked && <Chip tone="warn">timelocked</Chip>} {sent[i] && <Chip tone="ok">sent</Chip>}</li>)}
                </ol>
                <p className="text-xs text-muted">Lowering limits takes effect at once. Raising them waits out the timelock, so a stolen phone cannot loosen your rules quickly.</p>
                <button className="btn-primary w-full" disabled={busy} onClick={sign}>Sign {draft.txs.length} transaction{draft.txs.length > 1 ? "s" : ""}</button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
