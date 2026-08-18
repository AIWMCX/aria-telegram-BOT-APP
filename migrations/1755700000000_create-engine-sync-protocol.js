/**
 * REAL-1 blocker #3 — the storage this repo's own /api/engine/sync
 * docblock explicitly deferred: "No meaningful payload semantics exist
 * yet (that's Task 7/8's sync protocol, per the design doc's
 * engine_snapshots/engine_events/engine_commands)". This is that.
 *
 * engine_snapshots / engine_events are append-only (never updated) —
 * "most recent" is a query (ORDER BY created_at DESC LIMIT 1), not a
 * mutated row, so a full history survives for debugging/audit. No
 * retention/cleanup job exists yet; that's a deliberate, documented
 * later concern, not an oversight.
 *
 * engine_commands is the cloud->engine command queue. Status starts
 * 'pending', moves to 'acknowledged' then 'completed' (or 'failed') as
 * the engine reports back via a command_ack sync payload, or to
 * 'expired' lazily when queried past expires_at (no cron needed).
 */
exports.up = (pgm) => {
  pgm.createTable("engine_snapshots", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    client_id: { type: "uuid", notNull: true, references: "engine_clients", onDelete: "CASCADE" },
    sequence: { type: "bigint", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("engine_snapshots", ["client_id", "created_at"]);

  pgm.createTable("engine_events", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    client_id: { type: "uuid", notNull: true, references: "engine_clients", onDelete: "CASCADE" },
    sequence: { type: "bigint", notNull: true },
    event_type: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("engine_events", ["client_id", "received_at"]);

  pgm.createType("engine_command_type", ["paper_start", "paper_pause", "paper_stop", "refresh_entitlement", "request_snapshot"]);
  pgm.createType("engine_command_status", ["pending", "acknowledged", "completed", "failed", "expired"]);

  pgm.createTable("engine_commands", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    client_id: { type: "uuid", notNull: true, references: "engine_clients", onDelete: "CASCADE" },
    type: { type: "engine_command_type", notNull: true },
    payload: { type: "jsonb" },
    expected_state: { type: "text" },
    status: { type: "engine_command_status", notNull: true, default: "pending" },
    issued_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    expires_at: { type: "timestamptz", notNull: true },
    acknowledged_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    detail: { type: "text" },
  });
  pgm.createIndex("engine_commands", ["client_id", "status"]);
};

exports.down = (pgm) => {
  pgm.dropTable("engine_commands");
  pgm.dropType("engine_command_status");
  pgm.dropType("engine_command_type");
  pgm.dropTable("engine_events");
  pgm.dropTable("engine_snapshots");
};
