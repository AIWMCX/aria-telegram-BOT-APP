import { pgPool } from "./db-pg.js";

/**
 * REAL-1 blocker #3 — the cloud->engine command queue. A command is
 * enqueued here (e.g. by a future Telegram control button — not built
 * yet, that's a separate later task) and delivered to the engine as
 * `pendingCommands` in its next sync response; the engine reports back
 * via a `command_ack` sync payload, which calls ackCommand() below.
 *
 * Status only ever moves FORWARD: pending -> acknowledged ->
 * completed|failed, or pending -> expired (lazily, on query, once past
 * expires_at — no cron job). ackCommand() enforces this ordering itself
 * so a stale/duplicate/out-of-order ack can never regress a command's
 * state — that's the actual idempotency guarantee, not just "doesn't
 * throw on a repeat call."
 */
export type EngineCommandType = "paper_start" | "paper_pause" | "paper_stop" | "refresh_entitlement" | "request_snapshot";
export type EngineCommandStatus = "pending" | "acknowledged" | "completed" | "failed" | "expired";

export interface EngineCommand {
  id: string;
  client_id: string;
  type: EngineCommandType;
  payload: unknown;
  expected_state: string | null;
  status: EngineCommandStatus;
  issued_at: string;
  expires_at: string;
  acknowledged_at: string | null;
  completed_at: string | null;
  detail: string | null;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine commands domain is unavailable");
  return pgPool;
}

const STATUS_RANK: Record<EngineCommandStatus, number> = { pending: 0, acknowledged: 1, completed: 2, failed: 2, expired: 2 };

export async function enqueueCommand(input: {
  clientId: string;
  type: EngineCommandType;
  payload?: unknown;
  expectedState?: string;
  ttlSeconds: number;
}): Promise<EngineCommand> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineCommand>(
    `INSERT INTO engine_commands (client_id, type, payload, expected_state, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING *`,
    [input.clientId, input.type, input.payload ? JSON.stringify(input.payload) : null, input.expectedState ?? null, input.ttlSeconds],
  );
  return rows[0]!;
}

/** Lazily expires anything past its expires_at THEN returns whatever is still genuinely pending — no background job needed for this to stay correct. */
export async function getPendingCommands(clientId: string): Promise<EngineCommand[]> {
  const pool = requirePool();
  await pool.query(
    `UPDATE engine_commands SET status = 'expired' WHERE client_id = $1 AND status = 'pending' AND expires_at < now()`,
    [clientId],
  );
  const { rows } = await pool.query<EngineCommand>(
    `SELECT * FROM engine_commands WHERE client_id = $1 AND status = 'pending' ORDER BY issued_at ASC`,
    [clientId],
  );
  return rows;
}

/**
 * Scoped by BOTH command id and client id — a client can only ever ack
 * its OWN commands, never guess another client's command_id and affect
 * it (cross-user isolation, enforced here, not just at the HTTP auth
 * layer, as defense in depth).
 */
export async function ackCommand(commandId: string, clientId: string, status: Exclude<EngineCommandStatus, "pending" | "expired">, detail?: string): Promise<{ applied: boolean; reason?: string }> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineCommand>(`SELECT * FROM engine_commands WHERE id = $1 AND client_id = $2`, [commandId, clientId]);
  const existing = rows[0];
  if (!existing) return { applied: false, reason: "unknown command_id for this client" };

  if (STATUS_RANK[status] < STATUS_RANK[existing.status]) {
    // Out-of-order/duplicate ack arriving after a later one already landed — accepted as a no-op, not an error, and not applied.
    return { applied: false, reason: `command is already ${existing.status}, refusing to regress to ${status}` };
  }

  // $3 is cast explicitly — used both as the status column assignment
  // (engine_command_status enum) and inside the CASE comparison, and
  // Postgres's parameter-type inference can't reconcile those two
  // contexts on its own ("inconsistent types deduced for parameter $3",
  // caught by engine-sync-selftest.ts's real-Postgres run). Casting once
  // resolves it for both usages.
  await pool.query(
    `UPDATE engine_commands SET status = $3::engine_command_status, detail = $4,
       acknowledged_at = COALESCE(acknowledged_at, now()),
       completed_at = CASE WHEN $3::engine_command_status IN ('completed','failed') THEN now() ELSE completed_at END
     WHERE id = $1 AND client_id = $2`,
    [commandId, clientId, status, detail ?? null],
  );
  return { applied: true };
}
