import { requireLedgerPool, postJournalEntry, getBalance, getOrCreateLedgerAccount, validateBalancedPostings } from "./ledger.js";
import { logger } from "./logger.js";

/**
 * Real-Postgres verification for the FREE-2 ledger schema. Runs only when
 * RUN_LEDGER_SELFTEST=true — never on a normal boot. Everything happens
 * inside one transaction that is ALWAYS rolled back at the end, pass or
 * fail, so this never leaves synthetic rows in production tables while
 * still exercising real constraints (UNIQUE, FK, transaction semantics).
 */
export async function runLedgerSelfTest(): Promise<void> {
  const pool = requireLedgerPool();
  const client = await pool.connect();
  let failures = 0;
  const check = (name: string, cond: boolean) => {
    logger.info({ src: "ledger-selftest", pass: cond }, `${cond ? "PASS" : "FAIL"} — ${name}`);
    if (!cond) failures++;
  };

  try {
    await client.query("BEGIN");

    // Pure-function check — no DB needed, but run here so it's in the same log stream.
    try {
      validateBalancedPostings([
        { ledgerAccountId: 1, asset: "SOL", amount: 5n, balanceField: "available" },
        { ledgerAccountId: 2, asset: "SOL", amount: -3n, balanceField: "available" },
      ]);
      check("unbalanced postings are rejected before any write", false); // should have thrown
    } catch {
      check("unbalanced postings are rejected before any write", true);
    }

    // Synthetic user — a throwaway telegram_user_id unlikely to collide with anything real.
    const { rows: userRows } = await client.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'LedgerSelfTest') RETURNING id`,
      [-900000000 - Math.floor(Math.random() * 1000)],
    );
    const userId = userRows[0]!.id;

    const externalClearingId = await getOrCreateLedgerAccount(client, { userId: null, accountType: "external_clearing", asset: "SOL" });
    const userAccountId = await getOrCreateLedgerAccount(client, { userId, accountType: "user", asset: "SOL" });

    // Happy path: deposit confirmed, 1 SOL (in lamports).
    const oneSol = 1_000_000_000n;
    await postJournalEntry(client, {
      eventType: "deposit_confirmed",
      referenceType: "deposit",
      referenceId: "selftest-deposit-1",
      idempotencyKey: `selftest-${Date.now()}-1`,
      postings: [
        { ledgerAccountId: externalClearingId, asset: "SOL", amount: -oneSol, balanceField: "available" },
        { ledgerAccountId: userAccountId, asset: "SOL", amount: oneSol, balanceField: "available" },
      ],
    });
    const balanceAfterDeposit = await getBalance(client, userAccountId, "available");
    check("deposit journal entry credits the user's available balance", balanceAfterDeposit === oneSol);

    // Withdrawal reservation: available -> reserved for the same user.
    await postJournalEntry(client, {
      eventType: "withdrawal_reserved",
      referenceType: "withdrawal",
      referenceId: "selftest-withdrawal-1",
      idempotencyKey: `selftest-${Date.now()}-2`,
      postings: [
        { ledgerAccountId: userAccountId, asset: "SOL", amount: -oneSol, balanceField: "available" },
        { ledgerAccountId: userAccountId, asset: "SOL", amount: oneSol, balanceField: "reserved" },
      ],
    });
    const availableAfterReserve = await getBalance(client, userAccountId, "available");
    const reservedAfterReserve = await getBalance(client, userAccountId, "reserved");
    check("withdrawal reservation moves funds from available to reserved, not out of existence",
      availableAfterReserve === 0n && reservedAfterReserve === oneSol);

    // Exact-once chain_events: insert the same instruction twice, second must no-op via the unique constraint.
    const eventArgs = [
      "selftest_sig_" + Date.now(), 0, null, "SelfTestAccount", null, oneSol.toString(), "transfer_in", 123456, "finalized",
    ];
    const first = await client.query(
      `INSERT INTO chain_events (signature, instruction_index, inner_instruction_index, account, asset_mint, amount, event_type, slot, commitment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (signature, instruction_index, inner_instruction_index, account, asset_mint, event_type) DO NOTHING
       RETURNING id`,
      eventArgs,
    );
    const second = await client.query(
      `INSERT INTO chain_events (signature, instruction_index, inner_instruction_index, account, asset_mint, amount, event_type, slot, commitment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (signature, instruction_index, inner_instruction_index, account, asset_mint, event_type) DO NOTHING
       RETURNING id`,
      eventArgs,
    );
    check("replaying the identical chain_event is a DB-level no-op (exact-once)",
      first.rows.length === 1 && second.rows.length === 0);

    logger.info({ src: "ledger-selftest" }, failures === 0 ? "ALL LEDGER SELFTEST CHECKS PASSED" : `${failures} LEDGER SELFTEST CHECK(S) FAILED`);
  } catch (err) {
    logger.error({ src: "ledger-selftest", err }, "ledger selftest threw — treating as failure");
    failures++;
  } finally {
    await client.query("ROLLBACK"); // always — this must never leave data behind, pass or fail
    client.release();
  }

  if (failures > 0) {
    logger.error({ src: "ledger-selftest", failures }, "LEDGER SELFTEST FAILED");
  }
}
