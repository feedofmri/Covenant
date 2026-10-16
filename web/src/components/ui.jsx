import { STATUS } from "../lib/format.js";

const tones = {
  ok: "bg-ok/10 text-ok border-ok/30",
  warn: "bg-warn/10 text-warn border-warn/30",
  bad: "bg-bad/10 text-bad border-bad/30",
  muted: "bg-bg text-muted border-line",
  brand: "bg-brand/10 text-brand border-brand/30",
};

export function Chip({ tone = "muted", children }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function StatusChip({ status }) {
  const s = STATUS[status] ?? { label: status, tone: "muted" };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export function TierChip({ tier }) {
  if (!tier) return null;
  const tone = { T0: "muted", T1: "ok", T2: "warn", T3: "bad" }[tier];
  return <Chip tone={tone}>{tier}</Chip>;
}

export function Card({ title, action, children, className = "" }) {
  return (
    <section className={`card p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <p className="rounded-xl border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{String(error.message ?? error)}</p>;
}

export function Meter({ value, max, label }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct > 90 ? "bg-bad" : pct > 66 ? "bg-warn" : "bg-ok";
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{value.toLocaleString()} / {max.toLocaleString()}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
