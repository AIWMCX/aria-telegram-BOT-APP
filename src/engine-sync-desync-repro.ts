import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { requireLedgerPool } from "./ledger.js";
import { canonicalSyncMessage } from "./device-auth.js";
import { createPairingCode } from "./engine-pairing.js";
import { app } from "./server.js";
import { logger } from "./logger.js";

/**
 * Targeted reproduction for the real sequence-desync bug found during the
 * first real user's live acceptance test (see
 * docs/ARIA_PRODUCT_SCALE_STATE.md, SYNC: INVESTIGATING). Runs only when
 * RUN_SYNC_DESYNC_REPRO=true. Same real-Postgres/real-HTTP discipline as
 * engine-sync-selftest.ts: mints pairing codes via the real
 * createPairingCode(), pairs through the real /api/engine/pair endpoint,
 * syncs through the real /api/engine/sync endpoint — never reimplemented
 * SQL standing in for the actual code path. Explicit cleanup at the end.
 *
 * Covers cases A, C, D from the investigation design. Case B (same
 * identity after a normal process restart) cannot be faithfully
 * reproduced by a single in-process self-test — a restart is a client-side
 * event (a fresh Node process re-reading pairing-state.json), not
 * something this server-side harness can simulate. That case relies on
 * the "sync diag" log lines shipped in aria-engine 0.7.0-beta.4's cli.ts
 * (client) and this repo's server.ts "sync sequence check" log line
 * (server) correlating on the NEXT real device restart.
 */
