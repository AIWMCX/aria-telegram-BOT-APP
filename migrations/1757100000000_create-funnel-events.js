/**
 * First-10 beta funnel telemetry (2026-09-06) — "you need this before 10
 * users" from the productization proposal. Smallest possible shape: one
 * append-only table, one event name, an optional user reference (null
 * before a Telegram identity exists yet — e.g. invite_created), optional
 * metadata for anything event-specific.
 *
 * Deliberately NOT a general analytics platform — no session replay, no
 * funnel-visualization UI beyond a simple count query. Just enough to
 * answer "where are users actually dropping off" instead of guessing.
 */
exports.up = (pgm) => {
  pgm.createTable("funnel_events", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    event: { type: "text", notNull: true },
    user_id: { type: "integer", references: "users", onDelete: "SET NULL" },
    metadata: { type: "jsonb" },
    occurred_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("funnel_events", "event");
  pgm.createIndex("funnel_events", "user_id");
  pgm.createIndex("funnel_events", "occurred_at");
};

exports.down = (pgm) => {
  pgm.dropTable("funnel_events");
};
