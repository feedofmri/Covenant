// SQLite store: implements the agent's store interface plus ledger, Telegram links and indexer cursors.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payees (id TEXT PRIMARY KEY, alias TEXT NOT NULL, address TEXT NOT NULL, purpose TEXT, added_at INTEGER);
CREATE TABLE IF NOT EXISTS mandates (hash TEXT PRIMARY KEY, json TEXT NOT NULL, active INTEGER DEFAULT 0, set_tx TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, type TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, json TEXT NOT NULL, receipt_hash TEXT NOT NULL, intent_hash TEXT NOT NULL,
  status TEXT, tier TEXT, anchor_tx TEXT, batch_root TEXT, batch_tx TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS txs (hash TEXT PRIMARY KEY, kind TEXT, tier TEXT, outcome TEXT, scenario TEXT, receipt_id TEXT,
  gas_used TEXT, actor TEXT, note TEXT, block INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS proposals (id INTEGER PRIMARY KEY, json TEXT NOT NULL, status TEXT, approved_tx TEXT);
CREATE TABLE IF NOT EXISTS payments (rowid INTEGER PRIMARY KEY AUTOINCREMENT, payee_id TEXT, amount TEXT, units TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS owner_actions (rowid INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS telegram_links (chat_id TEXT PRIMARY KEY, role TEXT NOT NULL, wallet TEXT, linked_at INTEGER);
CREATE TABLE IF NOT EXISTS link_codes (code TEXT PRIMARY KEY, role TEXT, wallet TEXT, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS notifications (rowid INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, kind TEXT, text TEXT, json TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS cycles (rowid INTEGER PRIMARY KEY AUTOINCREMENT, trigger_type TEXT, trigger_id TEXT, status TEXT, ms INTEGER, at INTEGER);
`;

const now = () => Math.floor(Date.now() / 1000);

export function openDb(file = process.env.DB_PATH || "data/covenant.sqlite") {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function createSqliteStore(db) {
  const q = (sql) => db.prepare(sql);
  const kvGet = (k) => q("SELECT v FROM kv WHERE k = ?").get(k)?.v ?? null;
  const kvSet = (k, v) => q("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));

  return {
    db,
    kvGet,
    kvSet,
    // ── payees ──
    listPayees: () => q("SELECT id, alias, address, purpose, added_at AS addedAt FROM payees ORDER BY alias").all(),
    upsertPayee: (p) => q("INSERT INTO payees (id, alias, address, purpose, added_at) VALUES (@id, @alias, @address, @purpose, @addedAt) ON CONFLICT(id) DO UPDATE SET alias = excluded.alias, address = excluded.address, purpose = excluded.purpose").run({ purpose: "", addedAt: null, ...p }),
    // ── mandate ──
    getMandate: () => {
      const r = q("SELECT json FROM mandates WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get();
      return r ? JSON.parse(r.json) : null;
    },
    setMandate: (mandate, hash, setTx = null) => {
      db.transaction(() => {
        q("UPDATE mandates SET active = 0").run();
        q("INSERT INTO mandates (hash, json, active, set_tx, created_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(hash) DO UPDATE SET active = 1, json = excluded.json").run(hash, JSON.stringify(mandate), setTx, now());
      })();
    },
    getMandateByHash: (hash) => {
      const r = q("SELECT json FROM mandates WHERE hash = ?").get(hash);
      return r ? JSON.parse(r.json) : null;
    },
    // ── triggers ──
    hasTrigger: (id) => Boolean(q("SELECT 1 FROM triggers WHERE id = ?").get(String(id))),
    markTrigger: (id, type) => q("INSERT OR IGNORE INTO triggers (id, type, at) VALUES (?, ?, ?)").run(String(id), type ?? null, now()),
    /** Atomic claim: true only for the first process to see this trigger id. */
    claimTrigger: (id, type) => q("INSERT OR IGNORE INTO triggers (id, type, at) VALUES (?, ?, ?)").run(String(id), type ?? null, now()).changes === 1,
    // ── receipts ──
    saveReceipt: ({ receipt, receiptHash, anchorTx }) =>
      q("INSERT OR REPLACE INTO receipts (id, json, receipt_hash, intent_hash, status, tier, anchor_tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(receipt.receiptId, JSON.stringify(receipt), receiptHash, receipt.intentHash, receipt.status, receipt.tier, anchorTx ?? null, now()),
    listReceipts: ({ limit = 100, status } = {}) =>
      (status ? q("SELECT * FROM receipts WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) : q("SELECT * FROM receipts ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit))
        .map((r) => ({ receipt: JSON.parse(r.json), receiptHash: r.receipt_hash, anchorTx: r.anchor_tx, batchRoot: r.batch_root, batchTx: r.batch_tx })),
    getReceipt: (id) => {
      const r = q("SELECT * FROM receipts WHERE id = ?").get(id);
      return r ? { receipt: JSON.parse(r.json), receiptHash: r.receipt_hash, anchorTx: r.anchor_tx, batchRoot: r.batch_root, batchTx: r.batch_tx } : null;
    },
    unanchoredReceiptHashes: () => q("SELECT id, receipt_hash FROM receipts WHERE anchor_tx IS NULL AND batch_root IS NULL ORDER BY created_at").all(),
    markBatch: (ids, root, tx) => {
      const stmt = q("UPDATE receipts SET batch_root = ?, batch_tx = ? WHERE id = ?");
      db.transaction(() => ids.forEach((id) => stmt.run(root, tx, id)))();
    },
    batchLeaves: (root) => q("SELECT receipt_hash FROM receipts WHERE batch_root = ? ORDER BY created_at, rowid").all(root).map((r) => r.receipt_hash),
    // ── ledger ──
    recordTx: (t) =>
      q("INSERT OR REPLACE INTO txs (hash, kind, tier, outcome, scenario, receipt_id, gas_used, actor, note, block, at) VALUES (@hash, @kind, @tier, @outcome, @scenario, @receiptId, @gasUsed, @actor, @note, @block, @at)")
        .run({ kind: null, tier: null, outcome: null, scenario: null, receiptId: null, gasUsed: null, actor: "agent", note: null, block: null, at: now(), ...t }),
    listTxs: ({ limit = 1000 } = {}) => q("SELECT * FROM txs ORDER BY at ASC, rowid ASC LIMIT ?").all(limit),
    hasTx: (hash) => Boolean(q("SELECT 1 FROM txs WHERE hash = ?").get(hash)),
    // ── proposals ──
    listProposals: ({ status } = {}) => (status ? q("SELECT json FROM proposals WHERE status = ? ORDER BY id DESC").all(status) : q("SELECT json FROM proposals ORDER BY id DESC").all()).map((r) => JSON.parse(r.json)),
    getProposal: (id) => {
      const r = q("SELECT json FROM proposals WHERE id = ?").get(Number(id));
      return r ? JSON.parse(r.json) : null;
    },
    saveProposal: (p) => q("INSERT OR REPLACE INTO proposals (id, json, status) VALUES (?, ?, ?)").run(Number(p.id), JSON.stringify(p), p.status),
    updateProposal(id, patch) {
      const cur = this.getProposal(id);
      if (!cur) return;
      const next = { ...cur, ...patch };
      q("UPDATE proposals SET json = ?, status = ?, approved_tx = ? WHERE id = ?").run(JSON.stringify(next), next.status, next.approvedTx ?? null, Number(id));
    },
    // ── payments ──
    addPayment: (p) => q("INSERT INTO payments (payee_id, amount, units, at) VALUES (?, ?, ?, ?)").run(p.payeeId, p.amount, p.units, p.at),
    recentPayments: () => q("SELECT payee_id AS payeeId, amount, units, at FROM payments ORDER BY rowid DESC LIMIT 50").all(),
    paymentAmounts: () => q("SELECT units FROM payments ORDER BY rowid DESC LIMIT 50").all().map((r) => Number(r.units)),
    saveOwnerAction: (a) => q("INSERT INTO owner_actions (json, at) VALUES (?, ?)").run(JSON.stringify(a), now()),
    listOwnerActions: () => q("SELECT json FROM owner_actions ORDER BY rowid DESC LIMIT 50").all().map((r) => JSON.parse(r.json)),
    // ── telegram ──
    createLinkCode: (role, wallet) => {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      q("INSERT INTO link_codes (code, role, wallet, expires_at) VALUES (?, ?, ?, ?)").run(code, role, wallet, now() + 900);
      return code;
    },
    consumeLinkCode: (code, chatId) => {
      const r = q("SELECT * FROM link_codes WHERE code = ?").get(String(code).toUpperCase());
      if (!r || r.expires_at < now()) return null;
      q("DELETE FROM link_codes WHERE code = ?").run(r.code);
      q("INSERT OR REPLACE INTO telegram_links (chat_id, role, wallet, linked_at) VALUES (?, ?, ?, ?)").run(String(chatId), r.role, r.wallet, now());
      return { role: r.role, wallet: r.wallet };
    },
    linkFor: (chatId) => q("SELECT * FROM telegram_links WHERE chat_id = ?").get(String(chatId)) ?? null,
    chatsFor: (role) => q("SELECT chat_id FROM telegram_links WHERE role = ?").all(role).map((r) => r.chat_id),
    // ── notifications (in-app feed) ──
    addNotification: (n) => q("INSERT INTO notifications (role, kind, text, json, at) VALUES (?, ?, ?, ?, ?)").run(n.to, n.kind ?? null, n.text, JSON.stringify(n), now()),
    listNotifications: (role, limit = 50) => q("SELECT * FROM notifications WHERE role = ? ORDER BY rowid DESC LIMIT ?").all(role, limit).map((r) => ({ ...JSON.parse(r.json), at: r.at })),
    // ── cycles ──
    logCycle: (c) => q("INSERT INTO cycles (trigger_type, trigger_id, status, ms, at) VALUES (?, ?, ?, ?, ?)").run(c.type, c.id ?? null, c.status, c.ms, now()),
    cycleStats: () => q("SELECT trigger_type AS type, status, COUNT(*) AS n, AVG(ms) AS avgMs FROM cycles GROUP BY trigger_type, status").all(),
  };
}
