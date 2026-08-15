import { Resend } from "resend";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import type { Lead } from "./leads.js";
import type { IssuedLicense } from "./licenses.js";

const resend = new Resend(CONFIG.RESEND_API_KEY);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const wrap = (inner: string) => `
<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0c0d;color:#e7ecef;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#11151a;border:1px solid #1f2630;border-radius:6px;overflow:hidden;">
    ${inner}
  </div>
</body></html>`;

/** Sent to the admin whenever a lead submits the form (trial or purchase intent). */
export async function sendAdminLeadNotification(lead: Lead, leadId: number): Promise<boolean> {
  const tg = lead.tg_username ? `@${lead.tg_username}` : `id:${lead.tg_user_id}`;
  const html = wrap(`
    <div style="padding:18px 22px;border-bottom:1px solid #1f2630;background:#161b22;">
      <div style="font-size:11px;letter-spacing:0.3em;color:#8a9199;text-transform:uppercase;">ARIA · NEW LEAD</div>
      <div style="font-size:20px;margin-top:4px;color:#b6ff3c;">Lead #${leadId}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:10px 22px;color:#8a9199;width:120px;">Name</td><td style="padding:10px 22px;">${escapeHtml(lead.name)}</td></tr>
      <tr><td style="padding:10px 22px;color:#8a9199;">Email</td><td style="padding:10px 22px;"><a href="mailto:${escapeHtml(lead.email)}" style="color:#6cc4ff;">${escapeHtml(lead.email)}</a></td></tr>
      <tr><td style="padding:10px 22px;color:#8a9199;">Wallet</td><td style="padding:10px 22px;font-family:monospace;word-break:break-all;">${escapeHtml(lead.wallet)}</td></tr>
      <tr><td style="padding:10px 22px;color:#8a9199;">Telegram</td><td style="padding:10px 22px;">${escapeHtml(tg)}</td></tr>
      ${lead.interest ? `<tr><td style="padding:10px 22px;color:#8a9199;">Notes</td><td style="padding:10px 22px;">${escapeHtml(lead.interest)}</td></tr>` : ""}
    </table>
  `);
  try {
    const { error } = await resend.emails.send({
      from: `ARIA Terminal <${CONFIG.FROM_EMAIL}>`,
      to: [CONFIG.ADMIN_EMAIL],
      replyTo: lead.email,
      subject: `🎯 ARIA Lead #${leadId} — ${lead.name}`,
      html,
    });
    if (error) { logger.error({ error, leadId }, "admin lead email failed"); return false; }
    return true;
  } catch (err) {
    logger.error({ err, leadId }, "admin lead email threw");
    return false;
  }
}

/** Sent to the customer with their signed license — trial or paid, same template. */
export async function sendLicenseEmail(lead: Lead, license: IssuedLicense): Promise<boolean> {
  // "trial" is the internal DB/license key for the (now permanently free)
  // default tier — never show that word to users, who'd read it as time-limited.
  const tierLabel = license.tier === "trial" ? "FREE" : license.tier.toUpperCase();
  const expiresDate = new Date(license.expiresAt).toISOString().slice(0, 10);
  const html = wrap(`
    <div style="padding:22px;border-bottom:1px solid #1f2630;">
      <div style="font-size:11px;letter-spacing:0.3em;color:#8a9199;text-transform:uppercase;">ARIA · LICENSE ISSUED</div>
      <div style="font-size:22px;margin-top:6px;color:#b6ff3c;">${tierLabel} — active, no fees</div>
    </div>
    <div style="padding:22px;line-height:1.6;font-size:14px;">
      <p>Hi ${escapeHtml(lead.name.split(" ")[0] ?? lead.name)},</p>
      <p>Your ARIA ${tierLabel} license is ready — full features, free, no pricing tiers. It expires <strong>${expiresDate}</strong> and is bound to wallet
        <code style="color:#8a9199;">${escapeHtml(lead.wallet.slice(0, 8))}…${escapeHtml(lead.wallet.slice(-4))}</code>.</p>
      <p style="margin-top:20px;color:#8a9199;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;">Your license key</p>
      <div style="background:#07090a;border:1px solid #2a3340;border-radius:2px;padding:14px;font-family:monospace;font-size:12px;word-break:break-all;color:#e7ecef;">
        ${escapeHtml(license.token)}
      </div>
      <p style="margin-top:20px;">Install:</p>
      <ol style="color:#e7ecef;line-height:1.8;">
        <li>Open your sniper's <code>.env</code> file</li>
        <li>Add: <code>ARIA_LICENSE=${escapeHtml(license.token.slice(0, 24))}...</code></li>
        <li>Restart the sniper</li>
        <li>First log line should read: <code>License OK · ${tierLabel} · exp ${expiresDate}</code></li>
      </ol>
      <p style="color:#ffb547;font-size:12px;border-top:1px solid #1f2630;padding-top:14px;margin-top:24px;">
        <strong>RISK NOTICE:</strong> Sniping newly launched tokens is highly speculative. Most tokens lose all value.
        ARIA never asks for your private key, seed phrase, or password — in this email, in Telegram, or anywhere else.
      </p>
    </div>
  `);
  try {
    const { error } = await resend.emails.send({
      from: `ARIA Terminal <${CONFIG.FROM_EMAIL}>`,
      to: [lead.email],
      subject: `Your ARIA ${tierLabel} license`,
      html,
    });
    if (error) { logger.error({ error }, "license email failed"); return false; }
    return true;
  } catch (err) {
    logger.error({ err }, "license email threw");
    return false;
  }
}
