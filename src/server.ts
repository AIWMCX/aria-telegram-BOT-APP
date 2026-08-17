import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import { CONFIG, PAYMENTS_ENABLED, USERS_DOMAIN_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { verifyInitData } from "./telegram-auth.js";
import { upsertLead, recentSubmissionsByUser, totalLeads, getLatestLeadByTgUser } from "./leads.js";
import { sendAdminLeadNotification, sendLicenseEmail } from "./email.js";
import { notifyAdminOfLicense, notifyCustomerLicenseIssued } from "./bot.js";
import { issueLicense, getActiveLicenseForLead } from "./licenses.js";
import { createCheckoutSession, handleStripeWebhook } from "./stripe.js";
import { upsertUserFromTelegram } from "./users.js";

export const app = new Hono();

const SolanaAddress = z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "invalid Solana address");

const SubmitBody = z.object({
  initData: z.string().min(10, "initData missing — open this via the Telegram bot"),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  wallet: SolanaAddress,
  interest: z.string().trim().max(500).optional(),
  website: z.string().max(200).optional(), // honeypot — real users never fill this
});

const CheckoutBody = z.object({
  initData: z.string().min(10),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  wallet: SolanaAddress,
  tier: z.enum(["standard", "pro"]),
  website: z.string().max(200).optional(), // honeypot
});

app.get("/healthz", (c) =>
  c.json({ ok: true, uptime: process.uptime(), leads: totalLeads(), paymentsEnabled: PAYMENTS_ENABLED }),
);

/**
 * Returning-user account restore. Verifies Telegram initData (sent as a
 * header, never a query param, so it never lands in access logs or a
 * Referer header) and returns the caller's OWN account/license state —
 * there is no code path here that can return a different Telegram user's
 * license, because the identity is derived entirely from the verified
 * signature, never from client-supplied input.
 *
 * Returns the full license token (not just tier/expiry) so a returning
 * user can recover their key from the Mini App itself even if the
 * original delivery email never arrived — license delivery must not
 * depend on email being reliable.
 */
app.get("/api/me", (c) => {
  const initData = c.req.header("x-init-data");
  if (!initData) return c.json({ ok: false, error: "missing initData" }, 400);

  const verified = verifyInitData(initData);
  if (!verified) return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);

  const lead = getLatestLeadByTgUser(verified.user.id);
  if (!lead?.id) return c.json({ ok: true, hasAccount: false, license: null });

  const license = getActiveLicenseForLead(lead.id);
  if (!license) return c.json({ ok: true, hasAccount: true, license: null });

  return c.json({
    ok: true,
    hasAccount: true,
    license: { id: license.id, token: license.token, tier: license.tier, expiresAt: license.expiresAt },
    email: lead.email,
  });
});

/**
 * Real ARIA identity — per docs/ARIA_FUNDS_ARCHITECTURE_V1.md §3a. Additive
 * to `/api/me`: creates/restores a `users` row keyed on telegram_user_id
 * alone (not the leads table's tg_user_id+email pair). This is the account
 * domain the funded product will build on; it does not yet return a
 * wallet, balance, or anything financial — those don't exist until
 * wallet_accounts/ledger are wired to a real SignerPort adapter.
 */
