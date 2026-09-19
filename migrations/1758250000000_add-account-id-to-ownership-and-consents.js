/**
 * LIVE Vertical Slice 0.1 — Milestone 1 follow-up (post-review fix, D4/D5).
 *
 * Spec §2.4 describes the ownership-proof nonce as "single-use, bound to
 * `account_id`", and spec §3 describes `live_consents` as recording
 * `(user_id, account_id, consent_version, accepted_at, text_sha256,
 * initdata_telegram_user_id, user_agent)`. The original
 * 1758240000000_create-trading-accounts.js migration created both tables
 * with only `user_id` — a user can, in principle, hold more than one
 * `trading_accounts` row over time (a STOPPED account is terminal and a
 * fresh row is created to resume, per spec §2.1), so binding ownership
 * proofs and consents to `user_id` alone is looser than the spec's binding
 * and does not by itself prevent a proof or consent recorded against one
 * trading relationship from being read as if it applied to another.
 *
 * This is a NEW migration rather than an edit to the already-applied
 * 1758240000000 migration, per this repo's standing rule that an applied
 * migration is never rewritten in place.
 *
 * Both tables have zero production rows as of this migration (LIVE 0.1 is
 * not wired to any live surface yet — see the Milestone 1 ledger's
 * "Explicitly NOT built" section), so both columns can be added NOT NULL
 * directly with no backfill step.
 */

exports.up = (pgm) => {
  pgm.addColumn("wallet_ownership_proofs", {
    account_id: { type: "uuid", notNull: true, references: "trading_accounts", onDelete: "RESTRICT" },
  });
  pgm.createIndex("wallet_ownership_proofs", ["account_id", "verified_at"]);

  pgm.addColumn("live_consents", {
    account_id: { type: "uuid", notNull: true, references: "trading_accounts", onDelete: "RESTRICT" },
  });
  pgm.createIndex("live_consents", ["account_id", "consent_version"]);
};

exports.down = (pgm) => {
  pgm.dropIndex("live_consents", ["account_id", "consent_version"]);
  pgm.dropColumn("live_consents", "account_id");

  pgm.dropIndex("wallet_ownership_proofs", ["account_id", "verified_at"]);
  pgm.dropColumn("wallet_ownership_proofs", "account_id");
};
