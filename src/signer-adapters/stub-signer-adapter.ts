import { randomUUID, createHash } from "node:crypto";
import type { AuthorityStatus, ProvisionedAuthority, SignedTransaction, SignerPort, TradePolicyContext } from "../signer-port.js";

/**
 * TEST-ONLY. Do not import this from src/index.ts, src/server.ts, or any
 * other production wiring — it exists so wallet_accounts/users domain code
 * can be exercised end-to-end without a real vendor account.
 *
 * It deliberately does NOT generate a real Solana keypair or produce a
 * real base58 pubkey: `publicKey` is an obviously-fake placeholder, never
 * something that could be mistaken for a real address or accidentally
 * receive real funds. It does not enforce `policyContext` beyond checking
 * `maxLamports` against a value encoded in the fake transaction bytes —
 * that check exists only to prove the call shape works, not as a stand-in
 * for a real policy engine. A real adapter (Turnkey/Privy) is the actual
 * enforcement point; this stub is not evidence that policy enforcement
 * works, only that the domain code calling SignerPort is wired correctly.
 */
export class StubSignerAdapter implements SignerPort {
  private readonly authorities = new Map<string, { userId: number; status: AuthorityStatus }>();

  async provisionAuthority(userId: number): Promise<ProvisionedAuthority> {
    const authorityRef = `stub:${randomUUID()}`;
    this.authorities.set(authorityRef, { userId, status: "active" });
    return { publicKey: `STUB_NOT_A_REAL_ADDRESS_${randomUUID()}`, authorityRef };
  }

  async signTransaction(input: {
    authorityRef: string;
    serializedTransaction: Uint8Array;
    policyContext: TradePolicyContext;
  }): Promise<SignedTransaction> {
    const authority = this.authorities.get(input.authorityRef);
    if (!authority) throw new Error(`unknown authorityRef: ${input.authorityRef}`);
    if (authority.status !== "active") throw new Error(`authority is ${authority.status}, cannot sign`);
    if (input.policyContext.maxLamports <= 0n) throw new Error("policyContext.maxLamports must be positive");

    const signature = createHash("sha256").update(input.serializedTransaction).digest("hex");
    return { signature: `stub_sig_${signature}`, serializedTransaction: input.serializedTransaction };
  }

  async suspendAuthority(authorityRef: string): Promise<void> {
    const authority = this.mustGet(authorityRef);
    authority.status = "suspended";
  }

  async restoreAuthority(authorityRef: string): Promise<void> {
    const authority = this.mustGet(authorityRef);
    if (authority.status === "revoked") throw new Error("cannot restore a revoked authority");
    authority.status = "active";
  }

  async revokeAuthority(authorityRef: string): Promise<void> {
    const authority = this.mustGet(authorityRef);
    authority.status = "revoked";
  }

  async getAuthorityStatus(authorityRef: string): Promise<AuthorityStatus> {
    return this.authorities.get(authorityRef)?.status ?? "unknown";
  }

  private mustGet(authorityRef: string) {
    const authority = this.authorities.get(authorityRef);
    if (!authority) throw new Error(`unknown authorityRef: ${authorityRef}`);
    return authority;
  }
}
