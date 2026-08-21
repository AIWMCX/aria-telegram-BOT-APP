import { pgPool } from "./db-pg.js";

/**
 * REAL-1 blocker #3 — storage for `event_batch` sync payloads. Each
 * batch item becomes its own row (never merged) so an individual paper
 * position-opened/closed/rejected event is independently queryable.
 */

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine events domain is unavailable");
  return pgPool;
}

export interface InboundEngineEvent {
  eventType: string;
  occurredAt: string; // ISO, from the engine's own clock
  // Optional because Zod's z.unknown() (server.ts's SYNC_PAYLOAD_SCHEMA)
  // infers this field as possibly-absent, not just possibly-undefined.
  payload?: unknown;
}

export interface StoredEngineEvent {
  id: string;
  client_id: string;
  sequence: string;
  event_type: string;
  payload: unknown;
  occurred_at: string;
  received_at: string;
}

export async function recordEventBatch(clientId: string, sequence: number, events: readonly InboundEngineEvent[]): Promise<void> {
  if (events.length === 0) return;
  const pool = requirePool();
  const values: string[] = [];
  const params: unknown[] = [];
  events.forEach((event, i) => {
    const base = i * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(clientId, sequence.toString(), event.eventType, JSON.stringify(event.payload), event.occurredAt);
  });
  await pool.query(
    `INSERT INTO engine_events (client_id, sequence, event_type, payload, occurred_at) VALUES ${values.join(", ")}`,
    params,
  );
}

/** Customer preview uses a small, bounded tail of the caller's own device events. */
export async function getRecentEvents(clientId: string, limit = 20): Promise<StoredEngineEvent[]> {
  const pool = requirePool();
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const { rows } = await pool.query<StoredEngineEvent>(
    `SELECT * FROM engine_events WHERE client_id = $1 ORDER BY occurred_at DESC, received_at DESC LIMIT $2`,
    [clientId, boundedLimit],
  );
  return rows;
}
