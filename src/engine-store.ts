import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { EngineCommand, EngineState, SanitizedEvent, SanitizedHeartbeat } from "../engine/src/contracts.js";
import { pgPool } from "./db-pg.js";

export interface PoolLike { query<T extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>; }
export interface PairingCode { id: string; code: string; expiresAt: Date; }
export interface Device { id: string; userId: number; status: "active" | "revoked"; createdAt: string; lastSeenAt: string | null; }
export interface NewCommand { id: string; type: EngineCommand["type"]; payload?: unknown; issuedAt: string; expiresAt: string; }

function requirePool(pool: PoolLike | null = pgPool): PoolLike {
  if (!pool) throw new Error("DATABASE_URL not configured — engine control storage is unavailable");
  return pool;
}

export function hashCredential(value: string, pepper: string): string {
  return createHash("sha256").update(pepper, "utf8").update("\0", "utf8").update(value, "utf8").digest("hex");
}

export class EngineStore {
  constructor(private readonly pool: PoolLike, private readonly pepper: string) {}

  async createPairingCode(userId: number, expiresAt: Date): Promise<PairingCode> {
    const code = randomBytes(18).toString("base64url");
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO engine_pairing_codes (id, user_id, code_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, userId, hashCredential(code, this.pepper), expiresAt],
    );
    return { id, code, expiresAt };
  }

  async exchangePairingCode(code: string): Promise<{ deviceId: string; credential: string } | null> {
    const credential = randomBytes(32).toString("base64url");
    const deviceId = randomUUID();
    const poolWithConnect = this.pool as Pool & { connect?: () => Promise<PoolClient> };
    let client: PoolLike = this.pool;
    let release: (() => void) | undefined;
    if (poolWithConnect.connect) {
      const poolClient = await poolWithConnect.connect();
      client = poolClient;
      release = () => poolClient.release();
    }
    const transaction = release !== undefined;
    try {
      if (transaction) await client.query("BEGIN");
      const result = await client.query<{ user_id: number }>(
        `SELECT user_id FROM engine_pairing_codes WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashCredential(code, this.pepper)],
      );
      if (result.rows.length === 0) { if (transaction) await client.query("ROLLBACK"); return null; }
      const userId = result.rows[0]!.user_id;
      await client.query(`UPDATE engine_pairing_codes SET consumed_at = now() WHERE code_hash = $1`, [hashCredential(code, this.pepper)]);
      await client.query(
        `INSERT INTO engine_devices (id, user_id, credential_hash) VALUES ($1, $2, $3)`,
        [deviceId, userId, hashCredential(credential, this.pepper)],
      );
      if (transaction) await client.query("COMMIT");
      return { deviceId, credential };
    } catch (error) {
      if (transaction) await client.query("ROLLBACK");
      throw error;
    } finally { release?.(); }
  }

  async getDeviceByCredentialHash(credential: string): Promise<Device | null> {
    const result = await this.pool.query<Device>(
      `SELECT id, user_id AS "userId", status, created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM engine_devices WHERE credential_hash = $1 AND status = 'active'`,
      [hashCredential(credential, this.pepper)],
    );
    return result.rows[0] ?? null;
  }

  async listDevices(userId: number): Promise<Device[]> {
    const result = await this.pool.query<Device>(
      `SELECT id, user_id AS "userId", status, created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM engine_devices WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  async revokeDevice(userId: number, deviceId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE engine_devices SET status = 'revoked', revoked_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active'`, [deviceId, userId]);
    return result.rowCount === 1;
  }

  async appendCommand(userId: number, deviceId: string, command: NewCommand): Promise<void> {
    const result = await this.pool.query(`INSERT INTO engine_commands (id, user_id, device_id, type, payload, issued_at, expires_at) SELECT $1, $2, id, $3, $4::jsonb, $5, $6 FROM engine_devices WHERE id = $7 AND user_id = $2 AND status = 'active'`, [command.id, userId, command.type, JSON.stringify(command.payload ?? null), command.issuedAt, command.expiresAt, deviceId]);
    if (result.rowCount !== 1) throw new Error("device unavailable");
  }

  async readPendingCommands(deviceId: string): Promise<NewCommand[]> {
    const result = await this.pool.query<NewCommand>(`SELECT id, type, payload, issued_at AS "issuedAt", expires_at AS "expiresAt" FROM engine_commands WHERE device_id = $1 AND status = 'pending' AND expires_at > now() ORDER BY issued_at ASC`, [deviceId]);
    return result.rows;
  }

  async recordHeartbeat(deviceId: string, heartbeat: SanitizedHeartbeat): Promise<void> {
    const result = await this.pool.query(`WITH device AS (UPDATE engine_devices SET last_seen_at = now() WHERE id = $1 AND status = 'active' RETURNING id, user_id) INSERT INTO engine_states (device_id, user_id, state, reported_at) SELECT id, user_id, $2::jsonb, now() FROM device ON CONFLICT (device_id) DO UPDATE SET state = excluded.state, reported_at = excluded.reported_at`, [deviceId, JSON.stringify(heartbeat.state)]);
    if (result.rowCount !== 1) throw new Error("device unavailable");
  }

  async appendEngineEvents(deviceId: string, events: SanitizedEvent[]): Promise<void> {
    if (events.length > 100) throw new Error("event batch too large");
    for (const event of events) await this.pool.query(`INSERT INTO engine_events (device_id, user_id, event_id, event, occurred_at) SELECT id, user_id, $2, $3::jsonb, $4 FROM engine_devices WHERE id = $1 AND status = 'active' ON CONFLICT (device_id, event_id) DO NOTHING`, [deviceId, event.id, JSON.stringify(event), event.occurredAt]);
  }

  async consumeNonce(deviceId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO engine_request_nonces (device_id, nonce, expires_at) VALUES ($1, $2, $3) ON CONFLICT (device_id, nonce) DO NOTHING`, [deviceId, nonce, expiresAt]);
    return result.rowCount === 1;
  }

  async readDashboardState(userId: number): Promise<{ state: EngineState; events: SanitizedEvent[] } | null> {
    const state = await this.pool.query<{ state: EngineState }>(`SELECT state FROM engine_states WHERE user_id = $1 ORDER BY reported_at DESC LIMIT 1`, [userId]);
    if (state.rows.length === 0) return null;
    const events = await this.pool.query<SanitizedEvent>(`SELECT event FROM engine_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 100`, [userId]);
    return { state: state.rows[0]!.state, events: events.rows.map((row: any) => row.event) };
  }
}

export const engineStore = pgPool && process.env.ARIA_ENGINE_CREDENTIAL_PEPPER
  ? new EngineStore(pgPool, process.env.ARIA_ENGINE_CREDENTIAL_PEPPER)
  : null;
