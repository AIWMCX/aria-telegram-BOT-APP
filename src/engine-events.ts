import { pgPool } from "./db-pg.js";

/**
 * REAL-1 blocker #3 — storage for `event_batch` sync payloads. Each
 * batch item becomes its own row (never merged) so an individual paper
 * position-opened/closed/rejected event is independently queryable —
 * this is the data a future Telegram "last event: position marked 1.2s
 * ago" display would read from, though building that display is a
 * separate, later task.
 */

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine events domain is unavailable");
  return pgPool;
}

export interface InboundEngineEvent {
  eventType: string;
  occurredAt: string; // ISO, from the engine's own clock
  // Optional because Zod's z.unknown() (server.ts's SYNC_PAYLOAD_SCHEMA)
  // infers this field as possibly-absent, not just possibly-undefined —
  // `unknown` itself includes `undefined`. Genuinely absent is treated
  // the same as `payload: undefined` by recordEventBatch below.
  payload?: unknown;
}

export async function recordEventBatch(clientId: string, sequence: number, events: readonly InboundEngineEvent[]): Promise<void> {
  if (events.length === 0) return;
  const pool = requirePool();
  // A single multi-row INSERT, not N round trips — batches arrive as a
  // batch specifically to avoid one HTTP call turning into N DB calls.
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
