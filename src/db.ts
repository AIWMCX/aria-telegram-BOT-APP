import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";

const dir = path.dirname(CONFIG.DB_PATH);
if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// Using Node's built-in node:sqlite (stable as of Node 22.5+/24) instead of
// better-sqlite3 — same synchronous prepare/run/get/all API, zero native
// build step. Avoids requiring a C++ toolchain (Visual Studio Build Tools
// on Windows) just to install dependencies.
export const db = new DatabaseSync(CONFIG.DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id      INTEGER NOT NULL,
    tg_username     TEXT,
    tg_first_name   TEXT,
    tg_last_name    TEXT,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL,
    wallet          TEXT NOT NULL,
    interest        TEXT,
    source          TEXT DEFAULT 'mini_app',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tg_user_id, email)
  );
  CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
  CREATE INDEX IF NOT EXISTS idx_leads_tg    ON leads(tg_user_id);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);

  CREATE TABLE IF NOT EXISTS orders (
    id              TEXT PRIMARY KEY,
    lead_id         INTEGER NOT NULL REFERENCES leads(id),
    tier            TEXT NOT NULL CHECK(tier IN ('standard','pro')),
    amount_usd      REAL NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    method          TEXT NOT NULL DEFAULT 'stripe',
    external_ref    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','refunded')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_lead ON orders(lead_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(external_ref);

  CREATE TABLE IF NOT EXISTS licenses (
    id              TEXT PRIMARY KEY,
    lead_id         INTEGER NOT NULL REFERENCES leads(id),
    order_id        TEXT REFERENCES orders(id),
    tier            TEXT NOT NULL,
    wallet          TEXT NOT NULL,
    token           TEXT NOT NULL,
    issued_at       TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL,
    revoked         INTEGER NOT NULL DEFAULT 0,
    revoked_at      TEXT,
    revoked_reason  TEXT,
    warned_7d       INTEGER NOT NULL DEFAULT 0,
    warned_1d       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_licenses_lead ON licenses(lead_id);
  CREATE INDEX IF NOT EXISTS idx_licenses_wallet ON licenses(wallet);
  CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);

  CREATE TABLE IF NOT EXISTS subscriptions (
    id                    TEXT PRIMARY KEY,
    lead_id               INTEGER NOT NULL REFERENCES leads(id),
    tier                  TEXT NOT NULL,
    stripe_sub_id         TEXT UNIQUE,
    stripe_customer_id    TEXT,
    status                TEXT NOT NULL,
    current_period_end    TEXT NOT NULL,
    cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_subs_lead ON subscriptions(lead_id);
  CREATE INDEX IF NOT EXISTS idx_subs_stripe ON subscriptions(stripe_sub_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT NOT NULL DEFAULT (datetime('now')),
    actor           TEXT NOT NULL,
    event           TEXT NOT NULL,
    entity_type     TEXT,
    entity_id       TEXT,
    metadata        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
`);

// `CREATE TABLE IF NOT EXISTS` above only defines the shape for a BRAND NEW
// database file — it does nothing to an already-deployed licenses table
// (e.g. Railway's persisted volume) that predates warned_7d/warned_1d.
// There is no migration framework for SQLite in this repo (unlike
// migrate.ts's Postgres migrations for the funded-account domain), so this
// is a defensive, idempotent ADD COLUMN guarded by an explicit existence
// check rather than relying on SQLite version support for
// `ADD COLUMN IF NOT EXISTS` (added in 3.35.0, but not worth depending on).
function ensureColumn(table: string, column: string, columnDdl: string): void {
  const existing = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>;
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
    logger.info({ table, column }, "schema migration: added column");
  }
}
ensureColumn("licenses", "warned_7d", "warned_7d INTEGER NOT NULL DEFAULT 0");
ensureColumn("licenses", "warned_1d", "warned_1d INTEGER NOT NULL DEFAULT 0");

logger.info({ path: CONFIG.DB_PATH }, "database ready — 5 tables (leads, orders, licenses, subscriptions, audit_log)");
