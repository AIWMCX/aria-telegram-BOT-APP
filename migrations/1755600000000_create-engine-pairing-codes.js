/**
 * REAL-1 Task 4 — pairing codes, per the design doc §7 schema. The code
 * itself is never stored — only its SHA-256 hash — matching the existing
 * "bearer credentials are never stored/logged in full" convention
 * (license tokens, entitlement tokens).
 */
exports.up = (pgm) => {
  pgm.createTable("engine_pairing_codes", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    code_hash: { type: "text", notNull: true, unique: true },
    expires_at: { type: "timestamptz", notNull: true },
    consumed_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("engine_pairing_codes", "user_id");
};

exports.down = (pgm) => {
  pgm.dropTable("engine_pairing_codes");
};
