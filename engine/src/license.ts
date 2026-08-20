import { createPublicKey, verify } from "node:crypto";

export interface LicenseLimits {
  maxBuySol: number;
  maxPositions: number;
  maxTotalSol: number;
}

interface LicensePayload {
  v: 1;
  iss: "aria";
  sub: string;
  email: string;
  tg_user_id: number;
  wallet: string;
  tier: "trial" | "standard" | "pro";
  features: string[];
  limits: LicenseLimits;
  iat: number;
  exp: number;
  jti: string;
}

export type LicenseResult =
  | { status: "valid"; tier: LicensePayload["tier"]; expiresAt: Date; limits: LicenseLimits }
  | { status: "expired"; tier: LicensePayload["tier"]; expiresAt: Date; limits: LicenseLimits }
  | { status: "invalid" };

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  return Buffer.from(value, "base64url");
}

function parsePayload(value: string): LicensePayload {
  const parsed: unknown = JSON.parse(decodePart(value).toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("invalid payload");
  const payload = parsed as Partial<LicensePayload>;
  if (payload.v !== 1 || payload.iss !== "aria" || typeof payload.sub !== "string" ||
      typeof payload.email !== "string" || typeof payload.tg_user_id !== "number" ||
      typeof payload.wallet !== "string" || !["trial", "standard", "pro"].includes(payload.tier ?? "") ||
      !Array.isArray(payload.features) || !payload.limits || typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" || typeof payload.jti !== "string") throw new Error("invalid payload");
  const limits = payload.limits as Partial<LicenseLimits>;
  if (![limits.maxBuySol, limits.maxPositions, limits.maxTotalSol].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw new Error("invalid limits");
  }
  return payload as LicensePayload;
}

export function validateLicense(token: string, publicKeyX: string, now: Date): LicenseResult {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "ARIA1") return { status: "invalid" };
    const [, payloadPart, signaturePart] = parts;
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyX }, format: "jwk" });
    if (!verify(null, Buffer.from(payloadPart, "utf8"), publicKey, decodePart(signaturePart))) return { status: "invalid" };
    const payload = parsePayload(payloadPart);
    const expiresAt = new Date(payload.exp * 1000);
    if (!Number.isFinite(expiresAt.getTime())) return { status: "invalid" };
    const result = { tier: payload.tier, expiresAt, limits: payload.limits } as const;
    return payload.exp * 1000 <= now.getTime() ? { status: "expired", ...result } : { status: "valid", ...result };
  } catch {
    return { status: "invalid" };
  }
}
