/**
 * LIVE 0.1 Milestone 1 — the database half of the guarantees.
 *
 * Everything asserted here is a claim that CANNOT be proven by a pure
 * test: a UNIQUE constraint under real concurrency, a partial unique
 * index, a CHECK constraint, and the absence of any column capable of
 * holding key material. Spec §19 is explicit that the database is the only
 * layer that holds under concurrency and process crash, so this suite must
 * run against real Postgres.
 *
 * It requires `LIVE_TEST_DATABASE_URL` — a DISPOSABLE dev/test database.
 * It runs every migration in `migrations/` against it and writes real
 * rows. It will refuse to run against anything that looks like production:
 * the URL must NOT be the repo's configured `DATABASE_URL`, and must name
 * a database whose name contains "test" or "dev".
 *
 * When the variable is unset the suite SKIPS — loudly, with exit code 0 —
 * rather than silently passing. A skipped run proves nothing and says so.
 *
 * Run: LIVE_TEST_DATABASE_URL=postgres://... npx tsx test/live-schema-contract.ts
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";

const TARGET = process.env.LIVE_TEST_DATABASE_URL;
if (!TARGET) {
  console.log("⏭️  live-schema-contract SKIPPED — LIVE_TEST_DATABASE_URL is not set.");
  console.log("    This suite proves the DB-level guarantees (UNIQUE under concurrency, partial");
  console.log("    unique indexes, CHECK constraints, no key-material columns). A skipped run");
  console.log("    proves NONE of them. Point it at a disposable Postgres before certification.");
  process.exit(0);
}

// ── Production guard. Refuse first, test second. ────────────────────────
{
  const configured = process.env.DATABASE_URL;
  if (configured && configured === TARGET) {
    console.error("❌ REFUSING TO RUN: LIVE_TEST_DATABASE_URL equals the configured DATABASE_URL.");
    process.exit(1);
  }
  const dbName = (TARGET.split("/").pop() ?? "").split("?")[0]!.toLowerCase();
  if (!/test|dev|ephemeral|local/.test(dbName)) {
    console.error(`❌ REFUSING TO RUN: database name ${JSON.stringify(dbName)} does not look disposable.`);
    console.error("   Name it something containing 'test' or 'dev' to confirm it is throwaway.");
    process.exit(1);
  }
}

const TEST_DB = "./data/live-schema-contract-test.db";
if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(TEST_DB + suffix)) fs.rmSync(TEST_DB + suffix);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = privJwk.d;
process.env.ARIA_LICENSE_PUBLIC_X = pubJwk.x;
process.env.DB_PATH = TEST_DB;
process.env.LOG_LEVEL = "error";
process.env.DATABASE_URL = TARGET;

const { runner } = await import("node-pg-migrate");
const { pgPool } = await import("../src/db-pg.js");
const { createTradeIntent, accountHasUnknownIntent, pendingExposureLamports } = await import("../src/live/live-intents-repo.js");
const { buildTradeIntentDraft, TradeIntentProposalSchema } = await import("../src/live/trade-intent.js");

const pool = pgPool!;
let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

/** Runs the statement and reports whether Postgres refused it. */
async function refused(sql: string, params: unknown[] = []): Promise<boolean> {
  try { await pool.query(sql, params); return false; } catch { return true; }
}

// ── The migration applies cleanly from an empty database ────────────────
await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
await runner({ databaseUrl: TARGET, dir: "migrations", direction: "up", migrationsTable: "pgmigrations", log: () => {} });
check("every migration, including 002 trading accounts, applies cleanly to an empty database", true);

{
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = new Set(rows.map((r) => r.table_name));
  check("all five LIVE tables exist",
    ["wallet_ownership_proofs", "live_consents", "live_risk_policies", "trading_accounts", "trade_intents", "live_positions"]
      .every((t) => names.has(t)));
}

