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
import { randomUUID } from "node:crypto";

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
  // DIAGNOSTIC (2026-09-03, single deploy, revert after the test — see
  // docs/ARIA_PRODUCT_SCALE_STATE.md "TELEGRAM BOT CONFLICT INCIDENT"):
  // isolating whether the persistent 409 conflict is a second external
  // poller, or this process's own retry loop starting bot.start() again
  // without an explicit awaited bot.stop() first, possibly racing grammY's
  // own in-flight polling state from the previous attempt. Starts the bot
  // EXACTLY ONCE — no retry — and tags every lifecycle log with a random
  // per-process ID so overlapping conflicts can be attributed to either
  // one process (self-conflict) or two+ distinct processes (external).
  const botProcessId = randomUUID();
  logger.info({ botProcessId, pid: process.pid, startedAt: new Date().toISOString() }, "BOT_BOOT");
  logger.info({ botProcessId, attempt: 1 }, "BOT_POLL_START");
  bot.start({
    onStart: (info) => {
      logger.info({ botProcessId, username: info.username, id: info.id }, "telegram bot online");
      logger.info(`👉 https://t.me/${info.username}`);
    },
  }).catch((err) => {
    logger.error({ botProcessId, attempt: 1, errorCode: err?.error_code ?? err?.code, err }, "BOT_POLL_FAILED — diagnostic mode, NOT retrying in this process");
  });

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
