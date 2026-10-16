# Known-risk list

Maintained with the code. Each risk has an owner, a residual rating and the next mitigation. Judges reward candour; nothing here is hidden in the self-assessment.

| # | Risk | Residual | Mitigation in place | Next step |
| --- | --- | --- | --- | --- |
| K-01 | Testnet mocks (stablecoins, oracles, AMM, lending) behave unlike production venues | Medium | Mocks labelled in code (`isMock()`), docs and UI footer; vault code is venue-agnostic | Point `changeVenues` at audited venues on a permitted rail |
| K-02 | A stolen agent key can pay the owner's *own* payees up to one daily cap | Low | Registry-only recipients; caps; guardian pause; key expiry (30 days) | Shorter-lived keys rotated by the owner's wallet |
| K-03 | Owner key compromise | Medium | Loosening timelocked; new payees and unknown-address withdrawals delayed; guardian pause | Guardian-assisted social recovery |
| K-04 | Owner approves a poisoned payee address in Tier 2 | Medium | 24 h cooling-off; scam score; guardian alert; first payment co-signed | Address-similarity warning against existing payees |
| K-05 | 24 h window is 1-hour granular | Low | Documented bound; invariant I-2 checks the implemented window exactly | Per-minute buckets if a regulator requires it |
| K-06 | Price manipulation on thin testnet liquidity | Medium (testnet) | On-chain oracle floor; R-06 deviation rule; daily swap cap bounds loss at 0.5 % × 500 USDC/day | Chainlink feeds and deep venues in production |
| K-07 | Oracle outage stops swaps and lending | Low | Staleness bound fails closed; payments unaffected | Secondary feed |
| K-08 | Model outage or refusal | Low | Offline planner fallback; templates for schedules; fail closed | Second model provider behind the adapter |
| K-09 | Scam heuristics produce false positives / negatives | Medium | Holds are reversible after cooling-off; on-chain cooling-off is independent of the heuristic | Learn from guardian feedback; more languages |
| K-10 | Simulation without a fork node is weaker (eth_call fallback) | Low | Contract still enforces; post-trade verification still runs | Docker image ships anvil; fork mode is default in deployment |
| K-11 | Server holds the agent key | Medium | Env-only secret, redacted logs, key cannot exceed T1 | Remote signer / HSM |
| K-12 | Receipt store is off-chain | Low | Hashes anchored on-chain; tampering detectable via `/verify` | Optional IPFS pinning of receipts |
| K-13 | Regulatory status of stablecoin remittance varies by country | High (business) | Jurisdiction policy pack field; no speculative features; cash-out out of scope | Licensed partner rails; tokenized deposits |
| K-14 | Base Sepolia deployment depends on public faucets and RPCs | Low | RPC fallback transport; reserve wallet | Paid RPC for the review window |
| K-15 | Hardhat cannot fork another local Hardhat node | Low (dev only) | Local dev uses snapshot/revert simulation on chain 31337 only | — |
