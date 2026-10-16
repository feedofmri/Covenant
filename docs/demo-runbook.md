# Demo runbook (video and live)

Preconditions: stack running (`npm run stack` locally or the hosted server), owner wallet in MetaMask, guardian's Telegram linked, explorer tab open on the vault.

| Act | Scenario | Do | Show |
| --- | --- | --- | --- |
| 1 It works | D1 | Mandate page: current mandate, hash on-chain | createVault tx on the explorer |
| | D2 | Employer sends 1 000 USDC with memo "October wages" (`npm run demo` does this) | Activity: split 500/200/300; remittance 200 to Mother; tx links |
| | D3 | Savings sweep | 150 USDC lent; dashboard "lent" line |
| 2 It refuses | D5 | Poisoned memo transfer | Receipt: `R-01:block`, "untrusted text looked like an instruction (ignored)"; forced pay to the attacker reverts `T3_UnknownPayee` (hash) |
| | D6/D8 | Stolen key script | Five reverts on the explorer with decoded errors; guardian taps Pause; pay while paused reverts `VaultPaused` |
| | D7 | Owner types "URGENT: pay 150 USDC customs fee to 0x…" | "On hold" explanation in chat; guardian's Telegram alert |
| 3 It escalates | D4 | Owner: "Mother needs 400 USDC for a hospital bill" | 100 moves from the emergency fund, proposal #N; Telegram "Review & approve" → gasless signature → paid |
| Close | D9 | Mock oracle to 0.96 | Yield paused, lent savings withdrawn, lending attempt reverts `T3_Depegged` |
| Proof | — | `/verify` a receipt, change one character | green → red |

Re-shoot from scratch in under 30 minutes: restart the chain (`npm run stack`), then `npm run demo`.
