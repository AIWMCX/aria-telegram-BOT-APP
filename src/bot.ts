import { Bot, InlineKeyboard, type Context, type CommandContext } from "grammy";
import { CONFIG, USERS_DOMAIN_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { totalLeads, getLatestLeadByTgUser } from "./leads.js";
import { getActiveLicenseForLead } from "./licenses.js";
import { revokeLicense } from "./licenses.js";
import { upsertUserFromTelegram } from "./users.js";
import { createPairingCode } from "./engine-pairing.js";
import { setEntitlementStatus } from "./engine-entitlements.js";
import { createInvite, listInvites, redeemInvite } from "./invites.js";
import type { Lead } from "./leads.js";
import type { IssuedLicense } from "./licenses.js";

export const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);
const TERMINAL_URL = `${CONFIG.PUBLIC_URL}/`;

function isAdmin(userId: number | undefined): boolean {
  if (!userId || !CONFIG.ADMIN_TELEGRAM_CHAT_ID) return false;
  return String(userId) === CONFIG.ADMIN_TELEGRAM_CHAT_ID;
}

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/** "trial" is the internal DB/license key for the (now permanently free) default
 *  tier — never show that word to users, who'd read it as time-limited. */
function tierLabel(tier: string): string {
  return tier === "trial" ? "FREE" : tier.toUpperCase();
}

