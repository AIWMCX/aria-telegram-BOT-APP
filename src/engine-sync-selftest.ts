import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { requireLedgerPool } from "./ledger.js";
import { canonicalSyncMessage } from "./device-auth.js";
import { getLatestSnapshot } from "./engine-snapshots.js";
import { enqueueCommand } from "./engine-commands.js";
import { setEntitlementStatus, createTrialEntitlement } from "./engine-entitlements.js";
import { app } from "./server.js";
import { logger } from "./logger.js";

/**
 * Real-Postgres, real-HTTP verification for REAL-1 blocker #3 — the
 * typed sync protocol, command queue, and entitlement-revocation
 * propagation. Runs only when RUN_ENGINE_SYNC_SELFTEST=true.
 *
 * Same two-part pattern as engine-auth-selftest.ts:
 *  - §1: schema-level checks inside one rolled-back transaction.
 *  - §2: the REAL running Hono app (`app.request(...)`), real genuinely
 *    signed requests, real committed rows explicitly deleted afterward —
 *    this is the part that actually proves server.ts's dispatch switch,
 *    ackCommand's forward-only guard, and the entitlementStatus/
 *    pendingCommands response fields all work as real code, not
 *    reimplemented SQL standing in for it.
 */
export async function runEngineSyncSelfTest(): Promise<void> {
  const pool = requireLedgerPool();
  let failures = 0;
  const check = (name: string, cond: boolean) => {
    logger.info({ src: "engine-sync-selftest", pass: cond }, `${cond ? "PASS" : "FAIL"} — ${name}`);
    if (!cond) failures++;
  };

  // ── §1: schema-level, rolled back ────────────────────────────────────────
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: userRows } = await client.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'EngineSyncSelfTest') RETURNING id`,
      [-990000000 - Math.floor(Math.random() * 1000)],
    );
    const userId = userRows[0]!.id;
    const { rows: clientRows } = await client.query<{ id: string }>(
      `INSERT INTO engine_clients (user_id, device_public_key) VALUES ($1, $2) RETURNING id`,
      [userId, "selftest_schema_pubkey_" + Date.now()],
    );
    const clientId = clientRows[0]!.id;

    const { rows: snapRows } = await client.query<{ id: string }>(
      `INSERT INTO engine_snapshots (client_id, sequence, payload) VALUES ($1, 1, $2) RETURNING id`,
      [clientId, JSON.stringify({ openPositionCount: 2 })],
    );
    check("engine_snapshots accepts a real row scoped to a real client", snapRows.length === 1);

    const { rows: eventRows } = await client.query<{ id: string }>(
      `INSERT INTO engine_events (client_id, sequence, event_type, payload, occurred_at) VALUES ($1, 1, 'paper-position-opened', $2, now()) RETURNING id`,
      [clientId, JSON.stringify({ positionId: "pos_1" })],
    );
    check("engine_events accepts a real row scoped to a real client", eventRows.length === 1);

    const { rows: cmdRows } = await client.query<{ id: string; status: string }>(
      `INSERT INTO engine_commands (client_id, type, expires_at) VALUES ($1, 'paper_pause', now() + interval '1 hour') RETURNING id, status`,
      [clientId],
    );
    check("engine_commands defaults a freshly inserted command to status 'pending'", cmdRows[0]?.status === "pending");

    // A command past its expiry is lazily expired by getPendingCommands's
    // own UPDATE — verify that SQL logic directly here at the schema level.
    const { rows: expiredCmdRows } = await client.query<{ id: string }>(
      `INSERT INTO engine_commands (client_id, type, expires_at) VALUES ($1, 'paper_stop', now() - interval '1 second') RETURNING id`,
      [clientId],
    );
    await client.query(`UPDATE engine_commands SET status = 'expired' WHERE client_id = $1 AND status = 'pending' AND expires_at < now()`, [clientId]);
    const { rows: afterExpiry } = await client.query<{ status: string }>(`SELECT status FROM engine_commands WHERE id = $1`, [expiredCmdRows[0]!.id]);
    check("a command past its expires_at is lazily flipped to 'expired' by the same UPDATE getPendingCommands runs", afterExpiry[0]?.status === "expired");

    logger.info({ src: "engine-sync-selftest" }, `§1 done: ${failures === 0 ? "all passed so far" : `${failures} failure(s) so far`}`);
  } catch (err) {
    logger.error({ src: "engine-sync-selftest", err }, "§1 threw — treating as failure");
    failures++;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  // ── §2: real running app, real signed HTTP requests, real commit+cleanup ──
  let userAId: number | undefined;
  let userBId: number | undefined;
  let clientAId: string | undefined;
  let clientBId: string | undefined;
  let entitlementAId: string | undefined;

  try {
    const { publicKey: pubA, privateKey: privA } = generateKeyPairSync("ed25519");
    const pubAJwk = pubA.export({ format: "jwk" }) as { x: string };
    const { publicKey: pubB, privateKey: privB } = generateKeyPairSync("ed25519");
    const pubBJwk = pubB.export({ format: "jwk" }) as { x: string };

    const { rows: userARows } = await pool.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'EngineSyncSelfTestA') RETURNING id`,
      [-991000000 - Math.floor(Math.random() * 1000)],
    );
    userAId = userARows[0]!.id;
    const { rows: userBRows } = await pool.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'EngineSyncSelfTestB') RETURNING id`,
      [-992000000 - Math.floor(Math.random() * 1000)],
    );
    userBId = userBRows[0]!.id;

    const { rows: clientARows } = await pool.query<{ id: string }>(
      `INSERT INTO engine_clients (user_id, device_public_key) VALUES ($1, $2) RETURNING id`,
      [userAId, pubAJwk.x],
    );
    clientAId = clientARows[0]!.id;
    const { rows: clientBRows } = await pool.query<{ id: string }>(
      `INSERT INTO engine_clients (user_id, device_public_key) VALUES ($1, $2) RETURNING id`,
      [userBId, pubBJwk.x],
    );
    clientBId = clientBRows[0]!.id;

    const entitlement = await createTrialEntitlement({
      userId: userAId, durationSeconds: 7 * 24 * 60 * 60, maxPaperBuyLamports: 5_000_000n, maxPaperPositions: 3,
    });
    entitlementAId = entitlement.id;

    const sync = async (clientId: string, privateKey: typeof privA, sequence: number, payload: unknown) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = canonicalSyncMessage(clientId, sequence, timestamp, payload as any);
      const signature = ed25519Sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
      const res = await app.request("/api/engine/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, sequence, timestamp, payload, signature }),
      });
      return { status: res.status, body: await res.json() as any };
    };

    // ── A real heartbeat surfaces the real live entitlement status ─────────
    const r1 = await sync(clientAId, privA, 1, { kind: "heartbeat" });
    check("a genuinely signed heartbeat sync succeeds through the real running app", r1.status === 200 && r1.body.ok === true);
    check("the response carries the real live entitlement status (trial)", r1.body.entitlementStatus?.status === "trial");
    check("no pending commands yet — response's pendingCommands is an empty array, not undefined", Array.isArray(r1.body.pendingCommands) && r1.body.pendingCommands.length === 0);

    // ── A real snapshot payload is actually persisted ───────────────────────
    const r2 = await sync(clientAId, privA, 2, { kind: "snapshot", snapshot: { openPositionCount: 1, realizedPnlLamports: "500" } });
    check("a snapshot sync succeeds", r2.status === 200 && r2.body.ok === true);
    const stored = await getLatestSnapshot(clientAId);
    check("the snapshot sync actually persisted a row retrievable via getLatestSnapshot",
      stored !== undefined && (stored.payload as any)?.openPositionCount === 1);

    // ── A real event_batch payload is accepted ──────────────────────────────
    const r3 = await sync(clientAId, privA, 3, {
      kind: "event_batch",
      events: [{ eventType: "paper-position-opened", occurredAt: new Date().toISOString(), payload: { positionId: "pos_selftest" } }],
    });
    check("an event_batch sync succeeds", r3.status === 200 && r3.body.ok === true);

    // ── A real enqueued command is delivered on the NEXT sync ───────────────
    const cmd = await enqueueCommand({ clientId: clientAId, type: "paper_pause", ttlSeconds: 3600 });
    const r4 = await sync(clientAId, privA, 4, { kind: "heartbeat" });
    check("a command enqueued out-of-band appears in the very next sync's pendingCommands",
      r4.body.pendingCommands?.some((c: any) => c.commandId === cmd.id && c.type === "paper_pause"));

    // ── Acking it makes it disappear from subsequent pendingCommands ───────
    const r5 = await sync(clientAId, privA, 5, { kind: "command_ack", commandId: cmd.id, status: "acknowledged" });
    check("a command_ack sync for a real pending command succeeds", r5.status === 200 && r5.body.ok === true);
    const r6 = await sync(clientAId, privA, 6, { kind: "heartbeat" });
    check("an acknowledged command no longer appears in pendingCommands (getPendingCommands only returns status='pending')",
      !r6.body.pendingCommands?.some((c: any) => c.commandId === cmd.id));

    // ── Forward-only: completing after acknowledged is allowed, regressing is not ──
    const r7 = await sync(clientAId, privA, 7, { kind: "command_ack", commandId: cmd.id, status: "completed" });
    check("acking 'completed' after 'acknowledged' (forward progress) succeeds", r7.status === 200 && r7.body.ok === true);
    const { rows: statusAfterComplete } = await pool.query<{ status: string }>(`SELECT status FROM engine_commands WHERE id = $1`, [cmd.id]);
    check("the command's real persisted status is 'completed'", statusAfterComplete[0]?.status === "completed");

    const r8 = await sync(clientAId, privA, 8, { kind: "command_ack", commandId: cmd.id, status: "acknowledged" });
    check("the envelope for a regressing ack (completed -> acknowledged) is still accepted (valid signed request)", r8.status === 200 && r8.body.ok === true);
    const { rows: statusAfterRegressionAttempt } = await pool.query<{ status: string }>(`SELECT status FROM engine_commands WHERE id = $1`, [cmd.id]);
    check("...but the command's real persisted status is UNCHANGED — still 'completed', never regressed to 'acknowledged'",
      statusAfterRegressionAttempt[0]?.status === "completed");

    // ── Cross-user isolation: client B cannot ack client A's command ───────
    const cmdForA = await enqueueCommand({ clientId: clientAId, type: "paper_stop", ttlSeconds: 3600 });
    const rCrossUser = await sync(clientBId, privB, 1, { kind: "command_ack", commandId: cmdForA.id, status: "completed" });
    check("client B's signed request for client A's command_id is still a valid envelope (200)", rCrossUser.status === 200 && rCrossUser.body.ok === true);
    const { rows: cmdForAStatus } = await pool.query<{ status: string }>(`SELECT status FROM engine_commands WHERE id = $1`, [cmdForA.id]);
    check("...but client A's command is UNCHANGED — client B's ack was scoped away by (commandId, clientId) and had zero effect",
      cmdForAStatus[0]?.status === "pending");

    // ── The actual point of this whole task: live revocation propagation ──
    await setEntitlementStatus(entitlementAId, "revoked");
    const r9 = await sync(clientAId, privA, 9, { kind: "heartbeat" });
    check("after server-side revocation, the VERY NEXT sync (even a bare heartbeat) reflects it live",
      r9.body.entitlementStatus?.status === "revoked");

    logger.info({ src: "engine-sync-selftest" },
      failures === 0 ? "ALL ENGINE SYNC SELFTEST CHECKS PASSED (including real HTTP dispatch + live revocation propagation)" : `${failures} ENGINE SYNC SELFTEST CHECK(S) FAILED`);
  } catch (err) {
    logger.error({ src: "engine-sync-selftest", err }, "§2 threw — treating as failure");
    failures++;
  } finally {
    // Explicit cleanup — this section commits real rows, unlike §1.
    if (clientAId) {
      await pool.query(`DELETE FROM engine_commands WHERE client_id = $1`, [clientAId]);
      await pool.query(`DELETE FROM engine_events WHERE client_id = $1`, [clientAId]);
      await pool.query(`DELETE FROM engine_snapshots WHERE client_id = $1`, [clientAId]);
    }
    if (entitlementAId) await pool.query(`DELETE FROM engine_entitlements WHERE id = $1`, [entitlementAId]);
    if (clientAId) await pool.query(`DELETE FROM engine_clients WHERE id = $1`, [clientAId]);
    if (clientBId) await pool.query(`DELETE FROM engine_clients WHERE id = $1`, [clientBId]);
    if (userAId) await pool.query(`DELETE FROM users WHERE id = $1`, [userAId]);
    if (userBId) await pool.query(`DELETE FROM users WHERE id = $1`, [userBId]);
  }

  if (failures > 0) {
    logger.error({ src: "engine-sync-selftest", failures }, "ENGINE SYNC SELFTEST FAILED");
  }
}
