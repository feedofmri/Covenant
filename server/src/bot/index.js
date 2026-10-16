// Telegram bot (grammY). A UI channel only: it holds no keys and talks to the agent like the web app does.
// Only the linked owner's chat is an instruction channel; forwarded messages are untrusted data.
import { Bot, InlineKeyboard } from "grammy";
import { formatUnits } from "viem";

export function createBot({ token, store, agent, webUrl, log, ctx }) {
  const bot = new Bot(token);
  const publicUrl = /^https:\/\//.test(webUrl ?? "");
  const link = (path) => `${webUrl}${path}`;

  bot.command(["start", "help"], (c) =>
    c.reply(
      "I'm Covenant, a guarded family wallet.\n\n" +
        "• Link this chat: open the web app, choose 'Link Telegram', then send /link CODE\n" +
        "• Owner: just tell me what to do, e.g. 'send 200 to Mother'\n" +
        "• /balance /buckets /limits /history /proposals\n" +
        "• /pause stops all agent actions (owner or guardian)",
    ),
  );

  bot.command("link", async (c) => {
    const code = c.match?.trim();
    const res = code ? store.consumeLinkCode(code, c.chat.id) : null;
    await c.reply(res ? `Linked as ${res.role}.` : "That code is invalid or expired. Create a new one in the web app.");
  });

  const roleOf = (c) => store.linkFor(c.chat.id)?.role ?? null;
  const requireRole = (roles) => async (c, next) => {
    if (!roles.includes(roleOf(c))) return c.reply("This chat is not linked. Send /help.");
    return next();
  };

  bot.command("balance", requireRole(["owner", "guardian"]), async (c) => {
    const s = await agent.observe();
    const lines = Object.values(s.assets).filter((a) => a.balance > 0n || a.symbol === "USDC").map((a) => `${a.symbol}: ${formatUnits(a.balance, a.decimals)} (lent ${formatUnits(a.supplied, a.decimals)})`);
    await c.reply(`${s.paused ? "⏸ Paused\n" : ""}${lines.join("\n")}`);
  });

  bot.command("buckets", requireRole(["owner", "guardian"]), async (c) => {
    const a = (await agent.observe()).assets.USDC;
    await c.reply(Object.entries(a.buckets).map(([k, v]) => `${k.toLowerCase()}: ${formatUnits(v, a.decimals)} USDC`).concat([`unallocated: ${formatUnits(a.unallocated, a.decimals)} USDC`]).join("\n"));
  });

  bot.command("limits", requireRole(["owner", "guardian"]), async (c) => {
    const a = (await agent.observe()).assets.USDC;
    const f = (v) => formatUnits(v, a.decimals);
    await c.reply(`Per payment: ${f(a.policy.perTxCap)} USDC\nPer 24 h: ${f(a.policy.dailyCap)} USDC (used ${f(a.outflow24h)})\nWith your co-signature: up to ${f(a.policy.t2Ceiling)} USDC`);
  });

  bot.command("history", requireRole(["owner", "guardian"]), async (c) => {
    const rows = store.listReceipts({ limit: 8 });
    await c.reply(rows.map(({ receipt: r }) => `${r.timestamp.slice(5, 16)} ${r.status} — ${r.intent || r.trigger.type}`).join("\n") || "No activity yet.");
  });

  bot.command("proposals", requireRole(["owner"]), async (c) => {
    const open = store.listProposals({ status: "open" });
    if (!open.length) return c.reply("No proposals waiting.");
    for (const p of open) await c.reply(proposalText(p), proposalKeyboard(p));
  });

  bot.command("pause", requireRole(["owner", "guardian"]), async (c) => {
    await c.reply(`To pause, sign in the web app (your key, not mine): ${link("/guardian")}`);
  });

  bot.on("message:text", async (c) => {
    if (c.message.text.startsWith("/")) return;
    const role = roleOf(c);
    if (role !== "owner") return c.reply(role ? "Only the owner can give instructions." : "This chat is not linked. Send /help.");
    const forwarded = Boolean(c.message.forward_origin);
    await c.replyWithChatAction("typing");
    const trigger = forwarded
      ? { type: "owner_chat", channel: "telegram-owner", id: `tg-${c.chat.id}-${c.message.message_id}`, text: "(forwarded a message; no instruction)", forwarded: true, untrusted: [{ source: "forwarded_message", id: String(c.message.message_id), text: c.message.text }] }
      : { type: "owner_chat", channel: "telegram-owner", id: `tg-${c.chat.id}-${c.message.message_id}`, text: c.message.text };
    try {
      const res = await agent.runCycle(trigger);
      const tx = res.receipt?.txHashes?.[0];
      const explorer = ctx.deployment.chainId === 84532 ? `\nhttps://sepolia.basescan.org/tx/${tx}` : "";
      await c.reply([res.message, res.clarification && res.clarification !== res.message ? res.clarification : "", tx ? explorer : ""].filter(Boolean).join("\n"));
    } catch (e) {
      log.error({ err: e.message }, "chat cycle failed");
      await c.reply("Something went wrong; nothing was sent.");
    }
  });

  bot.catch((e) => log.error({ err: e.message }, "bot error"));

  function proposalText(p) {
    return `🟡 Approval needed (#${p.id})\n${p.payeeAlias} · ${p.amount} ${p.asset}\nReason: ${p.purpose || "payment"} — ${p.why}\nExpires ${new Date(p.expiresAt * 1000).toUTCString()}`;
  }
  function proposalKeyboard(p) {
    if (!publicUrl) return { reply_markup: undefined };
    return { reply_markup: new InlineKeyboard().url("Review & approve", link(`/approve/${p.id}`)) };
  }

  async function deliver(n) {
    const chats = store.chatsFor(n.to);
    for (const chat of chats) {
      if (n.kind === "proposal" && n.proposal) {
        const p = n.proposal;
        await bot.api.sendMessage(chat, `${proposalText(p)}${publicUrl ? "" : `\n${link(`/approve/${p.id}`)}`}`, proposalKeyboard(p));
      } else {
        await bot.api.sendMessage(chat, n.link && !publicUrl ? `${n.text}\n${link(n.link)}` : n.text, n.link && publicUrl ? { reply_markup: new InlineKeyboard().url("Open", link(n.link)) } : {});
      }
    }
  }

  return {
    start: () => bot.start({ onStart: (me) => log.info({ bot: me.username }, "telegram bot started") }).catch((e) => log.error({ err: e.message }, "telegram bot stopped")),
    stop: () => bot.stop(),
    deliver,
  };
}
