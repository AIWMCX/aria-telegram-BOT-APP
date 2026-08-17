/** REAL-1 control-plane records. Secrets are represented only by hashes. */
exports.up = (pgm) => {
  pgm.createType("engine_device_status", ["active", "revoked"]);
  pgm.createType("engine_command_type", ["start_paper", "stop", "update_strategy"]);
  pgm.createType("engine_command_status", ["pending", "acknowledged", "expired"]);

  pgm.createTable("engine_devices", {
    id: { type: "text", primaryKey: true },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    credential_hash: { type: "text", notNull: true, unique: true },
    status: { type: "engine_device_status", notNull: true, default: "active" },
    label: { type: "text", notNull: true, default: "ARIA Engine" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    revoked_at: { type: "timestamptz" },
    last_seen_at: { type: "timestamptz" },
  });
  pgm.createIndex("engine_devices", "user_id");

  pgm.createTable("engine_pairing_codes", {
    id: { type: "text", primaryKey: true },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    code_hash: { type: "text", notNull: true, unique: true },
    expires_at: { type: "timestamptz", notNull: true },
    consumed_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("engine_pairing_codes", ["user_id", "expires_at"]);

  pgm.createTable("engine_commands", {
    id: { type: "text", primaryKey: true },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    device_id: { type: "text", notNull: true, references: "engine_devices", onDelete: "RESTRICT" },
    type: { type: "engine_command_type", notNull: true },
    payload: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    issued_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    status: { type: "engine_command_status", notNull: true, default: "pending" },
    acknowledged_at: { type: "timestamptz" },
  });
  pgm.createIndex("engine_commands", ["device_id", "status", "issued_at"]);

  pgm.createTable("engine_states", {
    device_id: { type: "text", primaryKey: true, references: "engine_devices", onDelete: "RESTRICT" },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    state: { type: "jsonb", notNull: true },
    reported_at: { type: "timestamptz", notNull: true },
  });

  pgm.createTable("engine_events", {
    id: { type: "bigserial", primaryKey: true },
    device_id: { type: "text", notNull: true, references: "engine_devices", onDelete: "RESTRICT" },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    event_id: { type: "text", notNull: true },
    event: { type: "jsonb", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("engine_events", ["device_id", "event_id"], { unique: true });
  pgm.createIndex("engine_events", ["user_id", "occurred_at"]);

  pgm.createTable("engine_request_nonces", {
    device_id: { type: "text", notNull: true, references: "engine_devices", onDelete: "CASCADE" },
    nonce: { type: "text", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("engine_request_nonces", "engine_request_nonces_pk", { primaryKey: ["device_id", "nonce"] });
  pgm.createIndex("engine_request_nonces", "expires_at");
};

exports.down = (pgm) => {
  pgm.dropTable("engine_request_nonces");
  pgm.dropTable("engine_events");
  pgm.dropTable("engine_states");
  pgm.dropTable("engine_commands");
  pgm.dropTable("engine_pairing_codes");
  pgm.dropTable("engine_devices");
  pgm.dropType("engine_command_status");
  pgm.dropType("engine_command_type");
  pgm.dropType("engine_device_status");
};
