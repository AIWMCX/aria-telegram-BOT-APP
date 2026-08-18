import { randomBytes, createHash } from "node:crypto";
import { pgPool } from "./db-pg.js";

/**
 * REAL-1 Task 4 — pairing code issuance and single-use consumption. The
 * raw code is a bearer credential (whoever has it can register a device
 * against the issuing user's account) — it is generated here, returned
 * to the caller ONCE, and never stored or logged in plaintext; only its
 * SHA-256 hash is persisted, matching the license/entitlement convention.
 */

export const PAIRING_CODE_BYTES = 20; // 160 bits of entropy
export const PAIRING_CODE_TTL_SECONDS = 600; // 10 minutes

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine pairing domain is unavailable");
  return pgPool;
}

export interface IssuedPairingCode {
  code: string; // plaintext — returned exactly once, never persisted
  expiresAt: string;
}

export async function createPairingCode(userId: number): Promise<IssuedPairingCode> {
  const pool = requirePool();
  const code = randomBytes(PAIRING_CODE_BYTES).toString("base64url");
  const codeHash = hashCode(code);

  const { rows } = await pool.query<{ expires_at: string }>(
    `INSERT INTO engine_pairing_codes (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
     RETURNING expires_at`,
    [userId, codeHash, PAIRING_CODE_TTL_SECONDS],
  );

  return { code, expiresAt: rows[0]!.expires_at };
}

export type PairingConsumeResult =
  | { ok: true; userId: number }
  | { ok: false; reason: "invalid-or-expired-or-consumed" };

/**
 * Atomically marks a pairing code consumed and returns its owning user —
 * "atomically" meaning the UPDATE's WHERE clause (consumed_at IS NULL AND
 * expires_at > now()) and the write happen as one statement, so two
 * concurrent consumption attempts for the same code can never both
 * succeed: exactly one UPDATE affects a row, the other affects zero.
 */
export async function consumePairingCode(code: string): Promise<PairingConsumeResult> {
  const pool = requirePool();
  const codeHash = hashCode(code);

  const { rows } = await pool.query<{ user_id: number }>(
    `UPDATE engine_pairing_codes
     SET consumed_at = now()
     WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [codeHash],
  );

  if (rows.length === 0) return { ok: false, reason: "invalid-or-expired-or-consumed" };
  return { ok: true, userId: rows[0]!.user_id };
}
