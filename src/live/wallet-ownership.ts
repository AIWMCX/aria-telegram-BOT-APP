/**
 * LIVE 0.1 §2.4 — server-side wallet ownership proof.
 *
 * WHAT THIS IS: the founder signs a server-issued challenge with their own
 * wallet, externally (Phantom's own "sign message" UI, or a CLI signing
 * tool), and pastes the resulting signature. This module re-verifies that
 * Ed25519 signature against the claimed public key before any CONNECTED
 * state is recorded. A client asserting "I connected" is not evidence; a
 * signature over a nonce ARIA issued is.
 *
 * WHAT THIS IS NOT, and must never become: a wallet adapter, a
 * WalletConnect/Reown bridge, a Telegram Mini App signing surface, or
 * anything that touches a transaction. Those are a later milestone and
 * require the empirical wallet research the spec records as P0-WALLET-1.
 *
 * KEY CUSTODY: this module accepts a base58 PUBLIC key and a signature.
 * There is no parameter, no schema field and no code path here capable of
 * receiving a private key, seed phrase, mnemonic or keypair, and
 * `WalletOwnershipProofSubmissionSchema` is `.strict()` so an unexpected
 * field is rejected rather than quietly ignored.
 *
 * Verification reuses the exact primitive src/device-auth.ts already uses —
 * node:crypto's Ed25519 verify via a JWK-imported public key. No new
 * dependency: per CLAUDE.md's convention we checked the stdlib first, and
 * the only thing it lacks is base58, which is ~20 lines below rather than a
 * package.
 */
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { z } from "zod";
import { LIVE_TIMING } from "./live-limits.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX: ReadonlyMap<string, number> = new Map(
  [...BASE58_ALPHABET].map((c, i) => [c, i]),
);

/** Throws on any character outside the base58 alphabet — never silently skips one. */
export function base58Decode(input: string): Buffer {
  if (input.length === 0) throw new Error("base58: empty input");
  const bytes: number[] = [];
  for (const char of input) {
    const value = BASE58_INDEX.get(char);
    if (value === undefined) throw new Error(`base58: invalid character ${JSON.stringify(char)}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's are leading zero bytes.
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

export function base58Encode(input: Buffer): string {
  if (input.length === 0) return "";
  const digits: number[] = [];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of input) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

/**
 * The request body for a founder pasting a signature. `.strict()` is the
 * point: an extra field — including one named to carry key material —
 * fails parsing outright rather than being dropped on the floor.
 */
export const WalletOwnershipProofSubmissionSchema = z.object({
  accountId: z.string().uuid(),
  solanaPubkey: z.string().min(32).max(64),
  nonce: z.string().min(1).max(256),
  signature: z.string().min(1).max(256),
  signatureEncoding: z.enum(["base64", "base58"]),
}).strict();

export type WalletOwnershipProofSubmission = z.infer<typeof WalletOwnershipProofSubmissionSchema>;

export interface OwnershipChallenge {
  nonce: string;
  /** The exact bytes the user is told to sign. Persisted verbatim (migration column `challenge_message`). */
  message: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Builds the challenge. The message binds the account id, the claimed
 * public key and the nonce together, so a signature harvested for one
 * account or one wallet cannot be presented for another.
 *
 * The nonce is supplied by the caller (from `crypto.randomBytes`) rather
 * than generated here, so this stays a pure function and the persistence
 * layer owns single-use enforcement via the DB's UNIQUE constraint. A
 * client-chosen nonce is not a challenge — callers must never pass one
 * through from a request body.
 */
export function issueOwnershipChallenge(input: {
  accountId: string;
  solanaPubkey: string;
  nonce: string;
  issuedAt: number;
}): OwnershipChallenge {
  const message = [
    "ARIA-LIVE-0.1 WALLET OWNERSHIP PROOF",
    `account:${input.accountId}`,
    `wallet:${input.solanaPubkey}`,
    `nonce:${input.nonce}`,
    `issuedAt:${input.issuedAt}`,
    "This signature proves you control this wallet. It authorizes no transfer and moves no funds.",
  ].join("\n");

  return {
    nonce: input.nonce,
    message,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + LIVE_TIMING.OWNERSHIP_NONCE_TTL_SECONDS * 1000,
  };
}

export type OwnershipVerificationFailure =
  | "PUBKEY_MALFORMED"
  | "SIGNATURE_MALFORMED"
  | "SIGNATURE_INVALID"
  | "NONCE_EXPIRED"
  | "NONCE_ALREADY_USED";

export type OwnershipVerificationResult =
  | { verified: true }
  | { verified: false; reason: OwnershipVerificationFailure };

/**
 * Re-verifies a pasted signature. Every failure path returns a specific
 * reason; none throws, and none falls through to a permissive default.
 *
 * `storedProof` is the persisted row for this nonce when the caller has
 * one. Supplying it enables the single-use and TTL checks, which run
 * BEFORE the cryptography so an expired or already-spent nonce is refused
 * even with a perfectly valid signature.
 */
export function verifyOwnershipSignature(input: {
  solanaPubkey: string;
  challengeMessage: string;
  signature: string;
  signatureEncoding: "base64" | "base58";
  storedProof?: { verifiedAt: number | null; expiresAt: number };
  now?: number;
}): OwnershipVerificationResult {
  if (input.storedProof) {
    if (input.storedProof.verifiedAt !== null) return { verified: false, reason: "NONCE_ALREADY_USED" };
    const now = input.now ?? Date.now();
    if (now > input.storedProof.expiresAt) return { verified: false, reason: "NONCE_EXPIRED" };
  }

  let rawPubkey: Buffer;
  try {
    rawPubkey = base58Decode(input.solanaPubkey);
  } catch {
    return { verified: false, reason: "PUBKEY_MALFORMED" };
  }
  if (rawPubkey.length !== 32) return { verified: false, reason: "PUBKEY_MALFORMED" };

  let rawSignature: Buffer;
  try {
    rawSignature = input.signatureEncoding === "base58"
      ? base58Decode(input.signature)
      : Buffer.from(input.signature, "base64");
  } catch {
    return { verified: false, reason: "SIGNATURE_MALFORMED" };
  }
  if (rawSignature.length !== 64) return { verified: false, reason: "SIGNATURE_MALFORMED" };

  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: rawPubkey.toString("base64url") },
      format: "jwk",
    });
    const ok = ed25519Verify(null, Buffer.from(input.challengeMessage, "utf8"), publicKey, rawSignature);
    return ok ? { verified: true } : { verified: false, reason: "SIGNATURE_INVALID" };
  } catch {
    return { verified: false, reason: "SIGNATURE_INVALID" };
  }
}