// ── T47: no column anywhere in the LIVE schema can hold key material ────
{
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('wallet_ownership_proofs','live_consents','live_risk_policies','trading_accounts','trade_intents','live_positions')`,
  );
  const offenders = rows.filter((r) => /secret|private|seed|mnemonic|keypair/i.test(r.column_name));
  check("T47: no LIVE column name matches /secret|private|seed|mnemonic|keypair/i",
    offenders.length === 0);
  check("T47: the schema was actually inspected (a vacuous pass is not a pass)", rows.length > 50);
}

// ── Fixtures ────────────────────────────────────────────────────────────
const FOUNDER_TG = 8675309;
const { rows: [user] } = await pool.query<{ id: number }>(
  `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'Founder') RETURNING id`, [FOUNDER_TG],
);
const { rows: [wallet] } = await pool.query<{ id: number }>(
  `INSERT INTO wallet_accounts (user_id, solana_pubkey, authority_model, authority_ref)
   VALUES ($1, 'So11111111111111111111111111111111111111112', 'self_custody', 'self') RETURNING id`, [user!.id],
);
check("the wallet_accounts authority_model enum accepted the new 'self_custody' member", wallet !== undefined);

const { rows: [policy] } = await pool.query<{ id: string }>(
  `INSERT INTO live_risk_policies (
     user_id, max_trade_lamports, max_open_positions, max_total_exposure_lamports,
     max_daily_realized_loss_lamports, max_slippage_bps, max_execution_cost_lamports,
     max_execution_cost_bps_of_trade, mint_cooldown_seconds, global_cooldown_seconds, min_reserve_lamports)
   VALUES ($1, 10000000, 1, 10000000, 20000000, 300, 200000, 500, 60, 30, 10000000) RETURNING id`, [user!.id],
);

const { rows: [account] } = await pool.query<{ id: string }>(
  `INSERT INTO trading_accounts (user_id, wallet_account_id, risk_policy_id, founder_allowlisted, founder_telegram_user_id, consent_version, consent_accepted_at)
   VALUES ($1, $2, $3, true, $4, 'live-0.1-2026-09-19', now()) RETURNING id`,
  [user!.id, wallet!.id, policy!.id, FOUNDER_TG],
);

// ── trading_accounts constraints ────────────────────────────────────────
{
  check("live_enabled defaults to FALSE — nobody is moved into LIVE automatically",
    (await pool.query<{ live_enabled: boolean }>(`SELECT live_enabled FROM trading_accounts WHERE id = $1`, [account!.id]))
      .rows[0]!.live_enabled === false);

  // D2 fix: this must genuinely be able to fail if the default were ever
  // wrong. The previous version inserted a SECOND row for the SAME user,
  // which the very next check below proves is refused by
  // trading_accounts_one_live_per_user — so both branches of its
  // .then()/.catch() were hardcoded to {f:false} and the INSERT never even
  // reached the column-default logic under test. Fixed by using a
  // completely distinct user/wallet pair (unconstrained by that unique
  // index) so the INSERT actually succeeds and the real returned value is
  // asserted, not a hardcoded stand-in.
  const { rows: [otherUser] } = await pool.query<{ id: number }>(
    `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'NotFounder') RETURNING id`, [FOUNDER_TG + 1],
  );
  const { rows: [otherWallet] } = await pool.query<{ id: number }>(
    `INSERT INTO wallet_accounts (user_id, solana_pubkey, authority_model, authority_ref)
     VALUES ($1, 'So11111111111111111111111111111111111111113', 'self_custody', 'self') RETURNING id`, [otherUser!.id],
  );
  const { rows: [freshAccount] } = await pool.query<{ f: boolean }>(
    `INSERT INTO trading_accounts (user_id, wallet_account_id) VALUES ($1,$2) RETURNING founder_allowlisted AS f`,
    [otherUser!.id, otherWallet!.id],
  );
  check("founder_allowlisted defaults to FALSE (genuinely inserted and read back, not a hardcoded stand-in)",
    freshAccount!.f === false);

  check("only ONE non-STOPPED trading account per user is possible",
    await refused(`INSERT INTO trading_accounts (user_id, wallet_account_id) VALUES ($1, $2)`, [user!.id, wallet!.id]));

  check("an ARMED account without an armed_until is REFUSED by the database",
    await refused(`UPDATE trading_accounts SET state = 'ARMED', armed_until = NULL WHERE id = $1`, [account!.id]));

  check("an arm window outside [60, 86400] seconds is REFUSED",
    await refused(`UPDATE trading_accounts SET arm_window_seconds = 86401 WHERE id = $1`, [account!.id]));

  check("an allowlisted account with no named founder is REFUSED",
    await refused(`UPDATE trading_accounts SET founder_telegram_user_id = NULL WHERE id = $1`, [account!.id]));

  await pool.query(`UPDATE trading_accounts SET state='ARMED', armed_until = now() + interval '1 hour', live_enabled = true WHERE id=$1`, [account!.id]);
  check("a properly-windowed ARM is accepted", true);
}

// ── D4/D5: wallet_ownership_proofs and live_consents are bound to the
// ── trading_accounts row per spec §2.4/§3, not merely to the user ────────
{
  check("wallet_ownership_proofs.account_id is REQUIRED — omitting it is refused by the database",
    await refused(
      `INSERT INTO wallet_ownership_proofs (user_id, wallet_account_id, solana_pubkey, nonce, challenge_message, expires_at)
       VALUES ($1, $2, 'So11111111111111111111111111111111111111112', 'nonce-no-account', 'msg', now() + interval '5 minutes')`,
      [user!.id, wallet!.id],
    ));

  const { rows: [proof] } = await pool.query<{ id: string }>(
    `INSERT INTO wallet_ownership_proofs (user_id, account_id, wallet_account_id, solana_pubkey, nonce, challenge_message, expires_at)
     VALUES ($1, $2, $3, 'So11111111111111111111111111111111111111112', 'nonce-with-account', 'msg', now() + interval '5 minutes')
     RETURNING id`,
    [user!.id, account!.id, wallet!.id],
  );
  check("a wallet_ownership_proofs row correctly bound to account_id is accepted", proof !== undefined);

  check("wallet_ownership_proofs.account_id pointing at a nonexistent trading account is REFUSED (real FK)",
    await refused(
      `INSERT INTO wallet_ownership_proofs (user_id, account_id, wallet_account_id, solana_pubkey, nonce, challenge_message, expires_at)
       VALUES ($1, '99999999-9999-9999-9999-999999999999', $2, 'So11111111111111111111111111111111111111112', 'nonce-bad-account', 'msg', now() + interval '5 minutes')`,
      [user!.id, wallet!.id],
    ));

  check("live_consents.account_id is REQUIRED — omitting it is refused by the database",
    await refused(
      `INSERT INTO live_consents (user_id, consent_version, text_sha256, initdata_telegram_user_id)
       VALUES ($1, 'live-0.1-2026-09-19', repeat('a', 64), $2)`,
      [user!.id, FOUNDER_TG],
    ));

  const { rows: [consent] } = await pool.query<{ id: string }>(
    `INSERT INTO live_consents (user_id, account_id, consent_version, text_sha256, initdata_telegram_user_id)
     VALUES ($1, $2, 'live-0.1-2026-09-19', repeat('a', 64), $3) RETURNING id`,
    [user!.id, account!.id, FOUNDER_TG],
  );
  check("a live_consents row correctly bound to account_id is accepted", consent !== undefined);
}

// ── live_risk_policies bounds are a DATABASE fact, not only an app check ─
{
  const insertPolicy = (overrides: Record<string, number | string>) => {
    const base: Record<string, number | string> = {
      max_trade_lamports: 10000000, max_open_positions: 1, max_total_exposure_lamports: 10000000,
      max_daily_realized_loss_lamports: 20000000, max_slippage_bps: 300, max_execution_cost_lamports: 200000,
      max_execution_cost_bps_of_trade: 500, mint_cooldown_seconds: 60, global_cooldown_seconds: 30,
      min_reserve_lamports: 10000000, ...overrides,
    };
    const cols = Object.keys(base);
    return refused(
      `INSERT INTO live_risk_policies (user_id, ${cols.join(",")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(",")})`,
      [user!.id, ...cols.map((c) => base[c]!)],
    );
  };
  check("a zero max_trade_lamports is REFUSED by the database", await insertPolicy({ max_trade_lamports: 0 }));
  check("max_trade > max_total_exposure is REFUSED", await insertPolicy({ max_trade_lamports: 20000000 }));
  check("slippage above 5000 bps is REFUSED", await insertPolicy({ max_slippage_bps: 5001 }));
  check("more than 10 open positions is REFUSED", await insertPolicy({ max_open_positions: 11 }));
}

// ── Idempotency under REAL concurrency (spec T9/T11) ────────────────────
const proposal = TradeIntentProposalSchema.parse({
  mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  side: "BUY", amountLamports: "5000000",
  expectedPrice: { quoteLamports: "5000000", baseUnits: "1000000000" },
  strategyReason: "eligibility:pass|curve-priced",
  marketEvidence: { safety: "pass" },
  marketObservationTimestamp: Date.now(), marketObservationSlot: 301234567,
  candidateId: "cand-abc",
});

function draft(createdAt: number) {
  return buildTradeIntentDraft({
    proposal, userId: user!.id, accountId: account!.id,
    wallet: "So11111111111111111111111111111111111111112",
    riskPolicyId: policy!.id, consentVersion: "live-0.1-2026-09-19",
    proposingClientId: null, createdAt,
  });
}

{
  // T11: two SIMULTANEOUS creations of the same intent. Not sequential —
  // both are in flight before either commits, which is the only version of
  // this test that proves anything about the constraint.
  const t = Date.now();
  const [a, b] = await Promise.all([createTradeIntent(draft(t)), createTradeIntent(draft(t + 5_000))]);

  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trade_intents WHERE idempotency_key = $1`, [draft(t).idempotencyKey],
  );
  check("T11: two simultaneous creations of the same intent produce EXACTLY ONE row", rows[0]!.n === "1");
  check("T11: both callers received the SAME row id", a.row.id === b.row.id);
  check("T11: exactly one caller is told it created the row", (a.created ? 1 : 0) + (b.created ? 1 : 0) === 1);
  check("T11: neither caller saw an exception — a losing race is the mechanism working, not an error", true);

  // T10 again, but against the real stored row: a 5-second difference in
  // createdAt did not change the key.
  check("T10: a different createdAt produced the SAME idempotency key", draft(t).idempotencyKey === draft(t + 5_000).idempotencyKey);
}

