import { pgPool } from "./db-pg.js";
import { CONFIG } from "./config.js";

/**
 * Postgres health state for /healthz (liveness, informational) and /readyz
 * (readiness, gating). See src/server.ts.
 *
 * Why this exists: the boot-time migration failure is deliberately non-fatal
 * (the license product must survive a Postgres blip), so without this the
 * service reported `ok:true` while every engine pairing/account/sync route
 * answered 503.
 *
 * Nothing here may ever expose the connection string, host, user, or raw
 * error text (pg error messages can embed connection details). The only
 * output is the fixed-shape block below.
 */
export type MigrationStatus = "up-to-date" | "failed" | "unknown" | "skipped";

export interface PostgresHealth {
  configured: boolean;
  ready: boolean;
  migrations: MigrationStatus;
}

const PROBE_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 5000;

let migrationOutcome: "up-to-date" | "failed" | "unknown" = "unknown";

/** Recorded by runPgMigrations() at boot. */
export function setMigrationOutcome(outcome: "up-to-date" | "failed"): void {
  migrationOutcome = outcome;
}

export function getMigrationStatus(): MigrationStatus {
  if (!CONFIG.DATABASE_URL) return "skipped";
  return migrationOutcome;
}

let cache: { at: number; ok: boolean } | null = null;
let inflight: Promise<boolean> | null = null;

/** Test hook: forget cached probe + recorded migration outcome. */
export function resetPgHealthStateForTests(): void {
  cache = null;
  inflight = null;
  migrationOutcome = "unknown";
}

async function probe(): Promise<boolean> {
  if (!pgPool) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pgPool.query("SELECT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false; // error detail intentionally discarded (may contain credentials)
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cheap `SELECT 1`, cached ~5s and de-duplicated so polling cannot hammer the DB. */
async function probeCached(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.ok;
  if (!inflight) {
    inflight = probe()
      .then((ok) => {
        cache = { at: Date.now(), ok };
        return ok;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getPostgresHealth(): Promise<PostgresHealth> {
  const configured = Boolean(CONFIG.DATABASE_URL);
  return {
    configured,
    ready: configured ? await probeCached() : false,
    migrations: getMigrationStatus(),
  };
}
