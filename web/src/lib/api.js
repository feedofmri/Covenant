// Thin API client. The session token lives in localStorage when available (a convenience only).
const BASE = import.meta.env.VITE_API_URL ?? "";

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Shared session store (one source of truth for every component; persisted when storage is available).
let current = (() => { try { return JSON.parse(storage.get("covenant.session") ?? "null"); } catch { return null; } })();
const listeners = new Set();
export const session = {
  get: () => current,
  set: (s) => {
    current = s ?? null;
    storage.set("covenant.session", s ? JSON.stringify(s) : null);
    listeners.forEach((l) => l());
  },
  subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
};

async function req(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "content-type": "application/json" };
  const s = session.get();
  if (auth && s?.token) headers.authorization = `Bearer ${s.token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && auth) session.set(null);
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  deployment: () => req("/api/deployment"),
  state: () => req("/api/state"),
  receipts: (limit = 30) => req(`/api/receipts?limit=${limit}`),
  receipt: (id) => req(`/api/receipts/${id}`),
  verifyId: (id) => req(`/api/receipts/${id}/verify`),
  verify: (receipt) => req("/api/verify", { method: "POST", body: { receipt } }),
  proposals: (status) => req(`/api/proposals${status ? `?status=${status}` : ""}`),
  proposal: (id) => req(`/api/proposals/${id}`),
  relayApproval: (id, deadline, signature) => req(`/api/proposals/${id}/relay-approval`, { method: "POST", body: { deadline: String(deadline), signature } }),
  ledger: () => req("/api/ledger.json"),
  payees: () => req("/api/payees"),
  mandate: () => req("/api/mandate"),
  nonce: () => req("/api/auth/nonce", { method: "POST", body: {} }),
  signIn: (address, signature, nonce) => req("/api/auth/verify", { method: "POST", body: { address, signature, nonce } }),
  chat: (text) => req("/api/chat", { method: "POST", body: { text }, auth: true }),
  draftMandate: (text) => req("/api/mandate/draft", { method: "POST", body: { text }, auth: true }),
  activateMandate: (mandate, txHash) => req("/api/mandate/activate", { method: "POST", body: { mandate, txHash }, auth: true }),
  preparePayee: (alias, address, purpose) => req("/api/payees/prepare", { method: "POST", body: { alias, address, purpose }, auth: true }),
  linkCode: () => req("/api/telegram/link-code", { method: "POST", body: {}, auth: true }),
  notifications: () => req("/api/notifications", { auth: true }),
};
