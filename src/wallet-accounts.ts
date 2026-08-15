import { pgPool } from "./db-pg.js";

/**
 * Wallet/trading account domain — per docs/ARIA_FUNDS_ARCHITECTURE_V1.md
 * §3b. Not called from any endpoint yet: creating a wallet_account here
 * means requesting a real signing authority from a vendor (Turnkey/Privy)
 * or an on-chain program, which doesn't exist until that integration is
 * built. This module exists so the schema and its one-active-per-user
 * invariant can be exercised and tested in isolation first.
 */
export type AuthorityModel = "delegated_vendor" | "delegated_program";
export type WalletAccountStatus = "active" | "revoked" | "suspended";

export interface WalletAccount {
  id: number;
  user_id: number;
  solana_pubkey: string;
  authority_model: AuthorityModel;
  authority_ref: string;
  status: WalletAccountStatus;
  created_at: string;
  revoked_at: string | null;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — wallet_accounts domain is unavailable");
  return pgPool;
}

/**
 * Registers a wallet account for a user against an already-provisioned
 * signer (the vendor/program call that produces solana_pubkey +
 * authority_ref happens in the caller, outside this function — this is
 * pure bookkeeping, never a signing operation). Fails on the DB's own
 * `wallet_accounts_one_active_per_user` constraint if the user already has
 * an active wallet, rather than allowing a second live signing authority.
 */
export async function createWalletAccount(input: {
  userId: number;
  solanaPubkey: string;
  authorityModel: AuthorityModel;
  authorityRef: string;
}): Promise<WalletAccount> {
  const pool = requirePool();
  const { rows } = await pool.query<WalletAccount>(
    `INSERT INTO wallet_accounts (user_id, solana_pubkey, authority_model, authority_ref)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.userId, input.solanaPubkey, input.authorityModel, input.authorityRef],
  );
  return rows[0]!;
}

export async function getActiveWalletAccountForUser(userId: number): Promise<WalletAccount | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<WalletAccount>(
    `SELECT * FROM wallet_accounts WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return rows[0];
}

/**
 * Revokes a wallet account's bookkeeping row. Does NOT itself revoke
 * signing authority at the vendor/program — the caller must do that first
 * (via SignerPort.revokeAuthority, not yet built) and only mark this row
 * revoked once that's confirmed, so this table never claims a wallet is
 * revoked when the real signing authority might still be live.
 */
export async function revokeWalletAccount(id: number): Promise<void> {
  const pool = requirePool();
  await pool.query(
    `UPDATE wallet_accounts SET status = 'revoked', revoked_at = now() WHERE id = $1`,
    [id],
  );
}
