# Deployment runbook (Base Sepolia)

## 1. Accounts and funds

Create five testnet wallets: **deployer**, **owner** (Rahim), **guardian** (Mother), **agent** (session key), **employer** (simulated wages). Add payee addresses for **Mother** and **School** (the Mother payee can be the guardian's wallet). Fund deployer, owner, agent and employer with Base Sepolia ETH from a faucet (0.05 ETH each is plenty; keep a reserve wallet).

## 2. Configure

```bash
cp .env.example .env    # fill keys, addresses, ETHERSCAN_API_KEY, RPC_URLS, ANTHROPIC_API_KEY
```

## 3. Deploy and verify

```bash
npm run deploy:base-sepolia
```

This deploys the labelled mocks, `VaultFactory` (with the locked `PolicyVault` implementation) and `ReceiptRegistry`, adds pool liquidity, funds the employer, and creates the demo vault **from the owner's key** (the D1 hash). It writes `shared/deployments/baseSepolia.json` and `shared/mandates/baseSepolia.json` — commit both. Contracts are verified on Basescan when `ETHERSCAN_API_KEY` is set (Sourcify is also enabled).

## 4. Run the server

Docker (includes anvil for fork simulation):

```bash
docker build -t covenant .
docker run -d --name covenant -p 8787:8787 -v covenant-data:/data --env-file .env \
  -e SIM_FORK_URL=$BASE_SEPOLIA_RPC_URL -e DEPLOYMENT=baseSepolia covenant
```

On Railway/Render: deploy the Dockerfile, mount a volume at `/data`, set the variables from `.env.example` (`UNATTENDED=1` starts the track-record run).

Web: `cd web && VITE_API_URL=https://<server> npm run build` and deploy `web/dist` to Vercel (SPA rewrite to `index.html`).

Telegram: create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and `WEB_URL` (https, so approve buttons work). Owner and guardian link their chats from the Guardian page.

## 5. Produce the evidence

```bash
DEPLOYMENT=baseSepolia npm run demo      # D1–D9 on the public chain → evidence/baseSepolia/ledger.*
DEPLOYMENT=baseSepolia npm run redteam   # 30 cases → redteam/RESULTS.baseSepolia.md
DEPLOYMENT=baseSepolia npm run ledger    # re-export at any time (includes the unattended run)
```

Run the demo and red-team from a machine with the keys in `.env`, pointing `DB_PATH` at a copy of the server database or let them use their own (`data/baseSepolia.sqlite`); `npm run ledger` merges what is in the database it reads.

## 6. Pre-submission checks

- [ ] `evidence/baseSepolia/ledger.md` has ≥ 30 hashes, every Topic F operation, ≥ 10 reverted attacks
- [ ] Every link opens on sepolia.basescan.org; custom errors decode on the verified vault
- [ ] `/verify` on a receipt shows all green; editing one character shows red
- [ ] `GET /api/stats` success rate copied into docs/technical.md §7
- [ ] Fresh clone → `npm install && npm run stack` works in under 15 minutes on a clean machine
