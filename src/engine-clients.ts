import { pgPool } from "./db-pg.js";

/**
 * REAL-1 Task 3 — storage primitives for paired engine clients. Pairing
 * itself (the handshake that produces a `device_public_key` this table can
 * register) is Task 4 — this module is pure bookkeeping, called by that
 * later flow, not a pairing implementation itself.
 *
 * `device_public_key` is exactly that: a public key. This module never
 * touches, stores, or accepts a private key, seed phrase, or any other
 * signing credential.
 */
export type EngineClientStatus = "active" | "revoked";

export interface EngineClient {
  id: string; // uuid
  user_id: number;
  device_public_key: string;
  device_name: string | null;
  platform: string | null;
  engine_version: string | null;
  status: EngineClientStatus;
  last_sequence: string; // bigint surfaces as string via pg
  last_seen_at: string | null;
  paired_at: string;
  revoked_at: string | null;
  offline_notified_at: string | null;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine clients domain is unavailable");
  return pgPool;
}

/** Creates a new paired client. The caller already authenticated the one-time pairing code. */
export async function registerClient(input: {
  userId: number;
  devicePublicKey: string;
  deviceName?: string;
  platform?: string;
  engineVersion?: string;
}): Promise<EngineClient> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineClient>(
    `INSERT INTO engine_clients (user_id, device_public_key, device_name, platform, engine_version)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.userId, input.devicePublicKey, input.deviceName ?? null, input.platform ?? null, input.engineVersion ?? null],
  );
  return rows[0]!;
}

export async function getClientByPublicKey(devicePublicKey: string): Promise<EngineClient | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineClient>(
    `SELECT * FROM engine_clients WHERE device_public_key = $1`,
    [devicePublicKey],
  );
  return rows[0];
}

export async function getClientById(id: string): Promise<EngineClient | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineClient>(`SELECT * FROM engine_clients WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Returns the customer's most recently active paired device. Customer-facing
 * API routes use this instead of accepting a clientId from the browser, so
 * ownership is always derived from verified Telegram identity.
 */
export async function getLatestActiveClientForUser(userId: number): Promise<EngineClient | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineClient>(
    `SELECT * FROM engine_clients
     WHERE user_id = $1 AND status = 'active'
     ORDER BY COALESCE(last_seen_at, paired_at) DESC, paired_at DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0];
}

/**
 * The replay-defense primitive: advances last_sequence ONLY if the new
 * value is strictly greater than the current one, as a single atomic
 * UPDATE — the WHERE clause and the write happen in one statement, so
 * under real concurrent connections racing on the same row, Postgres's
 * row-level locking serializes them and exactly one can win for any given
 * target sequence. Returns true if THIS call advanced it (i.e. this
 * request is genuinely new), false if it didn't (stale/replayed/lost the
 * race — the caller must reject the request, not retry with the same
 * sequence).
 */
export async function atomicAdvanceSequence(id: string, newSequence: bigint): Promise<boolean> {
  const pool = requirePool();
  // offline_notified_at resets on every real sync — a device that comes
  // back online can trigger a fresh offline alert the next time it goes
  // quiet, rather than staying permanently "already notified" forever.
  const { rowCount } = await pool.query(
    `UPDATE engine_clients SET last_sequence = $2, last_seen_at = now(), offline_notified_at = NULL WHERE id = $1 AND last_sequence < $2`,
    [id, newSequence.toString()],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Finds active clients that have gone quiet for longer than the given
 * threshold and haven't already been notified for this offline streak.
 * Deliberately a much longer threshold than the Mini App's own 45s
 * "online" freshness gate — that's for an at-a-glance status check, this
 * is for a real DM interrupting the user, which should only fire for a
 * genuinely sustained outage, not a routine few-second gap between syncs.
 */
export async function findClientsNewlyOffline(thresholdMinutes: number): Promise<EngineClient[]> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineClient>(
    `SELECT * FROM engine_clients
     WHERE status = 'active'
       AND offline_notified_at IS NULL
       AND last_seen_at IS NOT NULL
       AND last_seen_at < now() - ($1 || ' minutes')::interval`,
    [thresholdMinutes],
  );
  return rows;
}

export async function markOfflineNotified(id: string): Promise<void> {
  const pool = requirePool();
  await pool.query(`UPDATE engine_clients SET offline_notified_at = now() WHERE id = $1`, [id]);
}

export async function listClientsForUser(userId: number): Promise<EngineClient[]> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineClient>(
    `SELECT * FROM engine_clients WHERE user_id = $1 ORDER BY paired_at ASC`,
    [userId],
  );
  return rows;
}

export async function revokeClient(id: string): Promise<void> {
  const pool = requirePool();
  await pool.query(
    `UPDATE engine_clients SET status = 'revoked', revoked_at = now() WHERE id = $1`,
    [id],
  );
}
