/**
 * FREE-2 — the double-entry ledger, per docs/ARIA_FUNDS_ARCHITECTURE_V1.md
 * §3c. Every economic operation writes one journal_entries row and >=2
 * balanced ledger_postings rows whose amounts sum to zero per asset —
 * enforced in application code (src/ledger.ts), not just by convention.
 */
exports.up = (pgm) => {
  pgm.createType("ledger_account_type", ["user", "external_clearing", "withdrawal_clearing", "fee_clearing"]);
  pgm.createType("ledger_balance_field", ["available", "reserved", "pending"]);
  pgm.createType("ledger_event_type", [
    "deposit_confirmed",
    "trade_reserved", "trade_spent", "trade_released", "trade_received",
    "network_fee",
    "withdrawal_reserved", "withdrawal_broadcast", "withdrawal_confirmed", "withdrawal_failed",
    "reconciliation_adjustment",
  ]);
  pgm.createType("ledger_reference_type", ["deposit", "withdrawal", "trade", "reconciliation"]);

  pgm.createTable("ledger_accounts", {
    id: "id",
    // null for system/clearing accounts (external_clearing etc.) — there is
    // exactly one clearing account per asset, not per user.
    user_id: { type: "integer", references: "users", onDelete: "RESTRICT" },
    account_type: { type: "ledger_account_type", notNull: true },
    asset: { type: "text", notNull: true },
    // Cached/derived totals — recomputable at any time from ledger_postings
    // (the source of truth). Not maintained on every write yet; see
    // src/ledger.ts getBalance(), which reads live from ledger_postings
    // directly rather than trusting these columns until a reconciliation
    // job (FREE-3+) takes ownership of keeping them in sync.
    available: { type: "bigint", notNull: true, default: 0 },
    reserved: { type: "bigint", notNull: true, default: 0 },
    pending: { type: "bigint", notNull: true, default: 0 },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // One ledger account per (user, asset) for user accounts; one per (asset)
  // for each system account type — enforced via two partial unique indexes
  // rather than a single constraint, since user_id is null for system rows.
  pgm.createIndex("ledger_accounts", ["user_id", "asset"], {
    name: "ledger_accounts_one_per_user_asset",
    unique: true,
    where: "user_id IS NOT NULL",
  });
  pgm.createIndex("ledger_accounts", ["account_type", "asset"], {
    name: "ledger_accounts_one_per_system_type_asset",
    unique: true,
    where: "user_id IS NULL",
  });

  pgm.createTable("journal_entries", {
    id: "id",
    event_type: { type: "ledger_event_type", notNull: true },
    reference_type: { type: "ledger_reference_type", notNull: true },
    reference_id: { type: "text", notNull: true },
    idempotency_key: { type: "text", notNull: true, unique: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createTable("ledger_postings", {
    id: "id",
    journal_entry_id: { type: "integer", notNull: true, references: "journal_entries", onDelete: "RESTRICT" },
    ledger_account_id: { type: "integer", notNull: true, references: "ledger_accounts", onDelete: "RESTRICT" },
    asset: { type: "text", notNull: true },
    amount: { type: "bigint", notNull: true }, // signed: +credit / -debit, base units
    balance_field: { type: "ledger_balance_field", notNull: true },
  });

  pgm.createIndex("ledger_postings", "journal_entry_id");
  pgm.createIndex("ledger_postings", "ledger_account_id");
};

exports.down = (pgm) => {
  pgm.dropTable("ledger_postings");
  pgm.dropTable("journal_entries");
  pgm.dropTable("ledger_accounts");
  pgm.dropType("ledger_reference_type");
  pgm.dropType("ledger_event_type");
  pgm.dropType("ledger_balance_field");
  pgm.dropType("ledger_account_type");
};
