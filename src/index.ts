import "./db.js"; // ensure schema runs before anything else touches the DB
import { CONFIG, PAYMENTS_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { bot } from "./bot.js";
import { startServer } from "./server.js";
import "./engine-customer-routes.js"; // registers Telegram-owned REAL-1 preview routes on the shared Hono app
import { runPgMigrations } from "./migrate.js";
import { runLedgerSelfTest } from "./ledger-selftest.js";
import { runEngineControlSelfTest } from "./engine-control-selftest.js";
import { runEngineAuthSelfTest } from "./engine-auth-selftest.js";
import { runEngineSyncSelfTest } from "./engine-sync-selftest.js";
import { runSyncDesyncRepro } from "./engine-sync-desync-repro.js";
import { startExpiryWarningScheduler } from "./expiry-warnings.js";

async function main(): Promise<void> {
  logger.info(
    { node: process.version, publicUrl: CONFIG.PUBLIC_URL, paymentsEnabled: PAYMENTS_ENABLED },
    "ARIA backend starting",
  );
  if (!PAYMENTS_ENABLED) {
    logger.warn("Stripe not configured — trial tier works, paid checkout is disabled until STRIPE_* vars are set");
  }

  // Funded-account domain (users/wallet_accounts/ledger, see
  // docs/ARIA_FUNDS_ARCHITECTURE_V1.md) — a migration failure here must not
  // be silently swallowed, but it also must not be allowed to take down the
  // still-live license product if Postgres is ever briefly unreachable.
  try {
    await runPgMigrations();
  } catch (err) {
    logger.error({ err }, "Postgres migration failed — funded-account domain unavailable, license product unaffected");
  }

  if (CONFIG.RUN_LEDGER_SELFTEST) {
    try {
      await runLedgerSelfTest();
    } catch (err) {
      logger.error({ err }, "ledger selftest crashed outside its own try/catch — this itself is a finding");
    }
  }

  if (CONFIG.RUN_ENGINE_CONTROL_SELFTEST) {
    try {
      await runEngineControlSelfTest();
    } catch (err) {
      logger.error({ err }, "engine control selftest crashed outside its own try/catch — this itself is a finding");
    }
  }

  if (CONFIG.RUN_ENGINE_AUTH_SELFTEST) {
    try {
      await runEngineAuthSelfTest();
    } catch (err) {
      logger.error({ err }, "engine auth selftest crashed outside its own try/catch — this itself is a finding");
    }
  }

  if (CONFIG.RUN_ENGINE_SYNC_SELFTEST) {
    try {
      await runEngineSyncSelfTest();
    } catch (err) {
      logger.error({ err }, "engine sync selftest crashed outside its own try/catch — this itself is a finding");
    }
  }

  if (CONFIG.RUN_SYNC_DESYNC_REPRO) {
    try {
      await runSyncDesyncRepro();
    } catch (err) {
      logger.error({ err }, "sync-desync-repro crashed outside its own try/catch — this itself is a finding");
    }
  }

  startServer();

  // License-expiry warning DMs (7 days / 1 day out) — a real ongoing
  // product feature, not a one-shot selftest, so it always runs (no
  // RUN_*_SELFTEST-style opt-in flag) once the server itself is up.
  try {
    startExpiryWarningScheduler();
  } catch (err) {
    logger.error({ err }, "expiry warning scheduler failed to start — license issuance/checkout unaffected");
  }

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