// ── Partial unique index: one in-flight intent per (account, mint, side) ─
{
  const other = buildTradeIntentDraft({
    proposal: { ...proposal, candidateId: "cand-different", marketObservationSlot: 301234999 },
    userId: user!.id, accountId: account!.id,
    wallet: "So11111111111111111111111111111111111111112",
    riskPolicyId: policy!.id, consentVersion: "live-0.1-2026-09-19",
    proposingClientId: null, createdAt: Date.now(),
  });
  let blocked = false;
  try { await createTradeIntent(other); } catch { blocked = true; }
  check("T12: a second NON-TERMINAL intent for the same (account, mint, side) is blocked by the partial unique index", blocked);

  // Terminating the first one frees the slot — that is what makes the
  // index a concurrency guard rather than a permanent lock.
  await pool.query(`UPDATE trade_intents SET state='EXPIRED', signed_tx_b64=NULL WHERE account_id=$1`, [account!.id]);
  let allowed = true;
  try { await createTradeIntent(other); } catch { allowed = false; }
  check("T12: once the first intent is terminal, a new one for the same mint IS allowed", allowed);
}

// ── trade_intents CHECK constraints ─────────────────────────────────────
{
  const { rows: [live] } = await pool.query<{ id: string }>(
    `SELECT id FROM trade_intents WHERE state NOT IN ('REJECTED','FAILED','EXPIRED','RECONCILED') LIMIT 1`,
  );

  check("a SUBMITTED intent without a signature is REFUSED",
    await refused(`UPDATE trade_intents SET state='SUBMITTED' WHERE id=$1`, [live!.id]));

  check("a terminal intent still holding signed bytes is REFUSED",
    await refused(`UPDATE trade_intents SET state='FAILED', signed_tx_b64='AQID' WHERE id=$1`, [live!.id]));

  check("a REJECTED intent with no rejection code is REFUSED",
    await refused(`UPDATE trade_intents SET state='REJECTED', rejection_code=NULL WHERE id=$1`, [live!.id]));

  // The schema half of "SUBMITTED is never CONFIRMED".
  check("a merely-SUBMITTED intent cannot carry a confirmed_at — the database refuses it",
    await refused(`UPDATE trade_intents SET state='SUBMITTED', tx_signature='5xSig', confirmed_at=now() WHERE id=$1`, [live!.id]));

  check("a non-RECONCILED intent cannot carry a reconciled_at",
    await refused(`UPDATE trade_intents SET reconciled_at=now() WHERE id=$1`, [live!.id]));

  check("a BUY carrying amount_token_raw is REFUSED (side/amount shape)",
    await refused(`UPDATE trade_intents SET amount_token_raw=100 WHERE id=$1`, [live!.id]));

  check("an intent with a duplicated idempotency_key is REFUSED outright",
    await refused(`UPDATE trade_intents SET idempotency_key = (SELECT idempotency_key FROM trade_intents WHERE id <> $1 LIMIT 1) WHERE id=$1`, [live!.id]));
}

