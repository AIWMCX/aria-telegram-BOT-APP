/**
 * LIVE 0.1 Milestone 1 — migration DDL verification WITHOUT a database.
 *
 * READ THIS BEFORE TRUSTING IT. This suite runs the migration through
 * node-pg-migrate's own `MigrationBuilder` and inspects the SQL it
 * generates. That catches a misspelled builder option, a bad column type
 * shorthand, a constraint that silently generates nothing, and a `down()`
 * that does not reverse `up()`.
 *
 * It does NOT prove the migration APPLIES. Only Postgres can prove that,
 * and only test/live-schema-contract.ts (which needs a real
 * LIVE_TEST_DATABASE_URL) does. Treat a green run here as "the migration
 * is well-formed", never as "the schema is live".
 *
 * Run: npx tsx test/live-migration-sql.ts
 */
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { MigrationBuilder } from "node-pg-migrate";

const require_ = createRequire(import.meta.url);

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

const MIGRATION = "migrations/1758240000000_create-trading-accounts.js";

/**
 * The migrations/ directory is CommonJS (`exports.up = ...`) inside a
 * `"type": "module"` package — which is exactly how node-pg-migrate loads
 * it, and why a plain `import` will not work here.
 */
function loadMigration(path: string): { up: (pgm: unknown) => void; down: (pgm: unknown) => void } {
  const source = fs.readFileSync(path, "utf8");
  const module_ = { exports: {} as Record<string, unknown> };
  const wrapper = vm.runInThisContext(
    `(function (exports, module, require) {${source}\n})`,
    { filename: path },
  ) as (e: unknown, m: unknown, r: unknown) => void;
  wrapper(module_.exports, module_, require_);
  return module_.exports as unknown as { up: (pgm: unknown) => void; down: (pgm: unknown) => void };
}

function generate(direction: "up" | "down"): string {
  const migration = loadMigration(MIGRATION);
  const fakeDb = { query: async () => ({ rows: [] }), select: async () => [] };
  const builder = new MigrationBuilder(
    fakeDb as never,
    { typeShorthands: {}, logger: console } as never,
    false,
    MIGRATION as never,
  );
  migration[direction](builder);
  return builder.getSql();
}

let upSql = "";
let downSql = "";
try {
  upSql = generate("up");
  downSql = generate("down");
} catch (err) {
  console.log(`❌ the migration threw while generating SQL: ${(err as Error).message}`);
  process.exit(1);
}

check("up() generates SQL without throwing", upSql.length > 1000);
check("down() generates SQL without throwing", downSql.length > 100);

// ── Every table and enum the spec's schema requires ─────────────────────
for (const table of ["wallet_ownership_proofs", "live_consents", "live_risk_policies", "trading_accounts", "trade_intents", "live_positions"]) {
  check(`CREATE TABLE "${table}" is generated`, new RegExp(`CREATE TABLE "${table}"`, "i").test(upSql));
  check(`down() drops "${table}"`, new RegExp(`DROP TABLE "${table}"`, "i").test(downSql));
}
for (const type of ["trading_account_state", "trade_intent_state", "trade_intent_side", "live_position_status"]) {
  check(`CREATE TYPE "${type}" is generated`, new RegExp(`CREATE TYPE "${type}"`, "i").test(upSql));
  check(`down() drops "${type}"`, new RegExp(`DROP TYPE "${type}"`, "i").test(downSql));
}

check("the wallet_accounts enum gains 'self_custody' additively and idempotently",
  /ALTER TYPE "authority_model" ADD VALUE IF NOT EXISTS [\s\S]{0,20}self_custody/i.test(upSql));

// ── The constraints that carry a spec invariant ─────────────────────────
const requiredConstraints: Array<[string, string]> = [
  ["an ARMED account must have an arm window", "trading_accounts_armed_requires_window"],
  ["the arm window is bounded [60, 86400]", "trading_accounts_arm_window_bounded"],
  ["an allowlisted account must name its founder", "trading_accounts_allowlisted_names_founder"],
  ["risk-policy bounds are a database fact", "live_risk_policies_sane_bounds"],
  ["a terminal intent holds no signed bytes", "trade_intents_terminal_has_no_signed_bytes"],
  ["a SUBMITTED-or-later intent has a signature", "trade_intents_submitted_has_signature"],
  ["confirmed_at requires a genuinely confirmed state", "trade_intents_confirmed_at_requires_confirmed_state"],
  ["reconciled_at requires RECONCILED", "trade_intents_reconciled_at_requires_reconciled_state"],
  ["a REJECTED intent carries its code", "trade_intents_rejected_has_code"],
  ["BUY/SELL amount shape", "trade_intents_side_amount_shape"],
  ["a CLOSED position has its exit", "live_positions_closed_has_exit"],
  ["a position has a positive quantity and cost", "live_positions_quantity_positive"],
  ["a verified ownership proof carries its signature", "wallet_ownership_proofs_verified_has_signature"],
];
for (const [label, name] of requiredConstraints) {
  check(`CHECK constraint present: ${label}`, upSql.includes(name) && new RegExp(`CONSTRAINT "${name}" CHECK`, "i").test(upSql));
}

// ── The unique indexes that are the real concurrency guarantees ─────────
check("trade_intents.idempotency_key is UNIQUE — the only duplicate guard that holds under concurrency",
  /"idempotency_key"[^,]*UNIQUE/i.test(upSql));
check("at most one non-terminal intent per (account, mint, side)",
  /CREATE UNIQUE INDEX "trade_intents_one_in_flight_per_account_mint_side"/i.test(upSql)
  && /trade_intents_one_in_flight_per_account_mint_side[\s\S]{0,200}WHERE state NOT IN/i.test(upSql));
check("at most one non-STOPPED trading account per user",
  /CREATE UNIQUE INDEX "trading_accounts_one_live_per_user"[\s\S]{0,160}WHERE state <> 'STOPPED'/i.test(upSql));
check("at most one open position per (account, mint)",
  /CREATE UNIQUE INDEX "live_positions_one_open_per_account_mint"/i.test(upSql));
check("the ownership-proof nonce is UNIQUE — single-use is a database fact",
  /"nonce"[^,]*UNIQUE/i.test(upSql));

// ── Money columns are bigint, never numeric and never float ─────────────
{
  const moneyColumns = [...upSql.matchAll(/"(\w*(?:lamports|_raw|units))"\s+(\w+)/gi)];
  check("every lamport/raw-unit/base-unit column is bigint — no numeric, no double precision",
    moneyColumns.length > 15 && moneyColumns.every((m) => m[2]!.toLowerCase() === "bigint"));
}

// ── Key custody: the schema cannot hold a secret ────────────────────────
{
  const columnNames = [...upSql.matchAll(/^\s+"(\w+)"\s+\w/gm)].map((m) => m[1]!);
  check("no generated column name matches /secret|private|seed|mnemonic|keypair/i",
    columnNames.length > 50 && !columnNames.some((c) => /secret|private|seed|mnemonic|keypair/i.test(c)));
}

// ── Honest scope statement ──────────────────────────────────────────────
console.log("\nℹ️  This suite proves the migration is WELL-FORMED, not that it APPLIES.");
console.log("   Only test/live-schema-contract.ts against a real Postgres proves that.");

console.log(failures === 0 ? "\n✅ live-migration-sql: all checks passed" : `\n❌ live-migration-sql: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