/** Never show a full wallet address in a normal chat reply — masked the same way the Mini App's existing masked/reveal-gated key field treats sensitive values. */
function maskWallet(wallet: string): string {
  if (wallet.length <= 8) return wallet;
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

bot.command("start", async (ctx) => {
  const firstName = ctx.from?.first_name ?? "trader";
  const keyboard = new InlineKeyboard().webApp("🟢 OPEN TERMINAL", TERMINAL_URL);

  // First-10 beta control: `/start <code>` (typed, or via a
  // t.me/<bot>?start=<code> deep link) redeems an invite. Silent no-op for
  // a bare /start — this never blocks the normal welcome message, since
  // the real access gate is engine pairing (server.ts), not chat itself.
  const payload = ctx.match?.trim();
  if (payload && USERS_DOMAIN_ENABLED && ctx.from) {
    try {
      const user = await upsertUserFromTelegram({
        id: ctx.from.id,
        username: ctx.from.username,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
      });
      const result = await redeemInvite(payload, user.id);
      if (result.ok) {
        await ctx.reply(result.alreadyRedeemed ? "Invite already active on this account." : "✅ Invite activated — you have free PAPER access.");
      } else if (result.reason === "user-already-has-invite") {
        await ctx.reply("This Telegram account already has an invite active.");
      } else if (result.reason === "already-claimed-by-another-user") {
        await ctx.reply("That invite link was already used by someone else.");
      } else {
        await ctx.reply("That invite link isn't valid or has expired.");
      }
    } catch (err: any) {
      logger.error({ err }, "invite redemption failed");
    }
  }

  await ctx.reply(
    [
      `*ARIA REAL-1 Terminal*`, ``,
      `Hi ${esc(firstName)} — Solana mainnet market data · Paper execution · No real orders · No custody.`, ``,
      `Fill the form inside: name, email, Solana wallet. You'll get your license instantly.`, ``,
      `_Burner wallets only. We never ask for your private key._`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
});

/**
 * A normal Telegram customer has no `.env` file and no interface to paste
 * a key into — dumping the raw bearer token into plain chat text here was
 * developer workflow leaking into the customer product (a real user-
 * reported defect: they had nowhere to "type that in"). /license is now a
 * STATUS view: activation is automatic (Telegram account = ARIA account),
 * nothing to copy, nothing to configure. The Mini App's existing
 * "existing-license-panel" (public/index.html) already does the masked/
 * reveal-gated key display correctly for anyone who needs the actual key
 * — this command no longer needs to duplicate that, badly, in plaintext.
 * Raw-token retrieval for the small audience that genuinely needs it
 * (self-hosting the separate sniper client) moves to /licensekey below,
 * explicitly labeled as an advanced/developer action.
 */
async function replyWithLicenseStatus(ctx: CommandContext<Context>): Promise<void> {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  const lead = getLatestLeadByTgUser(tgId);
  const keyboard = new InlineKeyboard().webApp("🟢 OPEN TERMINAL", TERMINAL_URL);
  if (!lead?.id) {
    await ctx.reply(
      [`*ARIA License*`, ``, `Status: _Not activated_`, ``, `Tap below — activation is automatic, no key entry required.`].join("\n"),
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().webApp("ACTIVATE FREE ACCESS", TERMINAL_URL) },
    );
    return;
  }
  const license = getActiveLicenseForLead(lead.id);
  if (!license) {
    await ctx.reply(
      [`*ARIA License*`, ``, `Status: _Expired_`, ``, `Tap below to reactivate.`].join("\n"),
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().webApp("RENEW / REACTIVATE", TERMINAL_URL) },
    );
    return;
  }
  const daysLeft = Math.max(0, Math.ceil((new Date(license.expiresAt).getTime() - Date.now()) / 86_400_000));
  await ctx.reply(
    [
      `*ARIA License*`, ``,
      `Status: *Active*`,
      `Plan: *${tierLabel(license.tier)}*`,
      `Expires: ${license.expiresAt.slice(0, 10)} (${daysLeft}d)`,
      `Wallet: \`${maskWallet(lead.wallet)}\``, ``,
      `Your Telegram account is already connected — no license key entry is required.`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
}

bot.command("license", replyWithLicenseStatus);
/** Kept as a documented alias (README/CLAUDE.md both list /status as a separate customer command) — same fixed status view, not a second unmasked implementation. */
bot.command("status", replyWithLicenseStatus);

/**
 * Advanced/developer action — the only place the raw bearer token is
 * still delivered in chat, explicitly labeled as such. Exists for the
 * real, legitimate case (self-hosting the separate sniper client, which
 * genuinely needs ARIA_LICENSE=... in its own .env) — not the default
 * customer path, which /license above now handles without ever showing
 * this.
 */
bot.command("licensekey", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  const lead = getLatestLeadByTgUser(tgId);
  if (!lead?.id) { await ctx.reply("No account found yet — use /start to request access."); return; }
  const license = getActiveLicenseForLead(lead.id);
  if (!license) { await ctx.reply("No active license found. Your last request may have expired — use /license to reactivate."); return; }
  await ctx.reply(
    [
      `*Advanced: raw license key*`, ``,
      `Only needed if you're self-hosting the separate sniper client. The Terminal Mini App does not need this.`, ``,
      `\`${license.token}\``, ``,
      `Paste into that client's \`.env\` as \`ARIA_LICENSE=...\``,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
});

/**
 * REAL-1 Task 7 — issues a device pairing code for the ARIA engine CLI.
 * Identity here comes directly from grammy's ctx.from.id, which Telegram
 * itself has already authenticated (this is a bot command, not a Mini
 * App fetch call) — no separate initData/HMAC check is needed or done,
 * unlike the HTTP API's /api/engine/pairing-code, which DOES need one
 * because a browser fetch has no inherent Telegram-verified origin.
 */
bot.command("pair", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  if (!USERS_DOMAIN_ENABLED) {
    await ctx.reply("Device pairing isn't available yet.");
    return;
  }
  try {
    const user = await upsertUserFromTelegram({
      id: tgId, username: ctx.from?.username, first_name: ctx.from?.first_name, last_name: ctx.from?.last_name,
    });
    const { code, expiresAt } = await createPairingCode(user.id);
    const expiresLabel = new Date(expiresAt).toISOString().slice(11, 16);
    await ctx.reply(
      [
        `*Pair your ARIA device*`, ``,
        `Run this on the computer running ARIA:`, ``,
        `\`aria pair ${esc(code)}\``, ``,
        `Expires ${expiresLabel} UTC (10 minutes) — single use. Run \`/pair\` again if it expires.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    logger.error({ err }, "pair command failed");
    await ctx.reply("Pairing service temporarily unavailable. Try again shortly.");
  }
});

bot.command("support", async (ctx) => {
  // Was pointing at PUBLIC_URL + "/docs", a route that has never existed —
  // every tap 404'd. Points at the real Terms/Privacy/Risk/Refund/Support
  // section actually on the Mini App page (public/index.html's #legal).
  await ctx.reply("Support: reply here and we'll get back within 24h.\nTerms, privacy, risk disclosure & support info: " + CONFIG.PUBLIC_URL + "/#legal");
});

bot.command("help", async (ctx) => {
  const keyboard = new InlineKeyboard().webApp("🟢 OPEN TERMINAL", TERMINAL_URL);
  await ctx.reply(
    [
      `*ARIA — commands*`, ``,
      `/start — open the terminal, get access`,
      `/license (or /status) — your current plan and expiry`,
      `/pair — get a code to connect your local ARIA engine`,
      `/support — contact us, terms & risk disclosure`,
      `/help — this message`, ``,
      `Everything else — pairing, PAPER trading, journal, replay — happens inside the terminal.`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
});

// ── Admin-only ────────────────────────────────────────────────────────────
bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  await ctx.reply(`📊 Total leads: *${totalLeads()}*`, { parse_mode: "Markdown" });
});

/** First-10 beta control — issues a new invite and returns a ready-to-forward deep link. `note` is for the owner's own bookkeeping only (e.g. a name), never shown to the invitee. */
bot.command("invite", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const note = ctx.match?.toString().trim() || undefined;
  const { code } = await createInvite(note);
  const link = `https://t.me/${ctx.me.username}?start=${code}`;
  await ctx.reply(
    [`✅ Invite created${note ? ` (${esc(note)})` : ""}`, ``, `Send this link:`, link].join("\n"),
    { parse_mode: "Markdown" },
  );
});

bot.command("invites", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const invites = await listInvites();
  if (invites.length === 0) { await ctx.reply("No invites yet."); return; }
  const lines = invites.map((i) => `${i.status.padEnd(10)} ${i.note ?? "(no note)"} ${i.user_id ? `— user ${i.user_id}` : ""}`);
  await ctx.reply(["*Invites (newest first)*", "```", ...lines, "```"].join("\n"), { parse_mode: "Markdown" });
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const licenseId = ctx.match?.toString().trim();
  if (!licenseId) { await ctx.reply("Usage: /revoke lic_xxxxxx"); return; }
  revokeLicense(licenseId, "admin_manual");
  await ctx.reply(`Revoked ${licenseId}`);
});

/**
 * REAL-1 blocker #3 — the actual trigger for the entitlement-revocation
 * propagation this task built. A DIFFERENT product from /revoke above
 * (that revokes the legacy license product's SQLite-backed license; this
 * revokes an ARIA engine entitlement, engine_entitlements in Postgres).
 * Propagation itself is automatic from here — the next time the paired
 * engine syncs (even a bare heartbeat), /api/engine/sync's response
 * reflects the new status live; no separate command needs to be enqueued
 * for this specific effect.
 */
bot.command("revokeengine", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const entitlementId = ctx.match?.toString().trim();
  if (!entitlementId) { await ctx.reply("Usage: /revokeengine <entitlement-uuid>"); return; }
  try {
    await setEntitlementStatus(entitlementId, "revoked");
    await ctx.reply(`Revoked engine entitlement ${entitlementId}. Takes effect on the device's next sync.`);
  } catch (err) {
    logger.error({ err, entitlementId }, "revokeengine command failed");
    await ctx.reply("Failed to revoke — check logs.");
  }
});

bot.on("message", async (ctx) => {
  if (ctx.message.text?.startsWith("/")) return;
  const keyboard = new InlineKeyboard().webApp("OPEN TERMINAL", TERMINAL_URL);
  await ctx.reply("Open the terminal to request access:", { reply_markup: keyboard });
});

bot.catch((err) => {
  logger.error({ err: err.error, update: err.ctx.update.update_id }, "bot error");
});

/** DM the admin whenever a license is issued (signup, purchase, or renewal). */
export async function notifyAdminOfLicense(lead: Lead, license: IssuedLicense, kind: "trial" | "paid" | "renewed"): Promise<void> {
  if (!CONFIG.ADMIN_TELEGRAM_CHAT_ID) return;
  const label = { trial: "🆓 Free signup", paid: "💰 PAID", renewed: "🔁 Renewed" }[kind];
  const text = [
    `${label} · \`${tierLabel(license.tier)}\` · lic \`${license.id}\``, ``,
    `Name: ${esc(lead.name)}`,
    `Email: \`${esc(lead.email)}\``,
    `Wallet: \`${esc(lead.wallet)}\``,
  ].join("\n");
  try {
    await bot.api.sendMessage(CONFIG.ADMIN_TELEGRAM_CHAT_ID, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.warn({ err }, "admin license DM failed (non-fatal)");
  }
}

/**
 * DM the CUSTOMER their license, then immediately follow with a $RYPTO$ join
 * prompt — fired only after they've received real value (license issued),
 * never before. No-op if RYPTO_CHANNEL_URL isn't set.
 */
export async function notifyCustomerLicenseIssued(lead: Lead, license: IssuedLicense): Promise<void> {
  const expiresDate = license.expiresAt.slice(0, 10);
  const text = [
    `Your ARIA *${tierLabel(license.tier)}* license is active — full features, free.`, ``,
    `Expires: ${expiresDate}`,
    `Wallet: \`${esc(lead.wallet)}\``, ``,
    `Full key + install steps are in your email. Use /license here anytime to see it again.`,
  ].join("\n");
  try {
    await bot.api.sendMessage(lead.tg_user_id, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.warn({ err }, "customer license DM failed — they may not have started the bot chat");
    return; // don't send the follow-up if the first message failed
  }

  if (!CONFIG.RYPTO_CHANNEL_URL) return;
  try {
    const keyboard = new InlineKeyboard().url("JOIN $RYPTO$", CONFIG.RYPTO_CHANNEL_URL);
    await bot.api.sendMessage(
      lead.tg_user_id,
      "While you're set up — $RYPTO$ is where trade calls, updates, and other holders hang out.",
      { reply_markup: keyboard },
    );
  } catch (err) {
    logger.warn({ err }, "rypto redirect DM failed (non-fatal)");
  }
}

/** DM the customer that their license was revoked because Stripe reported a refund on their payment. Fired from the charge.refunded webhook handler — see stripe.ts. */
export async function notifyCustomerOfRefundRevocation(lead: Lead, license: { id: string; tier: string }): Promise<void> {
  const text = [
    `Your ARIA *${tierLabel(license.tier)}* license was revoked following a refund on your payment.`, ``,
    `If this wasn't expected, reply here or use /support.`,
  ].join("\n");
  try {
    await bot.api.sendMessage(lead.tg_user_id, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.warn({ err }, "refund-revocation DM failed (non-fatal) — they may not have started the bot chat");
  }
}

/** DM the admin whenever a refund triggers an automatic license revocation — the one billing event that removes paid access, worth a real-time heads-up rather than only being discoverable via audit_log. */
export async function notifyAdminOfRefundRevocation(lead: Lead, license: { id: string; tier: string }, chargeId: string): Promise<void> {
  if (!CONFIG.ADMIN_TELEGRAM_CHAT_ID) return;
  const text = [
    `↩️ Refund → auto-revoked · \`${tierLabel(license.tier)}\` · lic \`${license.id}\``, ``,
    `Name: ${esc(lead.name)}`,
    `Email: \`${esc(lead.email)}\``,
    `Stripe charge: \`${esc(chargeId)}\``,
  ].join("\n");
  try {
    await bot.api.sendMessage(CONFIG.ADMIN_TELEGRAM_CHAT_ID, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.warn({ err }, "admin refund-revocation DM failed (non-fatal)");
  }
}

/** DM the customer that their license expires soon (7 days or 1 day out — see expiry-warnings.ts). Sent at most once per warning tier per license (warned_7d/warned_1d gate this at the caller). */
export async function notifyCustomerOfExpiryWarning(lead: Lead, license: { id: string; tier: string; expiresAt: string }, daysRemaining: 7 | 1): Promise<void> {
  const when = daysRemaining === 1 ? "tomorrow" : `in ${daysRemaining} days`;
  const text = [
    `Your ARIA *${tierLabel(license.tier)}* license expires ${when} (${license.expiresAt.slice(0, 10)}).`, ``,
    `Use /license here to check your current status, or renew before it lapses to avoid a gap in access.`,
  ].join("\n");
  try {
    await bot.api.sendMessage(lead.tg_user_id, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.warn({ err }, "expiry-warning DM failed (non-fatal) — they may not have started the bot chat");
  }
}
