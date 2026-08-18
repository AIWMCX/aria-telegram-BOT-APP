import { pgPool } from "./db-pg.js";

/**
 * REAL-1 Task 3 (storage) + Task 8 (issuance wiring, see server.ts's
 * /api/engine/pair handler) — this module itself remains storage-only:
 * it has no signing code and never will. Real ARIAE1 signing lives
 * entirely in engine-entitlement-signer.ts, the one file in this repo
 * allowed to hold ARIA_ENTITLEMENT_PRIVATE_D. That separation is
 * deliberate — this file's own database logic should never need to
 * change if the signing key or token format ever does.
 */
export type EngineEntitlementStatus = "trial" | "active" | "expired" | "revoked";

export interface EngineEntitlement {
  id: string; // uuid
  user_id: number;
  product: string;
  status: EngineEntitlementStatus;
  starts_at: string | null;
  expires_at: string | null;
  max_paper_buy_lamports: string | null; // bigint surfaces as string via pg
  max_paper_positions: number | null;
  created_at: string;
  updated_at: string;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — engine entitlements domain is unavailable");
  return pgPool;
}

export async function createTrialEntitlement(input: {
  userId: number;
  product?: string;
  durationSeconds: number;
  maxPaperBuyLamports: bigint;
  maxPaperPositions: number;
}): Promise<EngineEntitlement> {
  const pool = requirePool();
  const product = input.product ?? "real-1";
  const { rows } = await pool.query<EngineEntitlement>(
    `INSERT INTO engine_entitlements
       (user_id, product, status, starts_at, expires_at, max_paper_buy_lamports, max_paper_positions)
     VALUES ($1, $2, 'trial', now(), now() + ($3 || ' seconds')::interval, $4, $5)
     RETURNING *`,
    [input.userId, product, input.durationSeconds, input.maxPaperBuyLamports.toString(), input.maxPaperPositions],
  );
  return rows[0]!;
}

/** Idempotent: returns the user's existing entitlement for this product if one exists (e.g. re-pairing a second device), otherwise creates a fresh trial. Never creates a second row — engine_entitlements' own (user_id, product) uniqueness constraint is the backstop, this just avoids hitting it in the common case. */
export async function getOrCreateTrialEntitlement(input: {
  userId: number;
  product?: string;
  durationSeconds: number;
  maxPaperBuyLamports: bigint;
  maxPaperPositions: number;
}): Promise<EngineEntitlement> {
  const existing = await getEntitlementForUser(input.userId, input.product ?? "real-1");
  if (existing) return existing;
  return createTrialEntitlement(input);
}

export async function getEntitlementForUser(userId: number, product = "real-1"): Promise<EngineEntitlement | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<EngineEntitlement>(
    `SELECT * FROM engine_entitlements WHERE user_id = $1 AND product = $2`,
    [userId, product],
  );
  return rows[0];
}

export async function setEntitlementStatus(id: string, status: EngineEntitlementStatus): Promise<void> {
  const pool = requirePool();
  await pool.query(
    `UPDATE engine_entitlements SET status = $2, updated_at = now() WHERE id = $1`,
    [id, status],
  );
}
