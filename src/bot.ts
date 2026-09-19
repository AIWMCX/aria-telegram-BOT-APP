import { Bot, InlineKeyboard, type Context, type CommandContext } from "grammy";
import { randomUUID } from "node:crypto";
import { CONFIG, USERS_DOMAIN_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { totalLeads, getLatestLeadByTgUser } from "./leads.js";
import { getActiveLicenseForLead } from "./licenses.js";
import { revokeLicense } from "./licenses.js";
import { upsertUserFromTelegram, getUserByTelegramId, setNotifyEngineOffline } from "./users.js";
import { createPairingCode } from "./engine-pairing.js";
import { setEntitlementStatus } from "./engine-entitlements.js";
import { createInvite, listInvites, redeemInvite, isUserApproved, getAttributionBreakdown } from "./invites.js";
import { getNotifyPromotions, setNotifyPromotions } from "./leads.js";
import { trackEvent, getFunnelCounts } from "./funnel.js";
import { listRecentFeedback } from "./feedback.js";
import { registerClient, getLatestActiveClientForUser, setHostingMode, rotateClientDeviceIdentityAndSetHosted, type EngineClient } from "./engine-clients.js";
import { fleetManager, tenantRuntimeDir } from "./fleet/instance.js";
import { generateHostedDeviceIdentity, writeHostedDeviceIdentityToDisk } from "./fleet/hosted-device-identity.js";
import { handlePaperStart, handlePaperStop, handlePaperStatus, formatHostedStatusMessage, type HostedCommandsDeps } from "./fleet/hosted-commands.js";
import type { Lead } from "./leads.js";
import type { IssuedLicense } from "./licenses.js";

export const bot = new Bot(CONFIG.TELEGRAM_BOT_TOKEN);
const TERMINAL_URL = `${CONFIG.PUBLIC_URL}/`;

// One ID per process boot — correlates every TELEGRAM_UPDATE_RECEIVED line
// in this process's lifetime, same purpose as index.ts's separate
// botProcessId for the polling-lifecycle logs (kept independent rather
// than threaded across modules, since both are stable for the whole
// process and either alone is enough to tell processes apart).
const processBootId = randomUUID();

/**
 * 2026-09-04 — added after a real debugging dead-end: the owner saw no
 * reply to /invite and couldn't tell whether the update never reached
 * this process (Telegram polling incident) or reached it and was
 * silently rejected (isAdmin() returning false, or any other reason).
 * Logs EVERY update (not just commands) with Telegram's own update_id —
 * lets a P0-A delivery test compare what Telegram sent against what
 * this process actually saw, and spot gaps/duplicates in update_id
 * sequence, not just count missing replies. A Telegram user ID is not a
 * secret (about as sensitive as a username) — safe to log; no message
 * text beyond the command name is captured.
 */
bot.use(async (ctx, next) => {
  const command = ctx.message?.text?.startsWith("/") ? ctx.message.text.split(/[\s@]/)[0] : undefined;
  logger.info(
    { updateId: ctx.update.update_id, command, telegramUserId: ctx.from?.id, processBootId, receivedAt: new Date().toISOString() },
    "TELEGRAM_UPDATE_RECEIVED",
  );
  await next();
});

function isAdmin(userId: number | undefined): boolean {
  if (!userId || !CONFIG.ADMIN_TELEGRAM_CHAT_ID) return false;
  return String(userId) === CONFIG.ADMIN_TELEGRAM_CHAT_ID;
}

/** Unauthorized admin-command attempts must never fail silently — a silent no-op is indistinguishable from the update never arriving at all (e.g. during the Telegram polling incident), which cost real debugging time on 2026-09-04. */
async function requireAdmin(ctx: CommandContext<Context>, command: string): Promise<boolean> {
  if (isAdmin(ctx.from?.id)) return true;
  logger.warn({ telegramUserId: ctx.from?.id, command }, "unauthorized admin command attempt");
  await ctx.reply("This command is available to the ARIA beta administrator only.");
  return false;
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
    // 2026-09-04: this command called createPairingCode() directly, bypassing
    // the invite gate added to /api/engine/pairing-code (server.ts) —
    // an uninvited user typing /pair got a real code. Same check, same path.
    if (!(await isUserApproved(user.id))) {
      await ctx.reply("ARIA is in a controlled first-beta right now — ask the person who told you about it for an invite link.");
      return;
    }
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

/**
 * Hosted PAPER Engine, Task 4 — creates a brand-new hosted-only
 * `engine_clients` row for a user who has NEVER run `aria pair <code>`
 * locally. Per the wider product direction (no terminal, no local pairing
 * step required for hosted PAPER), `/paper_start` must be able to work for
 * such a user on its own.
 *
 * `device_public_key` is NOT NULL UNIQUE — see
 * src/fleet/hosted-device-identity.ts's docblock for the full reasoning on
 * why a REAL Ed25519 keypair is generated here (matching aria-engine's own
 * local-keystore.ts contract) rather than a synthetic placeholder string:
 * a placeholder can't ever produce a valid device signature, which would
 * silently break the hosted engine's very first sync call. The keypair is
 * generated here (not inside hosted-device-identity.ts) so the SAME
 * `publicKeyX` is used for both the DB row and the pre-seeded identity
 * file, with the DB insert happening first — the identity file is written
 * to the tenant's runtime directory only once we have the real
 * `client.id` the Fleet Manager will use as that directory's name.
 */
async function registerHostedClient(userId: number): Promise<EngineClient> {
  const identity = generateHostedDeviceIdentity();

  const client = await registerClient({
    userId,
    devicePublicKey: identity.publicKeyX,
    deviceName: "Hosted PAPER (ARIA-managed)",
    platform: "hosted",
  });
  // Disk write BEFORE the hosting_mode commit — see the Task 4 SECOND REVIEW
  // FIX (2026-09-18) docblock on convertClientToHosted below for the full
  // crash-safety reasoning (the `registerClient` INSERT above is the
  // exception among the two flows here: `hosting_mode` defaults to 'local'
  // at INSERT time per the migration, so this INSERT alone can never put a
  // half-provisioned row into `hosting_mode: 'hosted'` — only the
  // `setHostingMode` call directly below can. If the process dies between
  // the INSERT and here, the row exists with `hosting_mode: 'local'`, which
  // is exactly the state `startHostedEngine`'s `!client` branch does NOT
  // match — but its `else if (client.hosting_mode !== "hosted")` branch
  // DOES, so a retry runs `convertClientToHosted` on this same row, not a
  // second `registerHostedClient` — self-healing, not a duplicate row).
  writeHostedDeviceIdentityToDisk(tenantRuntimeDir(client.id), identity);
  await setHostingMode(client.id, "hosted");
  return { ...client, hosting_mode: "hosted" };
}

/**
 * Hosted PAPER Engine, Task 4 REVIEW FIX (2026-09-18) — the real
 * implementation behind `HostedCommandsDeps.convertClientToHosted` (see that
 * interface field's docblock in hosted-commands.ts for the full bug writeup,
 * and the ledger's Task 4 Log entry for the design-decision writeup on
 * rotating this row in place rather than creating a second one).
 *
 * Fixes a real P0 in commit a0c5ff5: `startHostedEngine`'s
 * `else if (client.hosting_mode !== "hosted")` branch used to call bare
 * `setHostingMode(client.id, "hosted")` — flipping the DB flag but writing
 * NOTHING to disk. That branch only runs for a client row that was
 * originally paired via the LOCAL `aria pair <code>` CLI flow, which
 * generates its keypair on the user's own machine and sends only the PUBLIC
 * key to the server — the control plane never had, and can never recover,
 * that row's private key. When `spawnTenant()` then boots the real
 * `aria-engine` CLI into a fresh, empty per-tenant runtime directory,
 * aria-engine's own `loadOrCreateDeviceIdentity()` finds no
 * `state/device-identity.json` there and silently generates a BRAND-NEW,
 * unrelated keypair — one that can never match the OLD `device_public_key`
 * already stored in this row. `spawnTenant()` succeeds and reports
 * "running", but every subsequent `/api/engine/sync` call from that hosted
 * process fails signature verification: permanently, silently, with no
 * visible error at the point of failure.
 *
 * The fix mirrors `registerHostedClient` above exactly — same
 * `generateHostedDeviceIdentity()` keypair generation, same
 * `writeHostedDeviceIdentityToDisk` call into the SAME tenant runtime
 * directory `spawnTenant()` will point `ARIA_RUNTIME_DIR` at — with one
 * difference: instead of INSERTing a new row (`registerClient`), it UPDATEs
 * this EXISTING row's `device_public_key` to match the freshly generated key
 * (`rotateClientDeviceIdentity` — `registerClient`/`registerHostedClient`
 * only ever INSERT; there was no existing UPDATE-a-key primitive).
 *
 * This is a deliberate, disclosed, one-way identity rotation: the user's
 * ORIGINAL local device identity for THIS client_id is intentionally
 * superseded. If they later run the local CLI again on their own machine
 * with that original identity, its signatures will no longer match this
 * row and it will need to re-pair via `/pair` to get a fresh row — the same
 * "no automatic path back to local" limitation `setHostingMode`'s own
 * docstring already discloses for the mode flip itself. Rotating THIS row
 * in place (rather than creating a second engine_clients row for the hosted
 * identity) was chosen because the rest of this codebase already commits to
 * "one row per user's active client, mutated in place across hosting-mode
 * transitions" — `getLatestActiveClientForUser` returns exactly one row per
 * user, and hosted-commands.test.ts's existing security-isolation contract
 * asserts `spawnTenant` is called with the SAME client id across a hosting-
 * mode transition, not a newly minted one. A second row would silently
 * violate both.
 *
 * Task 4 SECOND REVIEW FIX (2026-09-18) — reordered to disk-write-THEN-
 * DB-commit (was DB-write-then-disk-write). The original ordering committed
 * `rotateClientDeviceIdentity` (new key) and `setHostingMode` (flip to
 * "hosted") to the DB BEFORE `writeHostedDeviceIdentityToDisk` ran. If the
 * process crashed in that window (after the DB commit, before the disk
 * write landed), the row was left durably in `hosting_mode: "hosted"` with
 * a `device_public_key` that had NO corresponding identity file anywhere on
 * disk. The next `/paper_start` call's `else if (client.hosting_mode !==
 * "hosted")` guard in `startHostedEngine` would then be FALSE for that row
 * (it already reads "hosted"), so `convertClientToHosted` would never run
 * again — `spawnTenant` would be called directly against an empty runtime
 * dir, reintroducing the exact original P0 (silent, permanent sync
 * failure) under a narrow crash window instead of guaranteeing it.
 *
 * The disk write is now genuinely first, and the DB update — the durable
 * "point of no return" — happens LAST, only after `writeHostedDeviceIdentityToDisk`
 * has returned successfully (a synchronous call; if it throws — disk full,
 * permissions — this function throws before the DB call runs, so the DB is
 * provably never touched in that case). The two DB writes the old code made
 * separately (`rotateClientDeviceIdentity` then `setHostingMode`) are now
 * ONE atomic `rotateClientDeviceIdentityAndSetHosted` UPDATE (engine-clients.ts)
 * so there is no intermediate "key rotated but still local" state either —
 * this makes the whole flow self-healing under a crash on either side of
 * that single remaining boundary:
 *   - Crash after the disk write but before the DB UPDATE commits: the row
 *     is untouched — still `hosting_mode: "local"` with its ORIGINAL
 *     `device_public_key`. The next `/paper_start` call takes the exact
 *     same `else if` branch again and calls `convertClientToHosted` again
 *     from scratch: `generateHostedDeviceIdentity()` produces a fresh
 *     keypair, `writeHostedDeviceIdentityToDisk` OVERWRITES the incomplete
 *     file from the crashed attempt (safe — that file was never referenced
 *     by any committed DB row and never used for a real sync), and the one
 *     atomic UPDATE then commits the new key together with the mode flip.
 *     No leftover inconsistent state survives a retry.
 *   - Crash during/after the DB UPDATE: by then the disk file is already
 *     genuinely in place and the single UPDATE either fully committed or
 *     didn't — there is no partial-commit state to reason about.
 * See hosted-commands.test.ts's "crash-safety" block for a test that
 * genuinely exercises the first scenario (forces the DB update to throw
 * AFTER the disk write has really happened, then asserts a retry
 * self-heals).
 */
async function convertClientToHosted(clientId: string): Promise<void> {
  const identity = generateHostedDeviceIdentity();
  // Disk write first: the durable DB commit below only ever runs once the
  // identity genuinely exists on disk where spawnTenant() will look for it.
  // The DB side is ONE atomic UPDATE (rotateClientDeviceIdentityAndSetHosted)
  // rather than two sequential calls — see that function's docblock
  // (engine-clients.ts) for why a single statement is required for the
  // self-healing property to hold with no intermediate inconsistent state.
  writeHostedDeviceIdentityToDisk(tenantRuntimeDir(clientId), identity);
  await rotateClientDeviceIdentityAndSetHosted(clientId, identity.publicKeyX);
}

/**
 * Single `HostedCommandsDeps` object shared by all three hosted-PAPER
 * commands below — real Fleet Manager, real DB lookups, and the ONE place
 * the existing `try { await bot.api.sendMessage(...) } catch { logger.warn(...) }`
 * pattern (matching every `notify*` function elsewhere in this file) is
 * implemented for these commands, rather than duplicating it in each
 * handler.
 */
const hostedDeps: HostedCommandsDeps = {
  fleetManager,
  getLatestActiveClientForUser,
  registerHostedClient,
  convertClientToHosted,
  isUserApproved,
  notify: async (telegramUserId, text) => {
    try {
      await bot.api.sendMessage(telegramUserId, text, { parse_mode: "Markdown" });
    } catch (err) {
      logger.warn({ err }, "hosted PAPER command DM failed — they may not have started the bot chat");
    }
  },
};

/**
 * `/paper_start` — hosted-PAPER start. Chosen over extending `/pair`
 * (which is specifically the LOCAL-device pairing flow — a hosted tenant
 * has no local device at all) and over extending `/status` (which today
 * is the license-status view, a different concept from engine process
 * state). `paper_` prefix matches aria-engine's own `aria paper start`
 * CLI vocabulary from the design spec's Task 4 section, so a user who's
 * seen either surface recognizes the other.
 */
bot.command("paper_start", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  if (!USERS_DOMAIN_ENABLED) { await ctx.reply("Hosted PAPER isn't available yet."); return; }
  try {
    const user = await upsertUserFromTelegram({
      id: tgId, username: ctx.from?.username, first_name: ctx.from?.first_name, last_name: ctx.from?.last_name,
    });
    await handlePaperStart(hostedDeps, { telegramUserId: tgId, userId: user.id });
  } catch (err) {
    logger.error({ err }, "paper_start command failed");
    await ctx.reply("Something went wrong starting your hosted PAPER engine. Try again shortly.");
  }
});

/** `/paper_stop` — hosted-PAPER stop, wired to FleetManager.stopTenant(). */
bot.command("paper_stop", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  if (!USERS_DOMAIN_ENABLED) { await ctx.reply("Hosted PAPER isn't available yet."); return; }
  try {
    const user = await getUserByTelegramId(tgId);
    if (!user) { await ctx.reply("No account found yet — use /start first."); return; }
    await handlePaperStop(hostedDeps, { telegramUserId: tgId, userId: user.id });
  } catch (err) {
    logger.error({ err }, "paper_stop command failed");
    await ctx.reply("Something went wrong stopping your hosted PAPER engine. Try again shortly.");
  }
});

