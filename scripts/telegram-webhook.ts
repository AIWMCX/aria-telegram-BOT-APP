/**
 * Controlled Telegram webhook registration — the one place production's
 * webhook destination actually gets set. Never runs automatically on
 * boot (index.ts only *verifies* the registration, never resets it) so a
 * webhook change is always a deliberate, logged, human-triggered action.
 *
 *   npm run telegram-webhook -- set
 *   npm run telegram-webhook -- info
 *   npm run telegram-webhook -- delete
 *
 * Requires TELEGRAM_BOT_TOKEN, PUBLIC_URL, and (for `set`)
 * TELEGRAM_WEBHOOK_SECRET in the environment — reads them via CONFIG,
 * same as the app itself. Never prints the token; getWebhookInfo's own
 * response contains no secret material, so it's safe to print in full.
 */
import { Bot } from "grammy";
import { CONFIG, TELEGRAM_WEBHOOK_PATH } from "../src/config.js";

async function main(): Promise<void> {
  const sub = process.argv[2];
  const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);
  const url = `${CONFIG.PUBLIC_URL}${TELEGRAM_WEBHOOK_PATH}`;

  if (sub === "set") {
    if (!CONFIG.TELEGRAM_WEBHOOK_SECRET) {
      console.error("TELEGRAM_WEBHOOK_SECRET is not set — refusing to register an unauthenticated webhook.");
      process.exit(1);
    }
    const dropPending = process.argv.includes("--drop-pending-updates");
    await bot.api.setWebhook(url, {
      secret_token: CONFIG.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: dropPending,
    });
    console.log(`Webhook set: ${url}`);
    if (dropPending) console.log("(pending updates dropped)");
  } else if (sub === "info") {
    const info = await bot.api.getWebhookInfo();
    console.log(JSON.stringify(info, null, 2));
  } else if (sub === "delete") {
    await bot.api.deleteWebhook();
    console.log("Webhook deleted — bot will not receive updates via webhook OR polling until set again / TELEGRAM_TRANSPORT=polling.");
  } else {
    console.error("Usage: npm run telegram-webhook -- <set|info|delete> [--drop-pending-updates]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("telegram-webhook script failed:", err?.message ?? err);
  process.exit(1);
});
