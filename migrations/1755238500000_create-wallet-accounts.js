/**
 * FREE-1/FREE-2 groundwork — wallet/trading account, per
 * docs/ARIA_FUNDS_ARCHITECTURE_V1.md §3b. `authority_ref` is intentionally
 * opaque (text) to app logic: the ledger and execution engine never need to
 * know whether it's a Turnkey sub-organization ID, a Privy policy ID, or a
 * program PDA — only that wallet_accounts.status = 'active' gates signing.
 */
exports.up = (pgm) => {
  pgm.createType("authority_model", ["delegated_vendor", "delegated_program"]);
  pgm.createType("wallet_account_status", ["active", "revoked", "suspended"]);

  pgm.createTable("wallet_accounts", {
    id: "id",
    user_id: {
      type: "integer",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT", // a user is never silently orphaned from their wallet — deletion must go through explicit account closure, not cascade
    },
    solana_pubkey: { type: "text", notNull: true, unique: true },
    authority_model: { type: "authority_model", notNull: true },
    // Opaque reference into the signer's own system (vendor sub-org/policy
    // ID, or an on-chain program PDA) — never a private key, never secret
    // material. The actual signing credential lives entirely on the
    // vendor/program side, never in this database.
    authority_ref: { type: "text", notNull: true },
    status: { type: "wallet_account_status", notNull: true, default: "active" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    revoked_at: { type: "timestamptz" },
  });

  pgm.createIndex("wallet_accounts", "user_id");

  // One active wallet per user for v1 (§3b: "v1 assumes one") — enforced
  // as a partial unique index rather than just a convention, so a bug in
  // application code can't silently create two live signing authorities
  // for the same user.
  pgm.createIndex("wallet_accounts", "user_id", {
    name: "wallet_accounts_one_active_per_user",
    unique: true,
    where: "status = 'active'",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("wallet_accounts");
  pgm.dropType("wallet_account_status");
  pgm.dropType("authority_model");
};
