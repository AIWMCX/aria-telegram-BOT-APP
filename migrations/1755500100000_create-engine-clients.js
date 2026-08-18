/**
 * REAL-1 Task 3 — control-plane storage for paired engine clients (the
 * "device" concept from aria-engine's DeviceIdentity contract). Schema per
 * the same design doc §7 as the entitlements migration. `device_public_key`
 * is exactly that — a public key — never a private key or seed phrase.
 * Pairing itself (issuing/consuming a pairing code) is Task 4, not here.
 */
exports.up = (pgm) => {
  pgm.createType("engine_client_status", ["active", "revoked"]);

  pgm.createTable("engine_clients", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    device_public_key: { type: "text", notNull: true, unique: true },
    device_name: { type: "text" },
    platform: { type: "text" },
    engine_version: { type: "text" },
    status: { type: "engine_client_status", notNull: true, default: "active" },
    last_sequence: { type: "bigint", notNull: true, default: 0 },
    last_seen_at: { type: "timestamptz" },
    paired_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    revoked_at: { type: "timestamptz" },
  });

  pgm.createIndex("engine_clients", "user_id");
};

exports.down = (pgm) => {
  pgm.dropTable("engine_clients");
  pgm.dropType("engine_client_status");
};
