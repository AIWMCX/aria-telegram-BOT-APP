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
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine clients domain is unavailable");
  return pgPool;
}

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

export async function listClientsForUser(userId: number): Promise<EngineClient[]> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineClient>(
    `SELECT * FROM engine_clients WHERE user_id = $1 ORDER BY paired_at ASC`,
    [userId],
  );
  return rows;
}

export async function touchLastSeen(id: string, sequence: bigint): Promise<void> {
  const pool = requirePool();
  await pool.query(
    `UPDATE engine_clients SET last_seen_at = now(), last_sequence = $2 WHERE id = $1`,
    [id, sequence.toString()],
  );
}

export async function revokeClient(id: string): Promise<void> {
  const pool = requirePool();
  await pool.query(
    `UPDATE engine_clients SET status = 'revoked', revoked_at = now() WHERE id = $1`,
    [id],
  );
}
