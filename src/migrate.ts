import { runner } from "node-pg-migrate";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { setMigrationOutcome } from "./pg-health.js";

/**
 * Runs Postgres migrations (migrations/*.js) on boot. Idempotent —
 * node-pg-migrate tracks applied migrations in its own `pgmigrations`
 * table, so this is safe to call on every startup. No-op when
 * DATABASE_URL isn't set (local dev without Postgres, CI, and the
 * license product's own test suite never touch this).
 */
export async function runPgMigrations(): Promise<void> {
  if (!CONFIG.DATABASE_URL) {
    logger.info("DATABASE_URL not set — skipping Postgres migrations (funded-account domain inactive)");
    return;
  }
  try {
    await runner({
      databaseUrl: CONFIG.DATABASE_URL,
      dir: "migrations",
      direction: "up",
      migrationsTable: "pgmigrations",
      log: (msg: string) => logger.info({ src: "pg-migrate" }, msg),
    });
  } catch (err) {
    setMigrationOutcome("failed"); // surfaced via /healthz + /readyz (src/pg-health.ts)
    throw err;
  }
  setMigrationOutcome("up-to-date");
  logger.info("Postgres migrations up to date");
}
