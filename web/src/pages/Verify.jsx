import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { Card, ErrorNote, Chip } from "../components/ui.jsx";

export default function Verify() {
  const { id } = useParams();
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!id) return;
    api.receipt(id).then((r) => setText(JSON.stringify(r.receipt, null, 2))).catch(setErr);
    api.verifyId(id).then(setResult).catch(setErr);
  }, [id]);

  const verify = async () => {
    setErr(null); setResult(null);
    try { setResult(await api.verify(JSON.parse(text))); } catch (e) { setErr(e); }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Verifiable Intent Receipt">
        <p className="mb-3 text-sm text-muted">Paste any receipt. We recompute its hashes and check them against the chain: the action transaction must commit to the intent hash, and the receipt hash must be anchored. Change one character and verification fails.</p>
        <textarea className="input min-h-80 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"receiptId": "rcpt_…", …}' />
        <button className="btn-primary mt-3" onClick={verify} disabled={!text.trim()}>Verify</button>
        <div className="mt-3"><ErrorNote error={err} /></div>
      </Card>
      <Card title="Result" action={result && <Chip tone={result.ok ? "ok" : "bad"}>{result.ok ? "verified" : "not verified"}</Chip>}>
        {!result ? <p className="text-sm text-muted">No result yet.</p> : result.error ? <p className="text-sm text-bad">{result.error}</p> : (
          <ul className="space-y-2 text-sm">
            {result.checks.map((c, i) => (
              <li key={i} className="flex gap-2"><span className={c.ok ? "text-ok" : "text-bad"}>{c.ok ? "✓" : "✗"}</span><span>{c.name}<br /><span className="mono break-all text-muted">{c.detail}</span></span></li>
            ))}
            <li className="mono break-all pt-2 text-muted">receipt hash {result.receiptHash}</li>
          </ul>
        )}
      </Card>
    </div>
  );
}
