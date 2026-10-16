import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { short } from "../lib/format.js";
import { useAuth } from "./useAuth.js";
import { Chip } from "./ui.jsx";

const links = [
  ["/", "Wallet"],
  ["/payees", "Payees"],
  ["/mandate", "Mandate"],
  ["/guardian", "Guardian"],
  ["/ledger", "Evidence"],
  ["/verify", "Verify"],
];

export default function Layout({ children }) {
  const auth = useAuth();
  const { data: dep } = useQuery({ queryKey: ["deployment"], queryFn: api.deployment, refetchInterval: false });
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-[rgb(var(--on-brand))]">✓</span>
            Covenant
          </NavLink>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto text-sm sm:order-none sm:w-auto">
            {links.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `whitespace-nowrap rounded-lg px-3 py-1.5 ${isActive ? "bg-bg font-medium" : "text-muted hover:text-ink"}`}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {dep && <Chip tone={dep.chainId === 31337 ? "muted" : "brand"}>{dep.chain}</Chip>}
            {!auth.isConnected ? (
              <button className="btn-primary" onClick={auth.connect}>Connect wallet</button>
            ) : !auth.session ? (
              <button className="btn-primary" onClick={auth.signIn}>Sign in {short(auth.address)}</button>
            ) : (
              <button className="btn-ghost" onClick={auth.disconnect} title="Sign out">
                <Chip tone="ok">{auth.role}</Chip> {short(auth.address)}
              </button>
            )}
          </div>
        </div>
        {auth.error && <p className="mx-auto max-w-6xl px-4 pb-2 text-sm text-bad">{auth.error.message}</p>}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted">
        The model proposes, the contract disposes. {dep?.mocks?.length ? "Testnet prototype: tokens, price feeds, pool and lending market are labelled mocks." : ""}
      </footer>
    </div>
  );
}
