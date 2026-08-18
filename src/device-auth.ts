import { createPublicKey, verify as ed25519Verify } from "node:crypto";

/**
 * REAL-1 Task 4 — device authentication ONLY. This module verifies that a
 * sync request genuinely came from a paired engine client's local device
 * key, and that it isn't a replay. It has nothing to do with, and must
 * never be extended toward, Solana wallet signing:
 *
 *   DeviceAuthIdentity (this file, and aria-engine's mirror of it) ≠
 *   WalletSigner (does not exist in this repo at all — that concept lives
 *   entirely behind aria-engine's SignerPort, gated on the vendor
 *   integration decided in docs/ARIA_FUNDS_ARCHITECTURE_V1.md §2a).
 *
 * The device's Ed25519 keypair authenticates HTTP requests to this
 * control plane. It never signs a Solana transaction, never touches a
 * Solana keypair, and this module contains no such capability.
 */

/** Clock-skew tolerance for the timestamp in a signed sync envelope. The
 * PRIMARY replay defense is the monotonic sequence number (unbounded, see
 * engine-clients.ts's atomicAdvanceSequence) — this window is a secondary
 * defense limiting how long a validly-signed-but-unused envelope stays
 * theoretically presentable at all. */
export const REPLAY_WINDOW_SECONDS = 300;

export interface SyncPayload {
  kind: "heartbeat";
}

/**
 * The exact byte sequence both repos sign/verify. Deliberately a plain
 * delimited string, not JSON — JSON key ordering is not guaranteed
 * canonical, and getting this wrong silently breaks cross-repo signature
 * verification. If `SyncPayload` ever grows beyond a single literal kind,
 * this function (and aria-engine's copy of it) must change together, in
 * the same reviewed change — that coupling is the real risk this
 * docblock exists to flag.
 */
export function canonicalSyncMessage(
  clientId: string,
  sequence: number,
  timestampSeconds: number,
  payload: SyncPayload,
): string {
  return `ARIAE1-SYNC.${clientId}.${sequence}.${timestampSeconds}.${payload.kind}`;
}

export function isTimestampWithinReplayWindow(timestampSeconds: number, nowSeconds: number): boolean {
  return Math.abs(nowSeconds - timestampSeconds) <= REPLAY_WINDOW_SECONDS;
}

/** `devicePublicKeyX` is the JWK "x" value (base64url, raw 32-byte Ed25519 public key) — same encoding convention as ARIA_LICENSE_PUBLIC_X and the entitlement verifier's publicKeyX. */
export function verifyDeviceSignature(devicePublicKeyX: string, message: string, signatureB64Url: string): boolean {
  try {
    const pubKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: devicePublicKeyX }, format: "jwk" });
    return ed25519Verify(null, Buffer.from(message, "utf8"), pubKey, Buffer.from(signatureB64Url, "base64url"));
  } catch {
    return false;
  }
}
