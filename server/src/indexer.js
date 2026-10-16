// Indexer: polls chain logs and turns them into agent triggers and ledger rows.
//  - Transfer into the vault (any token) → incoming_transfer trigger; memo / token name go in as untrusted data
//  - vault events → proposals, payees, pauses, owner actions recorded in the ledger
import { decodeEventLog, parseAbi, formatUnits, getAddress } from "viem";

const erc20Events = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Memo(address indexed from, address indexed to, uint256 amount, string memo)",
]);
const erc20Meta = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function createIndexer({ ctx, store, agent, notify, log, confirmations = 0, pollMs = 2000 }) {
  const vault = getAddress(ctx.vault.address);
  const internal = new Set([ctx.deployment.contracts.amm, ctx.deployment.contracts.lendingPool, vault].map((a) => getAddress(a)));
  const known = Object.fromEntries(Object.values(ctx.tokens).map((t) => [getAddress(t.address), t.symbol]));
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const latest = await ctx.publicClient.getBlockNumber();
      const to = latest - BigInt(confirmations);
      let from = BigInt(store.kvGet("cursor") ?? ctx.deployment.startBlock);
      if (to < from) return;
      // cap the range per request (public RPCs limit getLogs spans)
      const end = to - from > 2000n ? from + 2000n : to;
      const [vaultLogs, inbound] = await Promise.all([
        ctx.publicClient.getLogs({ address: vault, fromBlock: from, toBlock: end }),
        ctx.publicClient.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: [TRANSFER_TOPIC, null, `0x000000000000000000000000${vault.slice(2).toLowerCase()}`] }] }),
      ]);
      await handleVaultLogs(vaultLogs);
      await handleInbound(inbound);
      store.kvSet("cursor", (end + 1n).toString());
    } catch (e) {
      log.warn({ err: e.shortMessage ?? e.message }, "indexer tick failed");
    } finally {
      running = false;
    }
  }

  async function handleInbound(logs) {
    const byTx = new Map();
    for (const l of logs) {
      const ev = decodeEventLog({ abi: erc20Events, data: l.data, topics: l.topics });
      const from = getAddress(ev.args.from);
      if (internal.has(from)) continue; // swap output, lending withdrawals: not income
      if (!byTx.has(l.transactionHash)) byTx.set(l.transactionHash, []);
      byTx.get(l.transactionHash).push({ token: getAddress(l.address), from, value: BigInt(ev.args.value), blockNumber: BigInt(l.blockNumber) });
    }
    for (const [txHash, transfers] of byTx) {
      const id = `in-${txHash}`;
      if (store.hasTrigger(id)) continue;
      const untrusted = [];
      const receipt = await ctx.publicClient.getTransactionReceipt({ hash: txHash });
      for (const l of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: erc20Events, data: l.data, topics: l.topics });
          if (ev.eventName === "Memo" && getAddress(ev.args.to) === vault) untrusted.push({ source: "transfer_memo", id: txHash, text: ev.args.memo });
        } catch { /* other events */ }
      }
      let unknownToken = null;
      for (const t of transfers) {
        if (known[t.token]) {
          const dec = await ctx.tokens[known[t.token]].contract.read.decimals();
          if (!store.hasTx(txHash)) store.recordTx({ hash: txHash, kind: "income", outcome: "success", actor: t.from, note: `${formatUnits(t.value, dec)} ${known[t.token]} received`, scenario: store.kvGet("scenarioTag") });
        } else {
          // Unknown token airdropped to the vault: its name is attacker-controlled text.
          const [name, symbol] = await Promise.all([
            ctx.publicClient.readContract({ address: t.token, abi: erc20Meta, functionName: "name" }).catch(() => "?"),
            ctx.publicClient.readContract({ address: t.token, abi: erc20Meta, functionName: "symbol" }).catch(() => "?"),
          ]);
          unknownToken = { address: t.token, name, symbol };
          untrusted.push({ source: "token_name", id: t.token, text: `${name} (${symbol})` });
        }
      }
      log.info({ txHash, memo: untrusted.length }, "incoming transfer");
      const res = await runAndLog({ type: "incoming_transfer", id, untrusted, unknownToken, scenario: store.kvGet("scenarioTag") });
      if (unknownToken) await notify({ to: "owner", kind: "unknown_token", text: `An unknown token "${unknownToken.symbol}" was sent to your wallet. It is ignored; never interact with tokens you did not expect.` });
      if (res?.status === "executed") await notify({ to: "owner", kind: "income", text: res.message });
    }
  }

  async function handleVaultLogs(logs) {
    for (const l of logs) {
      let ev;
      try {
        ev = decodeEventLog({ abi: ctx.abis.vault, data: l.data, topics: l.topics });
      } catch {
        continue;
      }
      const tx = l.transactionHash;
      const recordOwner = async (kind, note) => {
        if (store.hasTx(tx)) return;
        const t = await ctx.publicClient.getTransaction({ hash: tx });
        if (ctx.account && getAddress(t.from) === getAddress(ctx.account.address)) return; // the agent records its own
        store.recordTx({ hash: tx, kind, tier: kind === "approve" ? "T2" : null, outcome: "success", actor: getAddress(t.from), note, scenario: store.kvGet("scenarioTag"), block: Number(l.blockNumber) });
      };
      switch (ev.eventName) {
        case "Approved": {
          store.updateProposal(Number(ev.args.id), { status: "executed", approvedTx: tx });
          await recordOwner("approve", `proposal #${ev.args.id} co-signed`);
          await notify({ to: "owner", kind: "approved", text: `Approved and paid: proposal #${ev.args.id}.` });
          await notify({ to: "guardian", kind: "approved", text: `A co-signed payment (proposal #${ev.args.id}) was made.` });
          break;
        }
        case "Cancelled":
          store.updateProposal(Number(ev.args.id), { status: "cancelled" });
          break;
        case "PayeeAdded": {
          const pending = JSON.parse(store.kvGet(`label:${getAddress(ev.args.wallet)}`) ?? "null");
          const existing = store.listPayees().find((p) => p.id === ev.args.payeeId);
          store.upsertPayee({ id: ev.args.payeeId, alias: pending?.alias ?? existing?.alias ?? `Payee ${getAddress(ev.args.wallet).slice(0, 8)}`, address: getAddress(ev.args.wallet), purpose: pending?.purpose ?? existing?.purpose ?? "", addedAt: Math.floor(Date.now() / 1000) });
          await recordOwner("addPayee", `${pending?.alias ?? "payee"} added; usable from ${new Date(Number(ev.args.activeFrom) * 1000).toISOString()}`);
          if (Number(ev.args.activeFrom) > Math.floor(Date.now() / 1000) + 60) {
            await notify({ to: "guardian", kind: "payee_added", text: `A new payee "${pending?.alias ?? "unnamed"}" was added. It can be paid after the 24-hour cooling-off.` });
          }
          break;
        }
        case "PayeeRemoved":
          await recordOwner("removePayee", "payee removed");
          break;
        case "Paused": {
          const t = await ctx.publicClient.getTransaction({ hash: tx });
          await recordOwner("pause", "vault paused");
          await notify({ to: "owner", kind: "paused", text: `The wallet was paused by ${getAddress(t.from) === getAddress(ctx.deployment.accounts.guardian) ? "your guardian" : "a safety check"}. Only you can unpause it.` });
          break;
        }
        case "Unpaused":
          await recordOwner("unpause", "vault unpaused");
          break;
        case "MandateSet":
        case "ChangeQueued":
        case "ChangeExecuted":
        case "OwnerWithdrawal":
        case "OwnerWithdrawalQueued":
          await recordOwner(ev.eventName, ev.eventName);
          break;
        default:
          break;
      }
    }
  }

  async function runAndLog(trigger) {
    const t0 = Date.now();
    try {
      const res = await agent.runCycle(trigger);
      store.logCycle({ type: trigger.type, id: trigger.id, status: res.status, ms: Date.now() - t0 });
      return res;
    } catch (e) {
      store.logCycle({ type: trigger.type, id: trigger.id, status: "error", ms: Date.now() - t0 });
      log.error({ err: e.message }, "cycle failed");
      return null;
    }
  }

  return {
    start() {
      timer = setInterval(tick, pollMs);
      tick();
    },
    stop: () => clearInterval(timer),
    tick,
    runAndLog,
  };
}
