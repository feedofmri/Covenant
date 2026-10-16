# Covenant — Technical Documentation

PBCSF Fintechathon 2026 · International Track · Topic F (Agent Wallet)

> Judges short on time: read the [2-page judge brief](judge-brief.md) first. Every claim below points to the file that implements it and the test that proves it.

## 1. Problem and user

Rahim works abroad and supports his mother and children at home. He is not a crypto user, and he is exactly the person scammers target. He needs a wallet that receives wages, sends money home on schedule, grows savings safely, and cannot be drained — not by a hijacked AI, and not by a human who pressures him.

Two facts shape the design:

1. **An LLM cannot be trusted with authority.** Prompt injection, hallucinated amounts and key theft are not edge cases; they are the normal threat model for an agent that reads untrusted text and holds a key.
2. **The user cannot be trusted under pressure either.** Most retail losses come from social engineering: urgency, a new number, a "fee" to release something.

Covenant answers both with **two-way guardrails**: an on-chain contract bounds the agent, and the agent (plus the contract's cooling-off rules) protects the user from scammers. Rahim's mother is a **guardian**: she sees balances and alerts and can pause the agent, but cannot spend.

### Topic F operations

| Operation | Covenant | Implemented in |
| --- | --- | --- |
| Asset management | Payday split into family / emergency / savings buckets; idle savings lent within caps; swaps with an oracle floor | `PolicyVault.allocate/reallocate/supply/withdraw/swap`, `agent/src/templates.js` |
| Transaction execution | Scheduled remittances, chat requests (EN + BN), Tier 2 co-signed payments | `PolicyVault.pay/propose/approve/approveWithSig`, `agent/src/loop.js` |
| Risk control | Tier model in Solidity, 15 deterministic rules, simulation, verification + circuit breaker, peg monitor, sanctions, scam scoring | `agent/src/risk/*`, `agent/src/simulate.js`, `agent/src/verify.js`, `server/src/scheduler.js` |

## 2. System architecture

```
          untrusted world                      owner channels                 guardian
  (memos, token names, forwarded msgs,     (Telegram owner chat,          (web / Telegram:
   price/tool output, incoming tokens)      web session, signed)           alerts, pause)
                 │ data only                      │ instructions               │
                 ▼                                ▼                            │
 ┌──────────────────────────────── off-chain agent (Node 22) ────────────────────────────────┐
 │ indexer → trigger ─► observe ─► PLAN (Claude / offline rules) ─► COMPILE (deterministic)    │
 │                        │          ▲ aliases, human units only        │ exact calls,        │
 │                        │          └── intent firewall: trigger-scoped │ decimals from chain │
 │                        ▼              capabilities, datamarking       ▼                     │
 │                 CHECK (15 rules) ─► TIER (mirror of contract) ─► SIMULATE (fork) ─►         │
 │                 EXECUTE (session key) ─► VERIFY (real vs simulated deltas, pause on diff) ─►│
 │                 RECORD (Verifiable Intent Receipt, anchored)                                 │
 └───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                             │ adapter calls only (pay, allocate, swap, supply, withdraw, propose)
 ┌──────────────────────────── on-chain (Base Sepolia, EVM) ──────────────────────────────────┐
 │ PolicyVault (clone) — tiers, caps, 24 h sliding window, payee registry + cooling-off,        │
 │   buckets, oracle floor, depeg rule, timelock (loosen) / instant (tighten), guardian pause   │
 │ VaultFactory — owner-signed creation = mandate on-chain        ReceiptRegistry — anchors     │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Components**

| Layer | Technology | Notes |
| --- | --- | --- |
| Contracts | Solidity 0.8.28, OpenZeppelin 5.1, Hardhat 2.29, via-IR | Vault ≈ 21 KB runtime; clones keep creation cheap |
| Agent | Node 22 ESM, viem, zod 4, `@anthropic-ai/sdk` | Planner on Claude Opus 5.5 (structured outputs); classifier on Claude Haiku 5.5 |
| Server | Fastify 5, better-sqlite3, node-cron, grammY, pino | One process: API, indexer, scheduler, bot |
| Web | React 18, Vite, Tailwind, viem (EIP-1193 provider) | No wagmi: keeps every shipped dependency permissively licensed |
| Simulation | anvil fork (production) / snapshot-revert on the dev chain / eth_call fallback | `agent/src/simulate.js` |

## 3. Core algorithm

### 3.1 The cycle (`agent/src/loop.js`)

Every trigger — owner message, schedule, incoming transfer, price event — runs one cycle, serialized per vault by a mutex and made idempotent by an atomic trigger claim (`claimTrigger`, safe across processes).

1. **Observe** (`observe.js`): one snapshot of balances, buckets, caps, 24 h window usage, payees (with cooling-off and first-payment state), oracle prices, pause state, the mandate.
2. **Plan** (`planner.js`): the model returns JSON against a schema built *per call*. The `payee` field is an enum of the aliases registered right now; the reply is validated against that schema, so any other recipient is rejected and the cycle fails closed (tested in `agent/test/model.test.js`). Amounts are decimal strings matching `^\d{1,9}(\.\d{1,6})?$`; no base units, exponents, negatives or hex. Scheduled mandates skip the model entirely (`templates.js`).
3. **Compile** (`compile.js`): aliases → on-chain payee ids, decimals read from the token, bucket ids, exact adapter calls. New-payee requests become an *owner action* (calldata the owner signs), never an agent call.
4. **Check** (`risk/engine.js`): 15 rules (§3.3) with running bucket balances so multi-step plans are checked in order.
5. **Tier** (`tier.js`): mirrors the contract — T1 executes, T2 becomes an on-chain proposal, T3 is refused.
6. **Simulate** (`simulate.js`): the exact calls run on a fork impersonating the agent; measured vault deltas must match the plan.
7. **Execute**: the session key sends the adapter calls. Each call carries the **intent hash** as its last argument.
8. **Verify** (`verify.js`): real deltas from `Transfer` logs vs simulated deltas. A mismatch makes the agent pause the vault (only the owner can unpause) and alerts the guardian.
9. **Record** (`receipts.js`): a Verifiable Intent Receipt is stored and its hash anchored in `ReceiptRegistry`.

Failure at any step ends the cycle with a receipt and **no transaction**. A model outage falls back to the offline planner; scheduled actions never depend on the model — a missed action, never a wrong one.

### 3.2 On-chain enforcement (`contracts/src/PolicyVault.sol`)

The agent can call only named adapters; recipients are fixed by construction:

| Function | Recipient | Enforced |
| --- | --- | --- |
| `pay(payeeId, asset, amount, bucket, intentHash)` | `payees[payeeId].wallet` | registered, active, cooled off, first payment already co-signed, `amount ≤ perTxCap`, 24 h sliding window ≤ `dailyCap`, `amount ≤ t2Ceiling` |
| `allocate` / `reallocate` | none (internal ledger) | ≤ unallocated / bucket balance |
| `swap(bucket, in, out, amountIn, intentHash)` | the vault | allowed pair, per-tx and daily swap caps, fresh oracle, depeg rule, exact approval, output measured by **balance delta** ≥ oracle floor, input delta = `amountIn`, zero residual allowance |
| `supply` / `withdraw` | the vault (`onBehalfOf` / `to` hard-coded) | lending cap, depeg rule, exact approval, zero residual allowance |
| `propose(action, intentHash)` | — | payee active and cooled off, `amount ≤ t2Ceiling`, 24 h expiry |

**24 h sliding window.** 24 hourly slots in a ring buffer per asset; a payment passes only if the sum of the slots within the last 24 hours plus the amount stays within the cap. A naive reset would let twice the cap through across the reset; the test `uses a 24 h sliding window, not a reset` proves it does not.

**Oracle floor.** `minOut = amountIn × priceIn / priceOut × (1 − maxSlippageBps)`, scaled across token and oracle decimals, with a staleness bound. The router's return value is never trusted.

**Governance.** Tightening is instant (`lowerCaps`, `removePayee`, `removePair`, `pause`, `revokeAgent`). Loosening is timelocked (`queueChange` → `executeChange` on a whitelist of `change*` selectors: asset policy, pairs, roles, venues, parameters). New payees cool off: the cooling-off *is* the payee timelock. Payees registered at deployment (the ceremony) are trusted.

**Owner self-protection.** `ownerWithdraw` is instant only to the owner or a cooled-off payee. Any other destination is queued for the cooling-off period, so pressure on the owner gains a scammer nothing quickly.

**No generic calls.** `fallback` and `receive` revert with `T3_NoGenericCalls`.

**Errors carry the tier.** `T3_UnknownPayee`, `T2_DailyCapExceeded`, `T3_Depegged`, … decode on the verified explorer page, so a revert hash explains itself.

### 3.3 Deterministic risk rules (`agent/src/risk/engine.js`)

| Id | Rule | Failure |
| --- | --- | --- |
| R-01 | Action type allowed for the trigger (incoming transfer → allocate only; price event → withdraw only; non-owner chat → nothing) | block |
| R-02 | Payee registered and active; cooling-off → hold | block / hold |
| R-03 | Asset allowed; amount positive; action resolvable | block |
| R-04 | Amount ≤ co-sign ceiling; swap caps | block |
| R-05 | Recipient not on the OFAC-derived denylist | block |
| R-06 | Pool quote within 1 % of the oracle (swaps) | block |
| R-07 | Stablecoin within peg (swap, supply) | block |
| R-08 | Bucket has funds (running balances); emergency fund only on the owner's request | block |
| R-09 | Lending cap; liquid savings buffer kept | block |
| R-10 | Plan sends > 50 % of the balance → force T2 | T2 |
| R-11 | Scam score ≥ 0.6 → hold + guardian alert; ≥ 0.3 → force T2 + guardian alert | hold / T2 |
| R-12 | Same payment within 10 minutes | block |
| R-13 | Vault not paused; agent key not expired | block |
| R-14 | Purpose required above 300 USDC | clarify |
| R-15 | Simulation matches the plan | sim_mismatch |

**Scam score** (`risk/scam.js`, weights in `shared/constants.js`): new or cooling-off recipient 0.35, recently added recipient 0.25, pressure language (EN + Bangla keyword list) 0.25, amount > 2× median 0.15, forwarded/untrusted origin 0.15, 00:00–05:00 local 0.05.

### 3.4 Intent firewall (`agent/src/firewall.js`)

* Only the linked owner's Telegram chat and the signed-in owner web session carry instructions. Forwarded messages are untrusted data even from the owner.
* Untrusted text is wrapped in `<untrusted_data>` blocks with datamarking (every line prefixed `^`) and the system prompt forbids following it.
* **Trigger-scoped capabilities** are enforced in code, not in the prompt: a poisoned memo arrives on an `incoming_transfer` trigger, which may only produce `allocate`.
* A small model scores untrusted text for injection. It is a *signal* in the receipt and alerts, never a gate — the red-team suite runs with a classifier that misses everything, and the rules still hold.
* Keys, RPC URLs, payee addresses and personal data never enter model context; the model sees aliases and human units only.

### 3.5 Verifiable Intent Receipts (`shared/schemas/receipt.js`)

Two hashes over RFC 8785 canonical JSON:

* **intentHash** covers the pre-execution fields (trigger, mandate hash, plan, checks, tier, explanation). It is passed into the action transaction itself, so the chain records *why* the money moved.
* **receiptHash** covers the whole receipt (adds status, tx hashes, simulated and actual deltas, signals) and is anchored in `ReceiptRegistry` (one tx per receipt, or an hourly Merkle root with `ANCHOR_MODE=batch`).

The web verifier (`/verify`) and `POST /api/verify` recompute both hashes from a pasted receipt and check the anchor and the action transactions. Changing one character fails verification (tested in `server/test/api.test.js`).

### 3.6 Mandate compilation (`agent/src/mandate.js`)

Plain English → structured mandate (Claude, or the offline parser) → `Mandate` schema validation (buckets sum to 100, per-payment ≤ daily ≤ co-sign ceiling, remittance payees registered) → the exact owner transactions: `setMandateHash` (instant), `lowerCaps` when limits go down (instant) or `queueChange(changeAssetPolicy)` when they go up (timelocked).

## 4. Smart contracts

| Contract | Purpose |
| --- | --- |
| `PolicyVault` | Funds, tiers, caps, payees, buckets, adapters, proposals, timelock, pause. Initialised once; the implementation is locked |
| `VaultFactory` | `createVault` must be sent by the future owner, so the creation tx is the owner's signature on the mandate (D1). EIP-1167 clones |
| `ReceiptRegistry` | `anchor(receiptHash, intentHash)`, `anchorBatch(root, count)`; first-anchor timestamp kept |
| Mocks | `MockStable` (6 dp, faucet, `transferWithMemo`), `MockAggregator`, `MockAmm` (own constant-product code), `MockLendingPool` (Aave-shaped), attack tokens and hostile routers. Every mock exposes `isMock()` |

Interfaces for Chainlink, Aave and the router were written from public ABIs; no GPL or BUSL code is used.

**Tests** (`contracts/test`): 38 unit tests touch every function and every custom error; the invariant harness drives seeded random sequences of agent, owner, guardian and attacker calls, time warps, oracle moves and income, and asserts after every step:

* **I-1** every token leaving the vault goes to a registered payee, the router or the lending pool;
* **I-2** the on-chain window equals an independently computed 24 h sum and never exceeds the cap after a T1 payment;
* **I-3** bucket accounting is exact and solvent;
* **I-4** no residual approvals;
* **I-5** the agent or an attacker never changes owner-only state;
* **I-6** a paused vault accepts no agent adapter call.

Coverage (solidity-coverage, production contracts): **100 % lines, 100 % functions, 82 % branches** for `PolicyVault`; 100 % for `VaultFactory` and `ReceiptRegistry`. CI fails below 95 % lines.

## 5. Security design

See the [security self-assessment](self-assessment.md) for the full tier table with the enforcing line for every rule, the threat model and red-team results. In summary, six layers, each sufficient on its own for the attacks it targets:

1. Intent firewall — 2. deterministic risk engine — 3. pre-trade simulation — 4. on-chain PolicyVault (final authority) — 5. post-trade verification and circuit breaker — 6. tamper-evident receipts.

## 6. Compliance design

* **Sanctions screening**: `shared/denylist.json` from OFAC SDN Ethereum addresses, refreshed with `scripts/update-denylist.js`; applied to payees and new-payee requests (R-05).
* **Payee due diligence**: owner-only registry with label hash on-chain, purpose kept off-chain; 24 h cooling-off; first payment co-signed; purpose code required above 300 USDC (R-14).
* **Human oversight**: Tier 2 co-signature (also gasless via EIP-712), guardian pause and agent-key revocation, owner-readable activity feed with the reason for every action.
* **Explainability**: every receipt lists the rules it passed or failed and a plain-language explanation.
* **Data minimisation**: no personal data on-chain (payee labels are hashes); the model never sees addresses or keys.
* **Jurisdiction policy pack**: the mandate carries `jurisdictionPack`; production would enable features per country and run only on permitted rails (licensed stablecoins, tokenized deposits). Cash-out is out of scope.

## 7. Evaluation

| Measure | Result | How to reproduce |
| --- | --- | --- |
| Contract unit tests | 38 / 38 pass | `npm run test:contracts` |
| Invariant harness | 0 violations over 300 sequences × 60 steps (18 000 random calls) | `INVARIANT_RUNS=300 INVARIANT_STEPS=60 npm run test:contracts` |
| Agent tests | 32 pass: 16 unit, 8 Claude-adapter tests against a fake Messages API (request shape, refusal, rate limit, malformed or out-of-schema output, offline fallback), 8 end-to-end | `npm -w agent test` |
| Server tests | 21 pass: API and wallet auth, Telegram bot (roles, forwarded messages, approve buttons), system test (indexer, hostile token airdrop, payee registration, mandate round trip, gasless relay, peg monitor, batch anchoring, every receipt verified), unattended run | `npm -w server test` |
| Container | image builds and runs healthy against a chain | `docker build .` |
| Browser flows | sign-in, chat, gasless co-sign, guardian pause/unpause, mandate preview, add payee | Playwright script in the dev notes |
| Red-team suite | **30 / 30 cases stopped, attacker gained 0**, 22 reverted attack transactions on-chain | `npm run redteam` |
| Demo scenarios | D1–D9 complete end to end | `npm run demo` |

**Gas** (measured in the local D1–D9 run; first use of a storage slot costs more than later uses): `createVault` (clone + initialise) 737 k, `allocate` 74 k (repeat) to 293 k (first time, three new buckets), `reallocate` 47 k, `pay` 173 k (first payment in a fresh window slot), `supply` 169 k, `withdraw` 93 k, `propose` 208 k, owner `approveWithSig` 103 k, `anchor` 47 k. At Base Sepolia gas prices each action costs a small fraction of a cent.

**Model cost**: scheduled actions use no model. An owner chat request is one planner call (Claude Opus 5.5, medium effort, ~2–3 k input tokens) plus, when untrusted text is present, one classifier call (Claude Haiku 5.5, low effort).

Unattended-run statistics (success rate and latency per trigger type) are served live by `GET /api/stats` and included in the evidence ledger once the testnet run is under way.

## 8. Limitations and roadmap

* Mocks for tokens, price feeds, AMM and lending on testnet (labelled). Production: licensed stablecoins or tokenized deposits, Chainlink feeds, an audited lending market.
* Owner key loss: the owner can rotate roles through the timelock; social recovery with the guardian is on the roadmap.
* The 24 h window works at 1-hour granularity (documented bound).
* A deployment on WeBank's FISCO BCOS is planned after checking its solc and EVM version support (OpenZeppelin 5 needs solc ≥ 0.8.20).
* EIP-7702 path: upgrade a user's existing address into a guarded account.

## Appendix A — API reference

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | — | liveness, block, model provider |
| `GET /api/deployment`, `/api/state`, `/api/payees`, `/api/mandate` | — | public reads |
| `GET /api/receipts`, `/api/receipts/:id`, `/api/receipts/:id/verify`, `POST /api/verify` | — | receipts and verification |
| `GET /api/proposals`, `/api/proposals/:id`, `POST /api/proposals/:id/relay-approval` | — / owner signature | Tier 2 |
| `GET /api/ledger.json`, `.csv`, `.md`, `/api/stats` | — | evidence |
| `POST /api/auth/nonce`, `/api/auth/verify` | wallet signature | owner/guardian session |
| `POST /api/chat`, `/api/mandate/draft`, `/api/mandate/activate`, `/api/payees/prepare` | owner | instructions |
| `POST /api/telegram/link-code`, `GET /api/notifications` | owner / guardian | alerts |
| `POST /api/admin/*` | `ADMIN_TOKEN` | scenario tagging, triggers, peg check |

## Appendix B — Hash ledger

Generated by `npm run demo` and `npm run ledger` into `evidence/<network>/ledger.{csv,md,json}`; every row links to the explorer.
