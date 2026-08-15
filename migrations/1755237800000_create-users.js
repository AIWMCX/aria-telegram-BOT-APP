/**
 * FREE-0/FREE-1 — the real `users` identity table, per
 * docs/ARIA_FUNDS_ARCHITECTURE_V1.md §3a. Additive: does not touch or
 * replace the existing SQLite `leads` table used by the license product.
 */
exports.up = (pgm) => {
  pgm.createType("account_status", ["active", "disabled"]);

  pgm.createTable("users", {
    id: "id",
    telegram_user_id: { type: "bigint", notNull: true, unique: true },
    telegram_username: { type: "text" },
    first_name: { type: "text" },
    last_name: { type: "text" },
    account_status: { type: "account_status", notNull: true, default: "active" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_seen_at: { type: "timestamptz" },
  });

  pgm.createIndex("users", "telegram_user_id");
};

exports.down = (pgm) => {
  pgm.dropTable("users");
  pgm.dropType("account_status");
};
