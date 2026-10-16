import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet, sendAndWait } from "../lib/wallet.jsx";
import { api } from "../lib/api.js";
import { vaultAbi } from "../lib/vault.js";
import { money, txLink } from "../lib/format.js";
import { Card, Chip, ErrorNote } from "../components/ui.jsx";
import { useAuth } from "../components/useAuth.js";

export default function Approve() {
  const { id } = useParams();
  const qc = useQueryClient();
  const auth = useAuth();
  const w = useWallet();
  const { data: p, error } = useQuery({ queryKey: ["proposal", id], queryFn: () => api.proposal(id) });
  const { data: dep } = useQuery({ queryKey: ["deployment"], queryFn: api.deployment, refetchInterval: false });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  if (error) return <ErrorNote error={error} />;
  if (!p || !dep) return <p className="text-muted">Loading…</p>;
  const isOwner = auth.address && auth.address.toLowerCase() === dep.accounts.owner.toLowerCase();
  const open = p.onchainStatus === "open" && p.expiresAt * 1000 > Date.now();

  const approveDirect = async () => {
    setBusy(true); setErr(null);
    try {
      const hash = await sendAndWait(w, { address: dep.contracts.vault, abi: vaultAbi, functionName: "approve", args: [BigInt(p.id)] });
      setResult(hash);
      qc.invalidateQueries();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const approveGasless = async () => {
    setBusy(true); setErr(null);
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const signature = await w.walletClient.signTypedData({
        account: w.address,
        domain: { name: "Covenant PolicyVault", version: "1", chainId: dep.chainId, verifyingContract: dep.contracts.vault },
        types: { Approve: [{ name: "id", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "Approve",
        message: { id: BigInt(p.id), deadline },
      });
      const r = await api.relayApproval(p.id, deadline, signature);
      setResult(r.hash);
      qc.invalidateQueries();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <Card title={`Approval request #${p.id}`} action={<Chip tone={open ? "warn" : p.onchainStatus === "executed" ? "ok" : "muted"}>{open ? "waiting" : p.onchainStatus}</Chip>}>
        <p className="text-3xl font-semibold tabular-nums">{money(p.amount, p.asset)}</p>
        <p className="mt-1 text-lg">to <span className="font-medium">{p.payeeAlias}</span></p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-muted">Purpose</dt><dd>{p.purpose || "payment"}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Why it needs you</dt><dd className="text-right">{p.why}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">From bucket</dt><dd>{p.bucket?.toLowerCase()}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Expires</dt><dd>{new Date(p.expiresAt * 1000).toLocaleString()}</dd></div>
          {p.receipt && <div className="flex justify-between gap-4"><dt className="text-muted">Agent's reasoning</dt><dd className="text-right">{p.receipt.explanation}</dd></div>}
        </dl>
        {p.proposeTxUrl && <a className="mt-3 inline-block text-sm text-brand underline" href={p.proposeTxUrl} target="_blank" rel="noreferrer">proposal on the explorer</a>}
      </Card>
      {open && (
        <Card>
          {!auth.isConnected ? (
            <button className="btn-primary w-full" onClick={auth.connect}>Connect the owner's wallet</button>
          ) : !isOwner ? (
            <p className="text-sm text-bad">Only the vault owner can approve. Connected wallet is not the owner.</p>
          ) : (
            <div className="space-y-3">
              <button className="btn-primary w-full" disabled={busy} onClick={approveGasless}>Approve with a signature (no gas)</button>
              <button className="btn-ghost w-full" disabled={busy} onClick={approveDirect}>Approve with a transaction</button>
              <p className="text-xs text-muted">The contract re-checks the payee and the ceiling at the moment of execution. Ignore this request if you did not expect it.</p>
            </div>
          )}
          <div className="mt-3"><ErrorNote error={err} /></div>
        </Card>
      )}
      {result && (
        <p className="rounded-2xl border border-ok/30 bg-ok/10 p-4 text-sm text-ok">
          Approved and paid. {txLink(dep.explorer, result) ? <a className="underline" href={txLink(dep.explorer, result)} target="_blank" rel="noreferrer">View transaction</a> : <span className="mono break-all">{result}</span>}
        </p>
      )}
      <Link to="/" className="text-sm text-muted underline">Back to the wallet</Link>
    </div>
  );
}
