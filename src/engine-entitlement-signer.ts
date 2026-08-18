import { createPrivateKey, sign as ed25519Sign } from "node:crypto";
import { CONFIG, ENTITLEMENT_ISSUANCE_ENABLED } from "./config.js";

/**
 * ARIAE1 entitlement issuance — the control-plane half of the offline
 * verifier already shipped in aria-engine's src/entitlement.ts (Task 2).
 * The token format here MUST exactly match that verifier: prefix
 * "ARIAE1", payload base64url(JSON), signature = Ed25519 over the
 * PAYLOAD STRING'S UTF-8 BYTES (not the raw JSON bytes) — same pattern
 * as this repo's own license-signer.ts. Any divergence here silently
 * breaks every engine's ability to verify a real entitlement.
 *
 * This is the ONLY file in this repo allowed to hold
 * ARIA_ENTITLEMENT_PRIVATE_D. It never leaves this process — aria-engine
 * only ever receives a signed TOKEN, never the key that signed it.
 */

const TOKEN_PREFIX = "ARIAE1";
export const REAL1_BETA_SCOPE = "real1-paper-beta" as const;
export const REAL1_BETA_DURATION_SECONDS = 7 * 24 * 60 * 60; // must equal aria-engine's REAL1_BETA_DURATION_SECONDS exactly

export interface EntitlementTokenPayload {
  v: 1;
  iss: "aria-engine";
  sub: string; // device clientId — see engine-clients.ts
  scope: typeof REAL1_BETA_SCOPE;
  iat: number;
  exp: number;
  jti: string;
}

function requireSigningKey() {
  if (!ENTITLEMENT_ISSUANCE_ENABLED) throw new Error("ARIA_ENTITLEMENT_PRIVATE_D/PUBLIC_X not configured — entitlement issuance unavailable");
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: CONFIG.ARIA_ENTITLEMENT_PUBLIC_X, d: CONFIG.ARIA_ENTITLEMENT_PRIVATE_D },
    format: "jwk",
  });
}

/** Issues a signed 7-day paper-beta entitlement token bound to a specific paired device (`clientId`). */
export function issueReal1BetaEntitlementToken(clientId: string, jti: string): { token: string; issuedAt: number; expiresAt: number } {
  const privateKey = requireSigningKey();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + REAL1_BETA_DURATION_SECONDS;

  const payload: EntitlementTokenPayload = { v: 1, iss: "aria-engine", sub: clientId, scope: REAL1_BETA_SCOPE, iat, exp, jti };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = ed25519Sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  const token = `${TOKEN_PREFIX}.${payloadB64}.${signature.toString("base64url")}`;

  return { token, issuedAt: iat, expiresAt: exp };
}
