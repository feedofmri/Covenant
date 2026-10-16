// Notifications: in-app feed (always) + Telegram (when a chat is linked for that role).
export function createNotifier({ store, log }) {
  let bot = null;
  const notify = async (n) => {
    store.addNotification(n);
    if (!bot) return;
    try {
      await bot.deliver(n);
    } catch (e) {
      log.warn({ err: e.message }, "telegram delivery failed");
    }
  };
  notify.attachBot = (b) => (bot = b);
  return notify;
}
