# Covenant — Judge Brief

**Topic F · Agent Wallet.** An AI wallet agent for workers abroad that manages income, remittances and savings, with every action bounded by an on-chain policy contract. *The model proposes, the contract disposes.*

## The problem

A migrant worker needs money sent home on time, savings that grow safely, and protection from the two things most likely to drain a wallet: a compromised automated agent and a scammer who pressures him. Every agent-wallet demo shows an LLM that can send tokens. The question a bank asks is different: **what is the worst this agent can do?**

## The answer we prove on-chain

**A stolen agent key can only pay your own family.** The agent's key can call only named adapter functions on the `PolicyVault`. Payment recipients come from a payee registry only the owner can change; swaps and lending return value to the vault itself; there is no generic call path. Caps, a 24-hour sliding window, a co-sign ceiling, cooling-off for new payees and an oracle floor are enforced in Solidity.

**Two-way guardrails.** The same rules protect the user from scammers: new payees wait 24 hours, the first payment to anyone needs the owner's signature, scam patterns hold a request and alert the guardian (his mother), and even the owner's own withdrawals to unknown addresses wait out the cooling-off.

## Topic F operations (one scenario each)

| Operation | Scenario | Evidence |
| --- | --- | --- |
| Asset management | D2/D3: 1 000 USDC wages split 500 family / 200 emergency / 300 savings; 150 idle savings lent within the cap | `allocate`, `supply` hashes in the ledger |
| Transaction execution | D2: scheduled 200 USDC to Mother (T1). D4: 400 USDC hospital bill → proposal → gasless EIP-712 co-sign → paid (T2) | `pay`, `propose`, `approveWithSig` hashes |
| Risk control | D5–D9: poisoned memo, stolen key, scam pressure, depeg — all stopped | reverted transactions with decoded errors (`T3_UnknownPayee`, `T3_NoGenericCalls`, `VaultPaused`, `T3_Depegged`) |

## Permission tiers (enforced in `PolicyVault.sol`)

| T0 Observe | T1 Autonomous | T2 Co-signed | T3 Prohibited |
| --- | --- | --- | --- |
| reads, quotes, simulation; no key | registered payees within 250 / tx and 300 / 24 h; buckets; swaps and lending into the vault | above the caps up to 1 000; first payment to a payee; 24 h expiry | unknown recipients, above the ceiling, policy changes by the agent, generic calls |

Guardian: instant pause and agent-key revocation. Owner: tightening instant, loosening timelocked.

## Security in numbers

* **Red team: 30 / 30 attacks stopped, attacker gained 0 tokens**, 22 attacks reverted on-chain — run with a deliberately hijacked planner and a stolen key that bypass every off-chain layer.
* **Invariants:** "every token leaving the vault reaches a registered payee, the router or the lending pool" and five more, checked after every step of 300 random sequences × 60 calls: no violation.
* **38** contract unit tests (every custom error), **100 %** line coverage of production contracts, **15** deterministic risk rules, pre-trade fork simulation, post-trade verification with an automatic pause.

## What is new

1. **Two-way guardrails** — the contract bounds the agent; the agent and the contract's cooling-off protect the user from scammers.
2. **Verifiable Intent Receipts** — each action transaction carries the hash of *why* it happened (plan, checks, tier); the full receipt is anchored and anyone can verify it at `/verify`.
3. **Trigger-scoped capabilities** — what a trigger may do is fixed in code, so a poisoned memo can at most re-split income.

## Inclusion and compliance

Telegram chat in English and Bangla, plain-language explanations on every action, a guardian role for family oversight, OFAC-derived sanctions screening, purpose codes, no personal data on-chain or in the model's context. Production would run only on permitted rails (licensed stablecoins or tokenized deposits); cash-out is out of scope and stated as such.

## Links

Video · Technical documentation (`docs/technical.md`) · Security self-assessment (`docs/self-assessment.md`) · Evidence ledger (`evidence/baseSepolia/ledger.md`) · Red-team results (`redteam/RESULTS.baseSepolia.md`) · Source: github.com/feedofmri/Covenant
