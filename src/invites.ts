import { randomBytes } from "node:crypto";
import { pgPool } from "./db-pg.js";
import { trackEvent } from "./funnel.js";

/**
 * First-10 beta control (2026-09-04) — see migrations/1757000000000_create-invites.js.
 * Owner issues a code (createInvite), the invitee redeems it via a
 * `/start <code>` Telegram deep link (redeemInvite), which is the only
 * thing that ever binds an invite to a real user_id. Engine access
 * (pairing-code issuance) is gated on isUserApproved().
 */

export type InviteStatus = "invited" | "activated" | "paired" | "active" | "suspended";

export interface Invite {
  id: string;
  code: string;
  note: string | null;
  status: InviteStatus;
  user_id: number | null;
  created_at: string;
  activated_at: string | null;
  paired_at: string | null;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — invites domain is unavailable");
  return pgPool;
}

export async function createInvite(note?: string): Promise<{ code: string; id: string }> {
  const pool = requirePool();
  const code = randomBytes(6).toString("base64url"); // short — a human retypes or taps this
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO invites (code, note) VALUES ($1, $2) RETURNING id`,
    [code, note ?? null],
  );
  void trackEvent("invite_created", undefined, { inviteId: rows[0]!.id, note: note ?? null });
  return { code, id: rows[0]!.id };
}

export async function listInvites(): Promise<Invite[]> {
  const pool = requirePool();
  const { rows } = await pool.query<Invite>(`SELECT * FROM invites ORDER BY created_at DESC LIMIT 50`);
  return rows;
}

/**
 * Redeems a code for a real Telegram user, binding user_id. Idempotent
 * for the SAME user re-clicking their own link; rejects a code already
 * bound to a DIFFERENT user, and rejects a user who already redeemed a
 * different code (the DB's one-per-user unique constraint is the
 * authoritative guard — this just gives a clean, typed result instead of
 * a raw constraint-violation error).
 */
export type RedeemResult =
  | { ok: true; alreadyRedeemed: boolean }
  | { ok: false; reason: "not-found" | "already-claimed-by-another-user" | "user-already-has-invite" };

export async function redeemInvite(code: string, userId: number): Promise<RedeemResult> {
  const pool = requirePool();
  const { rows } = await pool.query<Invite>(`SELECT * FROM invites WHERE code = $1`, [code]);
  const invite = rows[0];
  if (!invite) return { ok: false, reason: "not-found" };

  if (invite.user_id !== null) {
    return invite.user_id === userId ? { ok: true, alreadyRedeemed: true } : { ok: false, reason: "already-claimed-by-another-user" };
  }

  const { rows: existingForUser } = await pool.query<{ id: string }>(`SELECT id FROM invites WHERE user_id = $1`, [userId]);
  if (existingForUser.length > 0) return { ok: false, reason: "user-already-has-invite" };

  await pool.query(
    `UPDATE invites SET user_id = $2, status = 'activated', activated_at = now() WHERE id = $1`,
    [invite.id, userId],
  );
  void trackEvent("invite_redeemed", userId, { inviteId: invite.id });
  return { ok: true, alreadyRedeemed: false };
}

/** engine pairing-code issuance calls this — approved means activated, paired, or active (not merely invited-but-unredeemed, and not suspended). */
export async function isUserApproved(userId: number): Promise<boolean> {
  const pool = requirePool();
  const { rows } = await pool.query<{ status: InviteStatus }>(`SELECT status FROM invites WHERE user_id = $1`, [userId]);
  const status = rows[0]?.status;
  return status === "activated" || status === "paired" || status === "active";
}

/** Called from /api/engine/pair's success path — first real device pairing moves activated -> paired. */
export async function markInvitePaired(userId: number): Promise<void> {
  const pool = requirePool();
  const { rowCount } = await pool.query(
    `UPDATE invites SET status = 'paired', paired_at = now() WHERE user_id = $1 AND status = 'activated'`,
    [userId],
  );
  if ((rowCount ?? 0) > 0) void trackEvent("pairing_completed", userId);
}

export interface AttributionRow {
  source: string;
  invited: number;
  activated: number;
  paired: number;
}

/**
 * `/invite <note>` already tags each invite with a free-text source —
 * this is just the aggregate view across the whole cohort, grouped by
 * that existing note. No new schema: `note` was always meant to answer
 * "which source is this invite from," it just had no rollup query yet.
 */
export async function getAttributionBreakdown(): Promise<AttributionRow[]> {
  const pool = requirePool();
  const { rows } = await pool.query<{ source: string; invited: string; activated: string; paired: string }>(
    `SELECT
       COALESCE(note, '(no note)') AS source,
       COUNT(*) AS invited,
       COUNT(*) FILTER (WHERE status <> 'invited') AS activated,
       COUNT(*) FILTER (WHERE status IN ('paired', 'active')) AS paired
     FROM invites
     GROUP BY note
     ORDER BY COUNT(*) DESC`,
  );
  return rows.map((r) => ({ source: r.source, invited: Number(r.invited), activated: Number(r.activated), paired: Number(r.paired) }));
}

export async function suspendInviteForUser(userId: number): Promise<boolean> {
  const pool = requirePool();
  const { rowCount } = await pool.query(`UPDATE invites SET status = 'suspended' WHERE user_id = $1`, [userId]);
  return (rowCount ?? 0) > 0;
}
