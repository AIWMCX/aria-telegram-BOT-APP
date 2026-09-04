import "./db.js"; // ensure schema runs before anything else touches the DB
import { CONFIG, PAYMENTS_ENABLED, TELEGRAM_WEBHOOK_PATH } from "./config.js";
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

  const botProcessId = randomUUID();
  logger.info({ botProcessId, pid: process.pid, startedAt: new Date().toISOString(), transport: CONFIG.TELEGRAM_TRANSPORT }, "BOT_BOOT");

  if (CONFIG.TELEGRAM_TRANSPORT === "webhook") {
    // 2026-09-04 — canonical production mode. Telegram delivers updates by
    // POSTing to server.ts's /api/telegram/webhook; this process never
    // calls bot.start() (webhookCallback actively makes that throw if
    // something tries to, by design — see grammy's own webhook.js), so
    // there is no polling retry loop here to race, and no getUpdates call
    // for a second instance anywhere to conflict with. See "TELEGRAM BOT
    // CONFLICT INCIDENT" in docs/ARIA_PRODUCT_SCALE_STATE.md for the full
    // history this replaces: a real, unidentified second poller made long
    // polling deliver only ~57% of commands in a measured test.
    await verifyWebhookOnBoot();
  } else {
    // Long-polling retry lifecycle — local dev only. Bot polling failure
    // (bad token, transient Telegram API issue, rate limit) must not take
    // down the HTTP server; retry with backoff instead of exiting.
    //
    // 2026-09-03: the previous version of this loop called bot.start()
    // again after a rejection without an explicit awaited bot.stop()
    // first. A single-attempt, no-retry diagnostic build (tagging every
    // lifecycle log with botProcessId) proved that was never the actual
    // conflict source — a single process, first attempt, still hit a 409
    // ~8s after connecting. This lifecycle fix stands anyway as correct
    // hygiene: only one STARTING transition may be in flight at a time,
    // and every retry explicitly awaits bot.stop() before starting again.
    type BotLifecycleState = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED";
    let botState: BotLifecycleState = "STOPPED";
    let botRetryDelayMs = 5000;
    let attempt = 0;

    const startBot = async (): Promise<void> => {
      if (botState === "STARTING" || botState === "RUNNING") return; // guard: only one STARTING transition at a time
      attempt++;
      botState = "STARTING";
      logger.info({ botProcessId, attempt }, "BOT_POLL_START");
      try {
        await bot.start({
          onStart: (info) => {
            botState = "RUNNING";
            botRetryDelayMs = 5000;
            logger.info({ botProcessId, attempt, username: info.username, id: info.id }, "telegram bot online");
            logger.info(`👉 https://t.me/${info.username}`);
          },
        });
        botState = "STOPPED";
      } catch (err: any) {
        botState = "FAILED";
        logger.error({ botProcessId, attempt, errorCode: err?.error_code ?? err?.code, retryInMs: botRetryDelayMs, err }, "BOT_POLL_FAILED");
        botState = "STOPPING";
        try {
          await bot.stop();
        } catch (stopErr) {
          logger.warn({ botProcessId, stopErr }, "bot.stop() during failure recovery itself threw — continuing to retry anyway");
        }
        botState = "STOPPED";
        setTimeout(() => void startBot(), botRetryDelayMs);
        botRetryDelayMs = Math.min(botRetryDelayMs * 2, 5 * 60 * 1000);
      }
    };
    void startBot();
  }

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "shutting down");
    if (CONFIG.TELEGRAM_TRANSPORT === "polling") await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Startup + periodic (every 10 min) confirmation that Telegram's webhook
 * registration still points at this exact deployment — never resets it
 * automatically (a webhook that's wrong needs a deliberate re-registration
 * via scripts/telegram-webhook.ts, not a silent self-heal that could mask
 * a real misconfiguration). Logs HIGH severity on mismatch rather than
 * ignoring it, per the incident runbook.
 */
async function verifyWebhookOnBoot(): Promise<void> {
  const expectedUrl = `${CONFIG.PUBLIC_URL}${TELEGRAM_WEBHOOK_PATH}`;
  const check = async () => {
    try {
      const info = await bot.api.getWebhookInfo();
      if (info.url === expectedUrl) {
        logger.info({ url: info.url, pendingUpdateCount: info.pending_update_count }, "TELEGRAM_WEBHOOK_OK");
      } else {
        logger.error(
          { expectedUrl, actualUrl: info.url, lastErrorMessage: info.last_error_message },
          "TELEGRAM_WEBHOOK_MISMATCH — production is not the registered webhook destination",
        );
      }
    } catch (err) {
      logger.error({ err }, "getWebhookInfo check failed");
    }
  };
  await check();
  setInterval(() => void check(), 10 * 60 * 1000).unref();
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
