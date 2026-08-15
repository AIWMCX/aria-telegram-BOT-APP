/**
 * FREE-2 — exact-once deposit crediting, per
 * docs/ARIA_FUNDS_ARCHITECTURE_V1.md §3d. Identity lives at the
 * instruction/event level (chain_events), not the transaction signature
 * alone — a single Solana transaction can carry multiple transfers.
 */
exports.up = (pgm) => {
  pgm.createType("chain_event_type", ["transfer_in", "transfer_out"]);
  pgm.createType("chain_commitment", ["processed", "confirmed", "finalized"]);
  pgm.createType("deposit_status", ["created", "detected", "confirming", "confirmed", "credited", "failed", "ignored"]);

  pgm.createTable("chain_events", {
    id: "id",
    signature: { type: "text", notNull: true }, // NOT unique alone — see the composite constraint below
    instruction_index: { type: "integer", notNull: true },
    inner_instruction_index: { type: "integer" }, // nullable
    account: { type: "text", notNull: true },
    asset_mint: { type: "text" }, // null = native SOL
    amount: { type: "bigint", notNull: true },
    event_type: { type: "chain_event_type", notNull: true },
    slot: { type: "bigint", notNull: true },
    commitment: { type: "chain_commitment", notNull: true },
    observed_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // This is the actual exact-once invariant: a rescan or restart that
  // re-observes the identical instruction is a DB-level no-op, not
  // something application code has to remember to check.
  pgm.addConstraint("chain_events", "chain_events_unique_instruction", {
    unique: ["signature", "instruction_index", "inner_instruction_index", "account", "asset_mint", "event_type"],
  });

  pgm.createTable("deposits", {
    id: "id",
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    wallet_account_id: { type: "integer", notNull: true, references: "wallet_accounts", onDelete: "RESTRICT" },
    chain_event_id: { type: "integer", notNull: true, unique: true, references: "chain_events", onDelete: "RESTRICT" },
    asset: { type: "text", notNull: true },
    amount: { type: "bigint", notNull: true },
    status: { type: "deposit_status", notNull: true, default: "detected" },
    detected_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    confirmed_at: { type: "timestamptz" },
    credited_at: { type: "timestamptz" },
  });

  pgm.createIndex("deposits", "user_id");
};

exports.down = (pgm) => {
  pgm.dropTable("deposits");
  pgm.dropTable("chain_events");
  pgm.dropType("deposit_status");
  pgm.dropType("chain_commitment");
  pgm.dropType("chain_event_type");
};
