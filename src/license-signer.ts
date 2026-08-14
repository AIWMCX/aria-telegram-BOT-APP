import { createPrivateKey, sign, randomBytes } from "node:crypto";
import { CONFIG } from "./config.js";

/**
 * License token format:  ARIA1.<base64url payload>.<base64url signature>
 * Signed with Ed25519 over the UTF-8 bytes of the base64url-encoded payload
 * (signing the encoded form, not raw JSON, avoids any whitespace/ordering
 * ambiguity between what we sign and what the client re-hashes).
 *
 * The client verifies this fully offline using only ARIA_LICENSE_PUBLIC_X —
 * no network call, matching the "no phone-home" promise in the product copy.
 */

export interface LicensePayload {
  v: 1;
  iss: "aria";
  sub: string;          // lead id, e.g. "lead_42"
  email: string;
  tg_user_id: number;
  wallet: string;
  tier: "trial" | "standard" | "pro";
  features: string[];
  limits: { maxBuySol: number; maxPositions: number; maxTotalSol: number };
  iat: number;           // unix seconds
  exp: number;           // unix seconds
  jti: string;            // unique license id, e.g. "lic_9k2j8f"
}

let cachedPrivateKey: ReturnType<typeof createPrivateKey> | null = null;

function getPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  cachedPrivateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: CONFIG.ARIA_LICENSE_PUBLIC_X, d: CONFIG.ARIA_LICENSE_PRIVATE_D },
    format: "jwk",
  });
  return cachedPrivateKey;
}

export function signLicense(payload: LicensePayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(null, Buffer.from(payloadB64, "utf8"), getPrivateKey());
  return `ARIA1.${payloadB64}.${sig.toString("base64url")}`;
}

export function newLicenseId(): string {
  return "lic_" + randomBytes(6).toString("hex");
}
