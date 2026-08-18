import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { requireLedgerPool } from "./ledger.js";
import { canonicalSyncMessage, verifyDeviceSignature } from "./device-auth.js";
import { atomicAdvanceSequence } from "./engine-clients.js";
import { logger } from "./logger.js";

/**
 * Real-Postgres verification for REAL-1 Task 4 — pairing lifecycle, sync
 * signature verification, and replay rejection. Runs only when
 * RUN_ENGINE_AUTH_SELFTEST=true.
 *
 * Two distinct patterns, on purpose:
 *  - Most of this runs inside one transaction that's ALWAYS rolled back
 *    (same pattern as ledger/engine-control self-tests).
 *  - The concurrency race (§2 below) CANNOT use that pattern — testing
 *    real concurrent-connection behavior requires two genuinely separate
 *    connections racing on a committed row, which a single rolled-back
 *    transaction can't exercise. That section runs outside the rollback
 *    wrapper, commits its own throwaway rows, and explicitly deletes them
 *    afterward instead.
 */
export async function runEngineAuthSelfTest(): Promise<void> {
  const pool = requireLedgerPool();
  let failures = 0;
  const check = (name: string, cond: boolean) => {
    logger.info({ src: "engine-auth-selftest", pass: cond }, `${cond ? "PASS" : "FAIL"} — ${name}`);
    if (!cond) failures++;
  };

  // ── §1: pairing + sync + replay, inside one rolled-back transaction ─────
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: userRows } = await client.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'EngineAuthSelfTest') RETURNING id`,
      [-970000000 - Math.floor(Math.random() * 1000)],
    );
    const userId = userRows[0]!.id;

    // Pairing code issuance + consumption (happy path).
    const rawCode = "selftest_code_" + Date.now();
    const { createHash } = await import("node:crypto");
    const codeHash = createHash("sha256").update(rawCode, "utf8").digest("hex");
    await client.query(
      `INSERT INTO engine_pairing_codes (user_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`,
      [userId, codeHash],
    );

    const { rows: consumeRows } = await client.query<{ user_id: number }>(
      `UPDATE engine_pairing_codes SET consumed_at = now()
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id`,
      [codeHash],
    );
    check("a fresh pairing code is consumed successfully and returns the issuing user", consumeRows[0]?.user_id === userId);

    await client.query("SAVEPOINT before_reconsume");
    const { rows: reconsumeRows } = await client.query<{ user_id: number }>(
      `UPDATE engine_pairing_codes SET consumed_at = now()
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id`,
      [codeHash],
    );
    check("the SAME pairing code cannot be consumed a second time", reconsumeRows.length === 0);
    await client.query("ROLLBACK TO SAVEPOINT before_reconsume");

    // Register a device (as /api/engine/pair would, post pairing-code consumption).
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
    const { rows: clientRows } = await client.query<{ id: string }>(
      `INSERT INTO engine_clients (user_id, device_public_key) VALUES ($1, $2) RETURNING id`,
      [userId, pubJwk.x],
    );
    const clientId = clientRows[0]!.id;

    // Sync: valid signature + fresh sequence.
    const nowSec = Math.floor(Date.now() / 1000);
    const msg1 = canonicalSyncMessage(clientId, 1, nowSec, { kind: "heartbeat" });
    const sig1 = ed25519Sign(null, Buffer.from(msg1, "utf8"), privateKey).toString("base64url");
    check("a genuinely signed sync message verifies against the registered device key",
      verifyDeviceSignature(pubJwk.x, msg1, sig1));

    const { rowCount: advance1 } = await client.query(
      `UPDATE engine_clients SET last_sequence = $2, last_seen_at = now() WHERE id = $1 AND last_sequence < $2`,
      [clientId, "1"],
    );
    check("sequence 1 advances last_sequence from its 0 default", (advance1 ?? 0) === 1);

    // Replay: the SAME sequence again must be rejected (not just re-accepted).
    const { rowCount: replay1 } = await client.query(
      `UPDATE engine_clients SET last_sequence = $2, last_seen_at = now() WHERE id = $1 AND last_sequence < $2`,
      [clientId, "1"],
    );
    check("replaying the SAME sequence number is rejected (0 rows affected)", (replay1 ?? 0) === 0);

    // A tampered payload with a stale signature must fail verification.
    const msg2Tampered = canonicalSyncMessage(clientId, 2, nowSec, { kind: "heartbeat" });
    check("a sequence-2 message signed for sequence-1 does not verify (signature is over the exact message)",
      !verifyDeviceSignature(pubJwk.x, msg2Tampered, sig1));

    logger.info({ src: "engine-auth-selftest" },
      `§1 done: ${failures === 0 ? "all passed so far" : `${failures} failure(s) so far`}`);
  } catch (err) {
    logger.error({ src: "engine-auth-selftest", err }, "§1 threw — treating as failure");
    failures++;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  // ── §2: real concurrency race — two genuinely separate connections ──────
  // racing atomicAdvanceSequence for the SAME target sequence on the SAME
  // client row. This is the highest-risk part of Task 4: proving the
  // compare-and-swap is safe under actual concurrent Postgres connections,
  // not just reasoned about. Commits real rows (can't use a rollback
  // wrapper across two independent connections racing on committed state)
  // and explicitly deletes them afterward.
  let raceUserId: number | undefined;
  let raceClientId: string | undefined;
  try {
    const { rows: userRows } = await pool.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'EngineAuthRaceTest') RETURNING id`,
      [-980000000 - Math.floor(Math.random() * 1000)],
    );
    raceUserId = userRows[0]!.id;

    const { rows: clientRows } = await pool.query<{ id: string }>(
      `INSERT INTO engine_clients (user_id, device_public_key) VALUES ($1, $2) RETURNING id`,
      [raceUserId, "selftest_race_pubkey_" + Date.now()],
    );
    raceClientId = clientRows[0]!.id;

    // Two independent pool connections, firing the identical CAS update at
    // the same target sequence, genuinely concurrently via Promise.all —
    // not sequential awaits, which would prove nothing about real races.
    const results = await Promise.all([
      atomicAdvanceSequence(raceClientId, 5n),
      atomicAdvanceSequence(raceClientId, 5n),
    ]);
    const winners = results.filter((r) => r === true).length;
    check("exactly one of two concurrent requests for the SAME target sequence wins the race", winners === 1);

    const { rows: finalRows } = await pool.query<{ last_sequence: string }>(
      `SELECT last_sequence FROM engine_clients WHERE id = $1`, [raceClientId],
    );
    check("the final persisted sequence is exactly 5, not corrupted by the race", finalRows[0]?.last_sequence === "5");

    logger.info({ src: "engine-auth-selftest" },
      failures === 0 ? "ALL ENGINE AUTH SELFTEST CHECKS PASSED (including real concurrency race)" : `${failures} ENGINE AUTH SELFTEST CHECK(S) FAILED`);
  } catch (err) {
    logger.error({ src: "engine-auth-selftest", err }, "§2 (concurrency race) threw — treating as failure");
    failures++;
  } finally {
    // Explicit cleanup — this section commits real rows, unlike §1.
    if (raceClientId) await pool.query(`DELETE FROM engine_clients WHERE id = $1`, [raceClientId]);
    if (raceUserId) await pool.query(`DELETE FROM users WHERE id = $1`, [raceUserId]);
  }

  if (failures > 0) {
    logger.error({ src: "engine-auth-selftest", failures }, "ENGINE AUTH SELFTEST FAILED");
  }
}