/**
 * `/paper_status` — real `TenantProcessHandle` state, never a fabricated
 * "all good". A user who never ran /paper_start gets an honest "never
 * started" (no DB lookup even needed for that case) rather than the same
 * message a stopped tenant would show.
 */
bot.command("paper_status", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  if (!USERS_DOMAIN_ENABLED) { await ctx.reply("Hosted PAPER isn't available yet."); return; }
  try {
    const user = await getUserByTelegramId(tgId);
    if (!user) {
      await hostedDeps.notify(tgId, formatHostedStatusMessage(undefined));
      return;
    }
    await handlePaperStatus(hostedDeps, { telegramUserId: tgId, userId: user.id });
  } catch (err) {
    logger.error({ err }, "paper_status command failed");
    await ctx.reply("Something went wrong checking your hosted PAPER engine status. Try again shortly.");
  }
});

bot.command("support", async (ctx) => {
  // Was pointing at PUBLIC_URL + "/docs", a route that has never existed —
  // every tap 404'd. Points at the real Terms/Privacy/Risk/Refund/Support
  // section actually on the Mini App page (public/index.html's #legal).
  if (ctx.from?.id) void trackEvent("support_opened", (await upsertUserFromTelegram({ id: ctx.from.id, username: ctx.from.username, first_name: ctx.from.first_name, last_name: ctx.from.last_name })).id);
  await ctx.reply("Support: reply here and we'll get back within 24h.\nTerms, privacy, risk disclosure & support info: " + CONFIG.PUBLIC_URL + "/#legal");
});