app.post("/api/auth/telegram", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = z.object({ initData: z.string().min(10) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) {
    logger.warn("auth/telegram rejected — bad initData");
    return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);
  }

  if (!USERS_DOMAIN_ENABLED) {
    return c.json({ ok: false, error: "Account service not yet available." }, 503);
  }

  try {
    const user = await upsertUserFromTelegram({
      id: verified.user.id,
      username: verified.user.username,
      first_name: verified.user.first_name,
      last_name: verified.user.last_name,
    });
    return c.json({
      ok: true,
      user: {
        id: user.id,
        accountStatus: user.account_status,
        createdAt: user.created_at,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "auth/telegram failed — Postgres users domain unavailable");
    return c.json({ ok: false, error: "Account service temporarily unavailable." }, 503);
  }
});

/** Trial signup — verifies Telegram identity, saves lead, issues a trial license immediately. */
app.post("/api/submit", async (c) => {
  const ua = c.req.header("user-agent") ?? "";
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = SubmitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }
  if (parsed.data.website) {
    // Honeypot tripped — reject with the same generic shape as any other
    // validation failure so bots can't distinguish this from a real rejection.
    return c.json({ ok: false, error: "invalid input" }, 400);
  }

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) {
    logger.warn({ ua }, "submit rejected — bad initData");
    return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);
  }

  if (recentSubmissionsByUser(verified.user.id) >= 3) {
    return c.json({ ok: false, error: "Too many submissions. Please try again later." }, 429);
  }

  const lead = {
    tg_user_id: verified.user.id,
    tg_username: verified.user.username,
    tg_first_name: verified.user.first_name,
    tg_last_name: verified.user.last_name,
    name: parsed.data.name,
    email: parsed.data.email,
    wallet: parsed.data.wallet,
    interest: parsed.data.interest,
  };

  const leadId = upsertLead(lead);
  const leadWithId = { ...lead, id: leadId };
  const license = issueLicense(leadWithId, "trial");

  logger.info({ leadId, licenseId: license.id }, "trial issued");

  void (async () => {
    await sendAdminLeadNotification(lead, leadId);
    await sendLicenseEmail(leadWithId, license);
    await notifyAdminOfLicense(leadWithId, license, "trial");
    await notifyCustomerLicenseIssued(leadWithId, license);
  })();

  return c.json({ ok: true, leadId, licenseId: license.id, tier: "trial", expiresAt: license.expiresAt });
});

/** Paid tier — creates a Stripe Checkout session. */
app.post("/api/checkout", async (c) => {
  if (!PAYMENTS_ENABLED) {
    return c.json({ ok: false, error: "Payments are not yet configured. Try again soon." }, 503);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = CheckoutBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) {
    return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);
  }

  const lead = {
    tg_user_id: verified.user.id,
    tg_username: verified.user.username,
    tg_first_name: verified.user.first_name,
    tg_last_name: verified.user.last_name,
    name: parsed.data.name,
    email: parsed.data.email,
    wallet: parsed.data.wallet,
  };
  const leadId = upsertLead(lead);

  try {
    const { url, orderId } = await createCheckoutSession({ leadId, tier: parsed.data.tier, email: parsed.data.email });
    return c.json({ ok: true, checkoutUrl: url, orderId });
  } catch (err: any) {
    logger.error({ err }, "checkout session creation failed");
    return c.json({ ok: false, error: err?.message ?? "checkout failed" }, 500);
  }
});

/** Stripe webhook — signature-verified, no Telegram auth (Stripe calls this server-to-server). */
app.post("/api/webhook/stripe", async (c) => {
  if (!PAYMENTS_ENABLED) return c.json({ ok: false, error: "not configured" }, 503);

  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ ok: false, error: "missing signature" }, 400);

  const rawBody = await c.req.text();
  try {
    const result = await handleStripeWebhook(rawBody, signature);
    logger.info({ result }, "stripe webhook processed");
    return c.json({ ok: true, result });
  } catch (err: any) {
    logger.error({ err }, "stripe webhook verification/handling failed");
    return c.json({ ok: false, error: err?.message ?? "webhook error" }, 400);
  }
});

/**
 * Retired legacy post-checkout lookup. An order ID is not an authentication
 * capability, so this route must never disclose order or license data.
 * Returning users recover licenses through Telegram-authenticated `/api/me`.
 */
app.get("/api/license-by-order/:orderId", (c) =>
  c.json({ ok: false, error: "endpoint retired; use authenticated /api/me" }, 410),
);

app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

export function startServer(): void {
  serve({ fetch: app.fetch, port: CONFIG.PORT, hostname: "0.0.0.0" }, (info) => {
    logger.info(
      { port: info.port, publicUrl: CONFIG.PUBLIC_URL, paymentsEnabled: PAYMENTS_ENABLED },
      "http server listening",
    );
  });
}
