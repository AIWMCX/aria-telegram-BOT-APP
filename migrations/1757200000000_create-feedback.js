/**
 * Session B item — feedback capture (2026-09-06). First-10 beta needs a
 * direct line from the Mini App to the operator that isn't "hope they
 * DM /support." One table, one authenticated write path, no threading
 * or status workflow — that's a real feature to build later if volume
 * ever justifies it, not before.
 */
exports.up = (pgm) => {
  pgm.createTable("feedback", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", references: "users", onDelete: "SET NULL" },
    message: { type: "text", notNull: true },
    submitted_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("feedback", "submitted_at");
};

exports.down = (pgm) => {
  pgm.dropTable("feedback");
};