/**
 * Notification preferences. Two real, independently-gated categories —
 * deliberately not the original mockup's 6, since 5 of them (position
 * opened/closed, candidate detected, daily summary, market degraded)
 * have no underlying trigger anywhere in this stack. License issuance,
 * expiry warnings, and support replies are never optional — they're
 * about the user's own account state, not promotional or ambient.
 *
 *   /notifications              — show both settings
 *   /notifications on|off       — community/promo messages (legacy form, kept for compatibility)
 *   /notifications promo on|off — same, explicit form
 *   /notifications engine on|off — engine-disconnected alerts
 */
bot.command("notifications", async (ctx) => {
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;
  const parts = (ctx.match?.toString().trim().toLowerCase() ?? "").split(/\s+/).filter(Boolean);
  const [first, second] = parts;

  if (first === "on" || first === "off") {
    const changed = setNotifyPromotions(tgUserId, first === "on");
    await ctx.reply(changed
      ? `Community/promo messages: *${first.toUpperCase()}*.`
      : "No account found yet — get your free license first (/start), then this setting applies.",
      { parse_mode: "Markdown" });
    return;
  }
  if (first === "promo" && (second === "on" || second === "off")) {
    const changed = setNotifyPromotions(tgUserId, second === "on");
    await ctx.reply(changed
      ? `Community/promo messages: *${second.toUpperCase()}*.`
      : "No account found yet — get your free license first (/start), then this setting applies.",
      { parse_mode: "Markdown" });
    return;
  }
  if (first === "engine" && (second === "on" || second === "off")) {
    if (!USERS_DOMAIN_ENABLED) { await ctx.reply("Engine account service not yet available."); return; }
    const changed = await setNotifyEngineOffline(tgUserId, second === "on");
    await ctx.reply(changed
      ? `Engine-disconnected alerts: *${second.toUpperCase()}*.`
      : "No paired-engine account found yet — pair a device first, then this setting applies.",
      { parse_mode: "Markdown" });
    return;
  }

  const promo = getNotifyPromotions(tgUserId);
  let engineStatus = "unavailable — no paired-engine account yet";
  if (USERS_DOMAIN_ENABLED) {
    const user = await getUserByTelegramId(tgUserId);
    if (user) engineStatus = user.notify_engine_offline ? "ON" : "OFF";
  }
  await ctx.reply(
    [
      `Community/promo messages (the $RYPTO$ join prompt): *${promo ? "ON" : "OFF"}*`,
      `Engine-disconnected alerts: *${engineStatus}*`, ``,
      `/notifications promo on|off`,
      `/notifications engine on|off`, ``,
      `This never affects your license, expiry warnings, or support replies — those always reach you.`,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
});

bot.command("help", async (ctx) => {
  const keyboard = new InlineKeyboard().webApp("🟢 OPEN TERMINAL", TERMINAL_URL);
  await ctx.reply(
    [
      `*ARIA — commands*`, ``,
      `/start — open the terminal, get access`,
      `/license (or /status) — your current plan and expiry`,
      `/pair — get a code to connect your local ARIA engine`,
      `/paper_start — start your PAPER engine on ARIA's infrastructure (no local install needed)`,
      `/paper_stop — stop your hosted PAPER engine`,
      `/paper_status — check your hosted PAPER engine's status`,
      `/support — contact us, terms & risk disclosure`,
      `/notifications — manage promo/engine-alert preferences`,
      `/help — this message`, ``,
      `Everything else — pairing, PAPER trading, journal, replay — happens inside the terminal.`,
    ].join("\n"),
    { parse_mode: "Markdown", reply_markup: keyboard },
  );
});

// ── Admin-only ────────────────────────────────────────────────────────────
bot.command("stats", async (ctx) => {
  if (!(await requireAdmin(ctx, "stats"))) return;
  await ctx.reply(`📊 Total leads: *${totalLeads()}*`, { parse_mode: "Markdown" });
});

/** First-10 beta control — issues a new invite and returns a ready-to-forward deep link. `note` is for the owner's own bookkeeping only (e.g. a name), never shown to the invitee. */
bot.command("invite", async (ctx) => {
  if (!(await requireAdmin(ctx, "invite"))) return;
  const note = ctx.match?.toString().trim() || undefined;
  const { code } = await createInvite(note);
  const link = `https://t.me/${ctx.me.username}?start=${code}`;
  await ctx.reply(
    [`✅ Invite created${note ? ` (${esc(note)})` : ""}`, ``, `Send this link:`, link].join("\n"),
    { parse_mode: "Markdown" },
  );
});

bot.command("invites", async (ctx) => {
  if (!(await requireAdmin(ctx, "invites"))) return;
  const invites = await listInvites();
  if (invites.length === 0) { await ctx.reply("No invites yet."); return; }
  const lines = invites.map((i) => `${i.status.padEnd(10)} ${i.note ?? "(no note)"} ${i.user_id ? `— user ${i.user_id}` : ""}`);
  await ctx.reply(["*Invites (newest first)*", "```", ...lines, "```"].join("\n"), { parse_mode: "Markdown" });
});

/**
 * Beta operations command center — per the productization proposal's
 * "Session B" item #20. Not a general admin dashboard: just the counts
 * that actually matter for running a first-10 cohort by hand. Pulls
 * from invites (per-user cohort state) and funnel_events (aggregate
 * activation counts) — two data sources already being written to,
 * nothing new to instrument beyond what this session already wired up.
 */
bot.command("beta", async (ctx) => {
  if (!(await requireAdmin(ctx, "beta"))) return;
  const [invites, funnel] = await Promise.all([listInvites(), getFunnelCounts()]);
  const cohortLines = [
    `Invited      ${invites.length}`,
    `Activated    ${invites.filter((i) => i.status !== "invited").length}`,
    `Paired       ${invites.filter((i) => i.status === "paired" || i.status === "active").length}`,
  ];
  const funnelLines = funnel.length > 0
    ? funnel.map((f) => `${f.event.padEnd(22)} ${String(f.count).padStart(4)}  (${f.distinctUsers} users)`)
    : ["(no funnel events recorded yet)"];
  const userLines = invites.map((i) => `#${(i.user_id ?? "—").toString().padEnd(4)} ${i.status.padEnd(10)} ${i.note ?? "(no note)"}`);
  await ctx.reply(
    [
      "*BETA*", "```", ...cohortLines, "```", "",
      "*Funnel (all-time)*", "```", ...funnelLines, "```", "",
      "*Users*", "```", ...(userLines.length > 0 ? userLines : ["(none yet)"]), "```",
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
});

/**
 * Session B item — invite attribution. `/invite <note>` already tags a
 * source at creation time; this is the rollup that was missing: which
 * source is actually converting, not just what one invite's note says.
 */
bot.command("attribution", async (ctx) => {
  if (!(await requireAdmin(ctx, "attribution"))) return;
  const rows = await getAttributionBreakdown();
  if (rows.length === 0) { await ctx.reply("No invites yet."); return; }
  const lines = rows.map((r) => `${r.source.padEnd(24)} invited ${r.invited}  activated ${r.activated}  paired ${r.paired}`);
  await ctx.reply(["*Attribution by invite source*", "```", ...lines, "```"].join("\n"), { parse_mode: "Markdown" });
});

/** Session B item — read what the Mini App's feedback form has captured. */
bot.command("feedback", async (ctx) => {
  if (!(await requireAdmin(ctx, "feedback"))) return;
  const rows = await listRecentFeedback(20);
  if (rows.length === 0) { await ctx.reply("No feedback yet."); return; }
  const lines = rows.map((r) => `[${new Date(r.submitted_at).toISOString().slice(0, 16).replace("T", " ")}] ${r.user_id ? `user ${r.user_id}` : "anon"}: ${r.message}`);
  await ctx.reply(["*Recent feedback*", "```", ...lines, "```"].join("\n"), { parse_mode: "Markdown" });
});

bot.command("revoke", async (ctx) => {
  if (!(await requireAdmin(ctx, "revoke"))) return;
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
  if (!(await requireAdmin(ctx, "revokeengine"))) return;
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
  if (!getNotifyPromotions(lead.tg_user_id)) return;
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

/**
 * DM the customer that their paired ARIA engine has gone quiet for a
 * sustained period — see engine-offline-alerts.ts. Sent at most once per
 * offline streak (offline_notified_at gates this at the caller, reset on
 * the next successful sync). Reassures data safety explicitly, matching
 * this session's structured-recovery-state copy elsewhere.
 */
export async function notifyCustomerOfEngineOffline(telegramUserId: number, deviceName: string | null, minutesOffline: number): Promise<void> {
  const label = deviceName ? esc(deviceName) : "your ARIA engine";
  const text = [
    `⚠️ ${label} has not synced in over ${minutesOffline} minutes.`, ``,
    `Your PAPER positions and journal are safe — nothing is lost while it's offline.`, ``,
    `Make sure ARIA is running, or run \`aria doctor\` to check.`,
  ].join("\n");
  try {
    await bot.api.sendMessage(telegramUserId, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.warn({ err }, "engine-offline DM failed (non-fatal) — they may not have started the bot chat");
  }
}
