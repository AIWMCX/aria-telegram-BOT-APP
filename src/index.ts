import "./db.js"; // ensure schema runs before anything else touches the DB
import { CONFIG, PAYMENTS_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { bot } from "./bot.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  logger.info(
    { node: process.version, publicUrl: CONFIG.PUBLIC_URL, paymentsEnabled: PAYMENTS_ENABLED },
    "ARIA backend starting",
  );
  if (!PAYMENTS_ENABLED) {
    logger.warn("Stripe not configured — trial tier works, paid checkout is disabled until STRIPE_* vars are set");
  }

  startServer();

  // Bot polling failure (bad token, transient Telegram API issue, rate limit)
  // must not take down the HTTP server — license issuance, health checks,
  // and Stripe webhooks are independent of whether the bot is connected.
  // Retry with backoff instead of exiting the whole process.
  let botRetryDelayMs = 5000;
  const startBot = () => {
    bot.start({
      onStart: (info) => {
        botRetryDelayMs = 5000;
        logger.info({ username: info.username, id: info.id }, "telegram bot online");
        logger.info(`👉 https://t.me/${info.username}`);
      },
    }).catch((err) => {
      logger.error({ err, retryInMs: botRetryDelayMs }, "telegram bot failed to start — HTTP server stays up, retrying");
      setTimeout(startBot, botRetryDelayMs);
      botRetryDelayMs = Math.min(botRetryDelayMs * 2, 5 * 60 * 1000);
    });
  };
  startBot();

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "shutting down");
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
