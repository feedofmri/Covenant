// In-memory implementation of the store interface (tests, CLI). The server uses the SQLite implementation.
export function createMemoryStore({ payees = [], mandate = null } = {}) {
  const s = { payees: [...payees], mandate, proposals: new Map(), receipts: [], txs: [], triggers: new Set(), payments: [], ownerActions: [] };
  return {
    listPayees: () => s.payees,
    upsertPayee: (p) => {
      s.payees = s.payees.filter((x) => x.id !== p.id).concat([p]);
    },
    getMandate: () => s.mandate,
    setMandate: (m) => (s.mandate = m),
    listProposals: ({ status } = {}) => [...s.proposals.values()].filter((p) => !status || p.status === status),
    getProposal: (id) => s.proposals.get(Number(id)) ?? null,
    saveProposal: (p) => s.proposals.set(Number(p.id), p),
    updateProposal: (id, patch) => s.proposals.set(Number(id), { ...s.proposals.get(Number(id)), ...patch }),
    saveReceipt: (r) => s.receipts.push(r),
    listReceipts: () => s.receipts,
    getReceipt: (id) => s.receipts.find((r) => r.receipt.receiptId === id) ?? null,
    recordTx: (t) => s.txs.push({ ...t, at: Date.now() }),
    listTxs: () => s.txs,
    hasTrigger: (id) => s.triggers.has(id),
    markTrigger: (id) => s.triggers.add(id),
    addPayment: (p) => s.payments.push(p),
    recentPayments: () => s.payments.slice(-50),
    paymentAmounts: () => s.payments.slice(-50).map((p) => Number(p.units)),
    saveOwnerAction: (a) => s.ownerActions.push(a),
    _state: s,
  };
}
