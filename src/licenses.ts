import { db } from "./db.js";
import { audit } from "./audit.js";
import { signLicense, newLicenseId, type LicensePayload } from "./license-signer.js";
import { TIER_LIMITS, type Tier } from "./config.js";
import type { Lead } from "./leads.js";

const insertStmt = db.prepare(`
  INSERT INTO licenses (id, lead_id, order_id, tier, wallet, token, expires_at)
  VALUES (@id, @lead_id, @order_id, @tier, @wallet, @token, @expires_at)
`);

const revokeStmt = db.prepare(`
  UPDATE licenses SET revoked = 1, revoked_at = datetime('now'), revoked_reason = ?
  WHERE id = ?
`);

const revokeByLeadTierStmt = db.prepare(`
  UPDATE licenses SET revoked = 1, revoked_at = datetime('now'), revoked_reason = 'superseded'
  WHERE lead_id = ? AND tier = ? AND revoked = 0
`);

const activeForLeadStmt = db.prepare(`
  SELECT * FROM licenses
  WHERE lead_id = ? AND revoked = 0 AND expires_at > datetime('now')
  ORDER BY issued_at DESC LIMIT 1
`);

export interface IssuedLicense {
  id: string;
  token: string;
  tier: Tier;
  expiresAt: string;
}

/**
 * Issue a new license for a lead. Revokes any prior active license of the
 * same tier for that lead first — one active license per tier per lead.
 */
export function issueLicense(lead: Lead & { id: number }, tier: Tier, orderId?: string): IssuedLicense {
  const cfg = TIER_LIMITS[tier];
  const now = Math.floor(Date.now() / 1000);
  const exp = now + cfg.durationDays * 86400;
  const licenseId = newLicenseId();

  const payload: LicensePayload = {
    v: 1,
    iss: "aria",
    sub: `lead_${lead.id}`,
    email: lead.email,
    tg_user_id: lead.tg_user_id,
    wallet: lead.wallet,
    tier,
    features: [...cfg.features],
    limits: { ...cfg.limits },
    iat: now,
    exp,
    jti: licenseId,
  };

  const token = signLicense(payload);
  const expiresAtIso = new Date(exp * 1000).toISOString();

  revokeByLeadTierStmt.run(lead.id, tier);
  insertStmt.run({
    id: licenseId,
    lead_id: lead.id,
    order_id: orderId ?? null,
    tier,
    wallet: lead.wallet,
    token,
    expires_at: expiresAtIso,
  });

  audit("system", "license.issued", { type: "license", id: licenseId }, { tier, leadId: lead.id, orderId });

  return { id: licenseId, token, tier, expiresAt: expiresAtIso };
}

export function revokeLicense(licenseId: string, reason: string): void {
  revokeStmt.run(reason, licenseId);
  audit("admin", "license.revoked", { type: "license", id: licenseId }, { reason });
}

export function getActiveLicenseForLead(leadId: number): IssuedLicense | undefined {
  const row = activeForLeadStmt.get(leadId) as
    | { id: string; token: string; tier: Tier; expires_at: string }
    | undefined;
  if (!row) return undefined;
  return { id: row.id, token: row.token, tier: row.tier, expiresAt: row.expires_at };
}