// ── Firewall input queries ──────────────────────────────────────────────
{
  check("accountHasUnknownIntent is false when no intent is UNKNOWN", (await accountHasUnknownIntent(account!.id)) === false);

  const { rows: [live] } = await pool.query<{ id: string }>(
    `SELECT id FROM trade_intents WHERE state NOT IN ('REJECTED','FAILED','EXPIRED','RECONCILED') LIMIT 1`,
  );
  await pool.query(`UPDATE trade_intents SET state='UNKNOWN' WHERE id=$1`, [live!.id]);
  check("accountHasUnknownIntent becomes true — F17's input is a real query, not a cached flag",
    (await accountHasUnknownIntent(account!.id)) === true);

  const pending = await pendingExposureLamports(account!.id);
  check("pendingExposureLamports counts a non-terminal UNKNOWN intent as real exposure (F8/T18)", pending === 5_000_000n);
}

// ── live_positions cannot exist for a non-reconciled intent ─────────────
{
  const { rows: [intent] } = await pool.query<{ id: string }>(`SELECT id FROM trade_intents LIMIT 1`);
  check("a live_position with a zero quantity is REFUSED",
    await refused(
      `INSERT INTO live_positions (user_id, account_id, mint, entry_intent_id, entry_tx_signature, entry_slot,
        quantity_raw, decimals, actual_entry_cost_lamports, entry_network_fee_lamports, entry_priority_fee_lamports,
        effective_entry_price_quote_lamports, effective_entry_price_base_units, opened_at)
       VALUES ($1,$2,'M',$3,'sig',1, 0, 6, 1, 0, 0, 1, 1, now())`,
      [user!.id, account!.id, intent!.id],
    ));
}

await pool.end();
console.log(failures === 0 ? "\n✅ live-schema-contract: all checks passed" : `\n❌ live-schema-contract: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
