import { useState, useCallback, useSyncExternalStore } from "react";
import { useWallet } from "../lib/wallet.jsx";
import { api, session } from "../lib/api.js";

/** Wallet connection + signature sign-in (owner or guardian). */
export function useAuth() {
  const w = useWallet();
  const s = useSyncExternalStore(session.subscribe, session.get);
  const [error, setError] = useState(null);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      const { nonce, message } = await api.nonce();
      const signature = await w.walletClient.signMessage({ account: w.address, message });
      const res = await api.signIn(w.address, signature, nonce);
      session.set(res);
    } catch (e) {
      setError(e);
    }
  }, [w]);

  const connect = useCallback(async (role) => {
    setError(null);
    try { await w.connect(role); } catch (e) { setError(e); }
  }, [w]);

  const connectDev = useCallback((role = "owner") => {
    setError(null);
    try { w.connectDev(role); } catch (e) { setError(e); }
  }, [w]);

  const valid = s && w.address && s.address?.toLowerCase() === w.address.toLowerCase() ? s : null;
  return {
    address: w.address, isConnected: w.isConnected, session: valid, role: valid?.role ?? null, error,
    connect,
    connectDev,
    disconnect: () => { session.set(null); w.disconnect(); },
    signIn,
    hasWallet: w.hasWallet,
    devRole: w.devRole,
  };
}