export async function runSyncDesyncRepro(): Promise<void> {
  const pool = requireLedgerPool();
  const results: string[] = [];
  const record = (line: string) => { results.push(line); logger.info({ src: "sync-desync-repro" }, line); };

  const sync = async (clientId: string, privateKey: any, sequence: number, payload: unknown) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = canonicalSyncMessage(clientId, sequence, timestamp, payload as any);
    const signature = ed25519Sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
    const res = await app.request("/api/engine/sync", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, sequence, timestamp, payload, signature }),
    });
    return { status: res.status, body: await res.json() as any };
  };

  const serverSeq = async (clientId: string): Promise<string | undefined> => {
    const { rows } = await pool.query<{ last_sequence: string }>(`SELECT last_sequence FROM engine_clients WHERE id = $1`, [clientId]);
    return rows[0]?.last_sequence;
  };

  let userId: number | undefined;
  let clientId: string | undefined;

  // Self-healing: a prior run of this script (2026-09-03, production) left an
  // orphaned user+client+entitlement behind because the original cleanup
  // below deleted engine_clients but not engine_entitlements, which also
  // RESTRICTs deletion of `users` — the DELETE FROM users threw and the rest
  // of cleanup never ran. Sweep any leftover 'SyncDesyncRepro'-tagged rows
  // before creating new ones, in the correct FK order, so this is idempotent
  // even if a future run crashes the same way.
  try {
    const { rows: stale } = await pool.query<{ id: number }>(
      `SELECT id FROM users WHERE first_name = 'SyncDesyncRepro'`,
    );
    for (const { id } of stale) {
      await pool.query(`DELETE FROM engine_entitlements WHERE user_id = $1`, [id]);
      await pool.query(`DELETE FROM engine_pairing_codes WHERE user_id = $1`, [id]);
      const { rows: staleClients } = await pool.query<{ id: string }>(`SELECT id FROM engine_clients WHERE user_id = $1`, [id]);
      for (const c of staleClients) {
        await pool.query(`DELETE FROM engine_snapshots WHERE client_id = $1`, [c.id]);
        await pool.query(`DELETE FROM engine_events WHERE client_id = $1`, [c.id]);
        await pool.query(`DELETE FROM engine_commands WHERE client_id = $1`, [c.id]);
        await pool.query(`DELETE FROM engine_clients WHERE id = $1`, [c.id]);
      }
      await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
    if (stale.length > 0) record(`swept ${stale.length} leftover row(s) from a prior crashed run before starting`);
  } catch (err) {
    logger.error({ src: "sync-desync-repro", err }, "pre-sweep of stale repro rows failed — continuing anyway");
  }

  try {
    const { rows: userRows } = await pool.query<{ id: number }>(
      `INSERT INTO users (telegram_user_id, first_name) VALUES ($1, 'SyncDesyncRepro') RETURNING id`,
      [-993000000 - Math.floor(Math.random() * 1000)],
    );
    userId = userRows[0]!.id;

    // ── Case A: fresh identity + fresh pair, through the REAL pairing endpoint ──
    const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ed25519");
    const pubJwk = pub.export({ format: "jwk" }) as { x: string };
    const { code } = await createPairingCode(userId);

    const pairRes = await app.request("/api/engine/pair", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, devicePublicKey: pubJwk.x, deviceName: "repro", platform: "test" }),
    });
    const pairBody = await pairRes.json() as any;
    record(`CASE A: pair status=${pairRes.status} ok=${pairBody.ok} clientId=${pairBody.clientId}`);
    clientId = pairBody.clientId;
    if (!clientId) { record("CASE A: pairing failed, aborting repro"); return; }

    const serverBefore = await serverSeq(clientId);
    record(`CASE A: server last_sequence immediately after fresh pair = ${serverBefore} (expect "0")`);

    const r1 = await sync(clientId, priv, 1, { kind: "heartbeat" });
    const serverAfter1 = await serverSeq(clientId);
    record(`CASE A: first sync sequence=1 -> status=${r1.status} ok=${r1.body.ok} error=${r1.body.error ?? "none"} | server last_sequence now=${serverAfter1} (expect "1")`);

    // Continue a normal run: sequence 2, 3
    const r2 = await sync(clientId, priv, 2, { kind: "heartbeat" });
    record(`CASE A: sync sequence=2 -> status=${r2.status} ok=${r2.body.ok}`);
    const r3 = await sync(clientId, priv, 3, { kind: "heartbeat" });
    record(`CASE A: sync sequence=3 -> status=${r3.status} ok=${r3.body.ok}`);

    // ── Case D: a "crashed" client whose local counter advanced past what it
    // actually sent (simulates: local persist succeeded, HTTP call never
    // completed, process died, restart resumes from the higher local value) ──
    // Local would now believe next=4, but we skip sending 4 entirely and jump to 5.
    const serverBeforeGap = await serverSeq(clientId);
    const r5 = await sync(clientId, priv, 5, { kind: "heartbeat" });
    const serverAfterGap = await serverSeq(clientId);
    record(`CASE D: skipped sequence 4, sent 5 directly -> status=${r5.status} ok=${r5.body.ok} | server last_sequence ${serverBeforeGap} -> ${serverAfterGap} (a gap should be ACCEPTED per atomicAdvanceSequence's strict-less-than check)`);

    // Now the REAL stale-replay case: resend an already-consumed sequence (3)
    const rStale = await sync(clientId, priv, 3, { kind: "heartbeat" });
    record(`CASE D: replaying already-consumed sequence=3 -> status=${rStale.status} ok=${rStale.body.ok} error=${rStale.body.error ?? "none"} currentSequence=${rStale.body.currentSequence ?? "none"} (expect 409 with currentSequence=5)`);

    // ── Case C: re-pair attempt using the SAME device identity (same public key) ──
    const { code: code2 } = await createPairingCode(userId);
    const rePairRes = await app.request("/api/engine/pair", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code2, devicePublicKey: pubJwk.x, deviceName: "repro-repair", platform: "test" }),
    });
    const rePairBody = await rePairRes.json() as any;
    record(`CASE C: re-pair with the SAME device_public_key -> status=${rePairRes.status} ok=${rePairBody.ok} error=${rePairBody.error ?? "none"} (expect 409, NOT a new clientId)`);

    // Confirm the ORIGINAL client's sequence state is untouched by the failed re-pair attempt
    const serverAfterRepairAttempt = await serverSeq(clientId);
    record(`CASE C: original client's server last_sequence after the failed re-pair attempt = ${serverAfterRepairAttempt} (expect unchanged, "5")`);
    const r6 = await sync(clientId, priv, 6, { kind: "heartbeat" });
    record(`CASE C: original client can still sync normally afterward (sequence=6) -> status=${r6.status} ok=${r6.body.ok}`);

    logger.info({ src: "sync-desync-repro", results }, "SYNC DESYNC REPRO COMPLETE");
  } catch (err) {
    logger.error({ src: "sync-desync-repro", err }, "sync-desync-repro threw");
  } finally {
    // engine_entitlements also RESTRICTs deletion of `users` — must be
    // deleted before the users row, same as engine_clients. Missing this
    // the first time this script ran in production left an orphaned
    // user+client+entitlement behind (this DELETE threw, so nothing after
    // it ran) — see the pre-sweep above, which cleans that up on next run.
    // Every table in this codebase that FK-references `users` with RESTRICT
    // as of this fix: wallet_accounts, ledger, chain_events_deposits (none
    // of which this script ever writes to), engine_entitlements,
    // engine_clients, engine_pairing_codes (all three of which it does).
    if (userId) {
      await pool.query(`DELETE FROM engine_entitlements WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM engine_pairing_codes WHERE user_id = $1`, [userId]);
    }
    if (clientId) {
      await pool.query(`DELETE FROM engine_snapshots WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM engine_events WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM engine_commands WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM engine_clients WHERE id = $1`, [clientId]);
    }
    if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
}
