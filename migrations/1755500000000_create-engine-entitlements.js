/**
 * REAL-1 Task 3 — control-plane storage for engine entitlements. Schema
 * per docs/superpowers/specs/2026-08-16-real-1-commercial-sniper-beta-design.md
 * §7 (design doc on branch codex/real-1-commercial-sniper-beta-design, not
 * yet merged to main as of this migration — adopted here to keep both
 * agents' work on compatible table names rather than inventing a
 * conflicting one-off `devices` table).
 *
 * This table records that a user HAS an entitlement and its bounds. It
 * does not sign or issue the ARIAE1 token the engine verifies (see
 * aria-engine's src/entitlement.ts) — that signing step is explicitly
 * deferred to a later task. No private key of any kind belongs here.
 */
exports.up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true }); // gen_random_uuid()

  pgm.createType("engine_entitlement_status", ["trial", "active", "expired", "revoked"]);

  pgm.createTable("engine_entitlements", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    product: { type: "text", notNull: true, default: "real-1" },
    status: { type: "engine_entitlement_status", notNull: true, default: "trial" },
    starts_at: { type: "timestamptz" },
    expires_at: { type: "timestamptz" },
    max_paper_buy_lamports: { type: "bigint" },
    max_paper_positions: { type: "integer" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // "unique for product real-1" (design doc wording) — scoped to (user_id,
  // product) rather than user_id alone, so a future second product doesn't
  // require a schema change here.
  pgm.addConstraint("engine_entitlements", "engine_entitlements_one_per_user_product", {
    unique: ["user_id", "product"],
  });
};

exports.down = (pgm) => {
  pgm.dropTable("engine_entitlements");
  pgm.dropType("engine_entitlement_status");
};
