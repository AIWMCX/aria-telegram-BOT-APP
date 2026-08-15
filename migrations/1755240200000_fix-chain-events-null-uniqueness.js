/**
 * Fix found by the real ledger self-test (RUN_LEDGER_SELFTEST), not by
 * inspection: chain_events.inner_instruction_index is NULL for top-level
 * instructions, and Postgres treats NULL as distinct from NULL in a
 * standard UNIQUE constraint — so two identical top-level transfer events
 * were NOT caught as duplicates, defeating the entire exact-once-crediting
 * invariant this table exists for. NULLS NOT DISTINCT (Postgres 15+; this
 * project runs Postgres 18) makes NULL compare equal to NULL for
 * uniqueness purposes, which is what "the same instruction, observed
 * twice" actually requires.
 */
exports.up = (pgm) => {
  pgm.dropConstraint("chain_events", "chain_events_unique_instruction");
  pgm.sql(`
    ALTER TABLE chain_events
    ADD CONSTRAINT chain_events_unique_instruction
    UNIQUE NULLS NOT DISTINCT (signature, instruction_index, inner_instruction_index, account, asset_mint, event_type)
  `);
};

exports.down = (pgm) => {
  pgm.dropConstraint("chain_events", "chain_events_unique_instruction");
  pgm.addConstraint("chain_events", "chain_events_unique_instruction", {
    unique: ["signature", "instruction_index", "inner_instruction_index", "account", "asset_mint", "event_type"],
  });
};
