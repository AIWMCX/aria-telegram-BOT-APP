import { pgPool } from "./db-pg.js";

/**
 * REAL-1 blocker #3 — storage for `snapshot` sync payloads. Append-only:
 * every sync writes a new row, "current" is a query (most recent by
 * created_at), never a mutated one. `payload` is opaque jsonb from this
 * module's point of view — the engine's PaperAccountSnapshot shape,
 * passed through unvalidated beyond "is it an object" at the HTTP layer
 * (server.ts's Zod schema), not re-interpreted here.
 */

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine snapshots domain is unavailable");
  return pgPool;
}

export async function recordSnapshot(clientId: string, sequence: number, payload: unknown): Promise<void> {
  const pool = requirePool();
  await pool.query(
    `INSERT INTO engine_snapshots (client_id, sequence, payload) VALUES ($1, $2, $3)`,
    [clientId, sequence.toString(), JSON.stringify(payload)],
  );
}

export interface StoredSnapshot {
  id: string;
  client_id: string;
  sequence: string;
  payload: unknown;
  created_at: string;
}

export async function getLatestSnapshot(clientId: string): Promise<StoredSnapshot | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<StoredSnapshot>(
    `SELECT * FROM engine_snapshots WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [clientId],
  );
  return rows[0];
}
