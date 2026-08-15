/**
 * The one contract every part of ARIA is allowed to depend on for signing.
 * Nothing outside a `*SignerAdapter` implementation may import a vendor SDK
 * (Turnkey, Privy, ...) directly — this is what keeps ARIA portable across
 * vendors and keeps a self-built program (§2a) a drop-in replacement later
 * instead of a rewrite. See docs/ARIA_FUNDS_ARCHITECTURE_V1.md §2a.
 *
 * No implementation exists yet. This interface is the acceptance-gate
 * checklist from the last session turn made concrete: an adapter that
 * implements this fully has, by construction, per-user authority,
 * suspend/restore/revoke, and status introspection. Program allowlisting,
 * amount caps, and audit trail live inside `TradePolicyContext` and each
 * adapter's own policy translation — this interface defines the shape,
 * not the policy engine itself.
 */

export interface TradePolicyContext {
  userId: number;
  /** Program IDs this specific transaction is allowed to invoke. */
  allowedProgramIds: string[];
  /** Max lamports this single transaction may move. */
  maxLamports: bigint;
  /** SPL mints this transaction is allowed to touch, if any. */
  allowedMints?: string[];
  /** Opaque idempotency key — an adapter that supports request dedup should honor it. */
  idempotencyKey: string;
}

export type AuthorityStatus = "active" | "suspended" | "revoked" | "unknown";

export interface SignedTransaction {
  signature: string;
  serializedTransaction: Uint8Array;
}

export interface ProvisionedAuthority {
  publicKey: string;
  /** Opaque to everything outside the adapter — see wallet_accounts.authority_ref. */
  authorityRef: string;
}

export interface SignerPort {
  /** Provisions a new per-user signing authority. Never returns a private key. */
  provisionAuthority(userId: number): Promise<ProvisionedAuthority>;

  /**
   * Requests a signature for an already-constructed, unsigned transaction.
   * The adapter — not the caller — is the enforcement point for
   * `policyContext`: a compliant adapter rejects a transaction that
   * violates it rather than trusting the caller to have checked first.
   */
  signTransaction(input: {
    authorityRef: string;
    serializedTransaction: Uint8Array;
    policyContext: TradePolicyContext;
  }): Promise<SignedTransaction>;

  /** Reversible: pauses signing without destroying the authority. */
  suspendAuthority(authorityRef: string): Promise<void>;

  /** Reverses `suspendAuthority`. */
  restoreAuthority(authorityRef: string): Promise<void>;

  /** Irreversible: signing is permanently disabled for this authority. */
  revokeAuthority(authorityRef: string): Promise<void>;

  /** Ground truth for the authority's current state — never inferred from local DB alone. */
  getAuthorityStatus(authorityRef: string): Promise<AuthorityStatus>;
}
