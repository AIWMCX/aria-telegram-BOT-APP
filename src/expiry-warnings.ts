/**
 * Automated license-expiry warnings — the "no automated expiry warnings"
 * gap: a DM at 7 days and 1 day before a license expires. Each license
 * is warned at most once per tier (warned_7d/warned_1d on the licenses
 * table), so a warning is never repeated on every interval tick.
 */
import { db } from "./db.js";
import { logger } from "./logger.js";
import { getLeadById } from "./leads.js";
import { notifyCustomerOfExpiryWarning } from "./bot.js";

interface ExpiringLicenseRow {
  id: string;
  lead_id: number;
  tier: string;
  expires_at: string;
}

// Only revoked = 0, not-yet-warned, and genuinely still in the future —
// an already-expired license needs no "expires soon" warning, it needs
// nothing (or a separate "has expired" notice, which is out of scope
// here — this module only covers the two warnings explicitly requested).
const find7dStmt = db.prepare(`
  SELECT id, lead_id, tier, expires_at FROM licenses
  WHERE revoked = 0 AND warned_7d = 0
    AND expires_at <= datetime('now', '+7 days') AND expires_at > datetime('now')
`);
const find1dStmt = db.prepare(`
  SELECT id, lead_id, tier, expires_at FROM licenses
  WHERE revoked = 0 AND warned_1d = 0
    AND expires_at <= datetime('now', '+1 day') AND expires_at > datetime('now')
`);
const markWarned7dStmt = db.prepare(`UPDATE licenses SET warned_7d = 1 WHERE id = ?`);
const markWarned1dStmt = db.prepare(`UPDATE licenses SET warned_1d = 1 WHERE id = ?`);

/**
 * Checks for licenses newly inside the 7-day/1-day windows and sends the
 * warning DM. The warned_* flag is set BEFORE attempting delivery,
 * deliberately: if the Telegram DM fails (bot blocked, chat never
 * started), the failure is logged but the license is still marked
 * warned — retrying every interval tick forever on a permanently
 * undeliverable chat would be a real (if harmless) resource leak, and
 * "we tried to warn them" is the honest state regardless of whether
 * delivery succeeded, same as sendLicenseEmail's own fire-and-forget
 * discipline elsewhere in this codebase.
 */
export async function checkAndSendExpiryWarnings(): Promise<{ sent7d: number; sent1d: number }> {
  let sent7d = 0;
  let sent1d = 0;

  for (const row of find7dStmt.all() as unknown as ExpiringLicenseRow[]) {
    markWarned7dStmt.run(row.id);
    const lead = getLeadById(row.lead_id);
    if (!lead) { logger.warn({ licenseId: row.id, leadId: row.lead_id }, "7d expiry warning: lead not found"); continue; }
    await notifyCustomerOfExpiryWarning(lead as any, { id: row.id, tier: row.tier, expiresAt: row.expires_at }, 7);
    sent7d++;
  }

  for (const row of find1dStmt.all() as unknown as ExpiringLicenseRow[]) {
    markWarned1dStmt.run(row.id);
    const lead = getLeadById(row.lead_id);
    if (!lead) { logger.warn({ licenseId: row.id, leadId: row.lead_id }, "1d expiry warning: lead not found"); continue; }
    await notifyCustomerOfExpiryWarning(lead as any, { id: row.id, tier: row.tier, expiresAt: row.expires_at }, 1);
    sent1d++;
  }

  return { sent7d, sent1d };
}

/** Runs an immediate check, then on a fixed interval — never lets a check failure (a bad DB state, a bug) kill the interval or the process; the next tick just tries again. */
export function startExpiryWarningScheduler(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const { sent7d, sent1d } = await checkAndSendExpiryWarnings();
      if (sent7d > 0 || sent1d > 0) logger.info({ sent7d, sent1d }, "expiry warnings sent");
    } catch (err) {
      logger.error({ err }, "expiry warning check failed — will retry next interval");
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
