import { pgPool } from "./db-pg.js";

/**
 * The real ARIA identity — per docs/ARIA_FUNDS_ARCHITECTURE_V1.md §3a.
 * Keyed on telegram_user_id alone, unlike the license product's `leads`
 * table (keyed on tg_user_id + email, which is what caused the duplicate-
 * license bug fixed earlier). No endpoint in server.ts calls this yet —
 * this module exists so the users table can be exercised and tested before
 * any account/wallet/ledger endpoint depends on it.
 */
export interface User {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  first_name: string | null;
  last_name: string | null;
  account_status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export interface TelegramIdentity {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — Postgres users domain is unavailable");
  return pgPool;
}

/** Creates the user on first sight, or updates last_seen_at + profile fields on return. */
export async function upsertUserFromTelegram(identity: TelegramIdentity): Promise<User> {
  const pool = requirePool();
  const { rows } = await pool.query<User>(
    `INSERT INTO users (telegram_user_id, telegram_username, first_name, last_name, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       telegram_username = excluded.telegram_username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       last_seen_at = now(),
       updated_at = now()
     RETURNING *`,
    [identity.id, identity.username ?? null, identity.first_name ?? null, identity.last_name ?? null],
  );
  return rows[0]!;
}

export async function getUserByTelegramId(telegramUserId: number): Promise<User | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<User>(`SELECT * FROM users WHERE telegram_user_id = $1`, [telegramUserId]);
  return rows[0];
}
