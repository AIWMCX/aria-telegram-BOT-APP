import { Bot, InlineKeyboard } from "grammy";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { totalLeads, getLatestLeadByTgUser } from "./leads.js";
import { getActiveLicenseForLead } from "./licenses.js";
import { revokeLicense } from "./licenses.js";
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

bot.command("start", async (ctx) => {
  const firstName = ctx.from?.first_name ?? "trader";
  const keyboard = new InlineKeyboard().webApp("🟢 OPEN TERMINAL", TERMINAL_URL);
  await ctx.reply(
    [
      `*ARIA · Solana Sniper Terminal*`, ``,
      `Hi ${esc(firstName)} — tap below to open the live terminal. Full access is free — no license fees, no tiers.`, ``,
      `Fill the form inside: name, email, Solana wallet. You'll get your license instantly.`, ``,
      `_Burner wallets only. We never ask for your private key._`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
});

bot.command("license", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  const lead = getLatestLeadByTgUser(tgId);
  if (!lead?.id) {
    const keyboard = new InlineKeyboard().webApp("REQUEST ACCESS", TERMINAL_URL);
    await ctx.reply("You don't have a license yet. Tap below to request one.", { reply_markup: keyboard });
    return;
  }
  const license = getActiveLicenseForLead(lead.id);
  if (!license) {
    await ctx.reply("No active license found. Your last request may have expired — request a new one.");
    return;
  }
  await ctx.reply(
    [
      `Your active license:`, ``,
      `\`${license.token}\``, ``,
      `Tier: *${tierLabel(license.tier)}*`,
      `Expires: ${license.expiresAt.slice(0, 10)}`,
      `Wallet: \`${lead.wallet}\``, ``,
      `Paste into your \`.env\` as \`ARIA_LICENSE=...\``,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
});

bot.command("status", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  const lead = getLatestLeadByTgUser(tgId);
  if (!lead?.id) { await ctx.reply("No account found yet — use /start to request access."); return; }
  const license = getActiveLicenseForLead(lead.id);
  if (!license) { await ctx.reply("No active license. Use /license to request one."); return; }
  const daysLeft = Math.ceil((new Date(license.expiresAt).getTime() - Date.now()) / 86_400_000);
  await ctx.reply(
    [
      `Tier: *${tierLabel(license.tier)}*`,
      `Days remaining: ${daysLeft}`,
      `Wallet: \`${lead.wallet}\``,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
});

bot.command("support", async (ctx) => {
  await ctx.reply("Support: reply here and we'll get back within 24h.\nDocs: " + CONFIG.PUBLIC_URL + "/docs");
});

// ── Admin-only ────────────────────────────────────────────────────────────
bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  await ctx.reply(`📊 Total leads: *${totalLeads()}*`, { parse_mode: "Markdown" });
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  const licenseId = ctx.match?.toString().trim();
  if (!licenseId) { await ctx.reply("Usage: /revoke lic_xxxxxx"); return; }
  revokeLicense(licenseId, "admin_manual");
  await ctx.reply(`Revoked ${licenseId}`);
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
