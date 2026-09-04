/**
 * First-10 beta control (2026-09-04) — the smallest invite/whitelist
 * layer needed to make ARIA a controlled beta rather than open-to-
 * anyone. Per the launch model: FREE PAPER access is for APPROVED
 * users only during this phase, not the public.
 *
 * Redemption is by CODE, not by matching a Telegram username (usernames
 * change and aren't a stable identity) — the owner issues a code via
 * `/invite`, the invitee redeems it via a `/start <code>` deep link,
 * which is what actually binds `user_id` to a real Telegram identity.
 */
exports.up = (pgm) => {
  pgm.createType("invite_status", ["invited", "activated", "paired", "active", "suspended"]);

  pgm.createTable("invites", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    code: { type: "text", notNull: true, unique: true },
    note: { type: "text" },
    status: { type: "invite_status", notNull: true, default: "invited" },
    user_id: { type: "integer", references: "users", onDelete: "SET NULL" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    activated_at: { type: "timestamptz" },
    paired_at: { type: "timestamptz" },
  });

  // A user should only ever redeem one invite — prevents one person
  // stacking multiple codes onto their own account.
  pgm.addConstraint("invites", "invites_one_per_user", {
    unique: ["user_id"],
  });

  pgm.createIndex("invites", "code");
};

exports.down = (pgm) => {
  pgm.dropTable("invites");
  pgm.dropType("invite_status");
};
