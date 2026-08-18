import { requireLedgerPool } from "./ledger.js";
import { logger } from "./logger.js";

/**
 * Real-Postgres verification for the REAL-1 Task 3 schema
 * (engine_entitlements, engine_clients). Same pattern as
 * ledger-selftest.ts: runs only when RUN_ENGINE_CONTROL_SELFTEST=true,
 * everything happens inside one transaction that is ALWAYS rolled back —
 * pass or fail — so nothing synthetic is left in production tables while
 * still exercising real constraints (UNIQUE, FK).
 */
export async function runEngineControlSelfTest(): Promise<void> {
  const pool = requireLedgerPool();
  const client = await pool.connect();
  let failures = 0;
  const check = (name: string, cond: boolean) => {
    logger.info({ src: "engine-control-selftest", pass: cond }, `${cond ? "PASS" : "FAIL"} — ${name}`);
    if (!cond) failures++;
  };

  try {
    await client.query("BEGIN");

    const { rows: userRows } = await client.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'EngineControlSelfTest') RETURNING id`,
      [-950000000 - Math.floor(Math.random() * 1000)],
    );
    const userId = userRows[0]!.id;

    // engine_entitlements: create, and confirm the (user_id, product) uniqueness holds.
    const { rows: entRows } = await client.query<{ id: string }>(
      `INSERT INTO engine_entitlements (user_id, product, status, starts_at, expires_at, max_paper_buy_lamports, max_paper_positions)
       VALUES ($1, 'real-1', 'trial', now(), now() + interval '7 days', $2, $3)
       RETURNING id`,
      [userId, "1000000000", 3],
    );
    check("engine_entitlements row created for a real user", entRows.length === 1);

    let duplicateEntitlementRejected = false;
    try {
      await client.query(
        `INSERT INTO engine_entitlements (user_id, product, status) VALUES ($1, 'real-1', 'trial')`,
        [userId],
      );
    } catch {
      duplicateEntitlementRejected = true;
    }
    check("a second entitlement for the same (user, product) is rejected by the DB constraint", duplicateEntitlementRejected);

    // engine_clients: register, confirm device_public_key uniqueness holds,
    // confirm multiple ACTIVE clients per user ARE allowed (unlike wallet_accounts).
    const fakePubKey1 = "selftest_pubkey_" + Date.now() + "_a";
    const fakePubKey2 = "selftest_pubkey_" + Date.now() + "_b";
    const { rows: client1Rows } = await client.query<{ id: string }>(
      `INSERT INTO engine_clients (user_id, device_public_key, device_name, platform, engine_version)
       VALUES ($1, $2, 'Test Device A', 'windows', '0.1.0') RETURNING id`,
      [userId, fakePubKey1],
    );
    const { rows: client2Rows } = await client.query<{ id: string }>(
      `INSERT INTO engine_clients (user_id, device_public_key, device_name, platform, engine_version)
       VALUES ($1, $2, 'Test Device B', 'windows', '0.1.0') RETURNING id`,
      [userId, fakePubKey2],
    );
    check("a second ACTIVE engine_clients row for the same user is allowed (multi-device by design)",
      client1Rows.length === 1 && client2Rows.length === 1);

    let duplicatePubkeyRejected = false;
    try {
      await client.query(
        `INSERT INTO engine_clients (user_id, device_public_key) VALUES ($1, $2)`,
        [userId, fakePubKey1],
      );
    } catch {
      duplicatePubkeyRejected = true;
    }
    check("a duplicate device_public_key is rejected by the DB constraint", duplicatePubkeyRejected);

    await client.query(`UPDATE engine_clients SET status = 'revoked', revoked_at = now() WHERE id = $1`, [client1Rows[0]!.id]);
    const { rows: statusRows } = await client.query<{ status: string }>(
      `SELECT status FROM engine_clients WHERE id = $1`, [client1Rows[0]!.id],
    );
    check("a client can be revoked independently of its sibling client", statusRows[0]?.status === "revoked");

    logger.info({ src: "engine-control-selftest" }, failures === 0 ? "ALL ENGINE CONTROL SELFTEST CHECKS PASSED" : `${failures} ENGINE CONTROL SELFTEST CHECK(S) FAILED`);
  } catch (err) {
    logger.error({ src: "engine-control-selftest", err }, "engine control selftest threw — treating as failure");
    failures++;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  if (failures > 0) {
    logger.error({ src: "engine-control-selftest", failures }, "ENGINE CONTROL SELFTEST FAILED");
  }
}
