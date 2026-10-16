export const short = (a, n = 6) => (a ? `${a.slice(0, n)}…${a.slice(-4)}` : "");
export const money = (v, sym = "USDC") => `${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${sym}`;
export const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const txLink = (explorer, hash) => (explorer ? `${explorer}/tx/${hash}` : null);

export const STATUS = {
  executed: { label: "Done", tone: "ok" },
  awaiting_owner: { label: "Needs approval", tone: "warn" },
  held: { label: "On hold", tone: "warn" },
  blocked: { label: "Blocked", tone: "bad" },
  refused: { label: "Refused", tone: "bad" },
  sim_mismatch: { label: "Stopped", tone: "bad" },
  verify_mismatch: { label: "Paused", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
  no_action: { label: "No action", tone: "muted" },
};
