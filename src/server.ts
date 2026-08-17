import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import { CONFIG, PAYMENTS_ENABLED, PRODUCT_REALITY, USERS_DOMAIN_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { verifyInitData } from "./telegram-auth.js";
import { upsertLead, recentSubmissionsByUser, totalLeads, getLatestLeadByTgUser } from "./leads.js";
import { sendAdminLeadNotification, sendLicenseEmail } from "./email.js";
import { notifyAdminOfLicense, notifyCustomerLicenseIssued } from "./bot.js";
import { issueLicense, getActiveLicenseForLead } from "./licenses.js";
import { createCheckoutSession, handleStripeWebhook } from "./stripe.js";
import { upsertUserFromTelegram } from "./users.js";
import { EngineStore, engineStore } from "./engine-store.js";
import { authenticateEngineRequest } from "./engine-auth.js";
import { EngineCommand, SanitizedHeartbeat, PaperEvent } from "../engine/src/contracts.js";

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

/** Read-only, sanitized product truth for the shipped Mini App. */
app.get("/api/product-reality", (c) =>
  c.json({ ok: true, reality: PRODUCT_REALITY }),
);

function telegramInitData(c: any): string | null { return c.req.header("x-init-data") ?? null; }
function requireEngineStore(c: any): EngineStore | null {
  if (!engineStore) { c.header("Cache-Control", "no-store"); return null; }
  return engineStore;
}

app.post("/api/engine/pairing", async (c) => {
  const initData = telegramInitData(c);
  if (!initData) return c.json({ ok: false, error: "missing initData" }, 400);
  const verified = verifyInitData(initData);
  if (!verified) return c.json({ ok: false, error: "Telegram verification failed" }, 401);
  const store = requireEngineStore(c);
  if (!store) return c.json({ ok: false, error: "Engine service not yet available." }, 503);
  const code = await store.createPairingCode(verified.user.id, new Date(Date.now() + 5 * 60_000));
  return c.json({ ok: true, pairingCode: code.code, expiresAt: code.expiresAt.toISOString() });
});

app.post("/api/engine/pairing/exchange", async (c) => {
  const store = requireEngineStore(c);
  if (!store) return c.json({ ok: false, error: "Engine service not yet available." }, 503);
  let body: unknown; try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
  const parsed = z.object({ code: z.string().min(16).max(256) }).safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "invalid pairing code" }, 400);
  const result = await store.exchangePairingCode(parsed.data.code);
  if (!result) return c.json({ ok: false, error: "invalid or expired pairing code" }, 401);
  return c.json({ ok: true, deviceId: result.deviceId, credential: result.credential });
});

app.post("/api/engine/heartbeat", async (c) => {
  const raw = await c.req.text();
  const auth = await authenticateEngineRequest(c.req.raw.headers, "POST", "/api/engine/heartbeat", raw);
  if (!auth) return c.json({ ok: false, error: "engine authentication failed" }, 401);
  let body: unknown; try { body = JSON.parse(raw); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
  const parsed = SanitizedHeartbeat.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "invalid heartbeat" }, 400);
  await engineStore!.recordHeartbeat(auth.device.id, parsed.data);
  return c.json({ ok: true });
});

app.post("/api/engine/events", async (c) => {
  const raw = await c.req.text();
  const auth = await authenticateEngineRequest(c.req.raw.headers, "POST", "/api/engine/events", raw);
  if (!auth) return c.json({ ok: false, error: "engine authentication failed" }, 401);
  let body: unknown; try { body = JSON.parse(raw); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
  const parsed = z.object({ events: z.array(PaperEvent).max(100) }).strict().safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "invalid engine events" }, 400);
  await engineStore!.appendEngineEvents(auth.device.id, parsed.data.events);
  return c.json({ ok: true });
});

app.get("/api/engine/commands", async (c) => {
  const auth = await authenticateEngineRequest(c.req.raw.headers, "GET", "/api/engine/commands", "");
  if (!auth) return c.json({ ok: false, error: "engine authentication failed" }, 401);
  return c.json({ ok: true, commands: await engineStore!.readPendingCommands(auth.device.id) });
});

app.post("/api/engine/commands/:id/ack", async (c) => {
  const raw = await c.req.text();
  const auth = await authenticateEngineRequest(c.req.raw.headers, "POST", `/api/engine/commands/${c.req.param("id")}/ack`, raw);
  if (!auth) return c.json({ ok: false, error: "engine authentication failed" }, 401);
  let body: unknown; try { body = JSON.parse(raw); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
  const parsed = z.object({ accepted: z.boolean(), reason: z.string().max(200).optional() }).strict().safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "invalid command acknowledgement" }, 400);
  const acknowledged = await engineStore!.acknowledgeCommand(auth.device.id, c.req.param("id"), parsed.data.accepted);
  return acknowledged ? c.json({ ok: true }) : c.json({ ok: false, error: "command not pending" }, 409);
});

app.get("/api/engine/devices", async (c) => {
  const initData = telegramInitData(c);
  if (!initData) return c.json({ ok: false, error: "missing initData" }, 400);
  const verified = verifyInitData(initData); if (!verified) return c.json({ ok: false, error: "Telegram verification failed" }, 401);
  const store = requireEngineStore(c); if (!store) return c.json({ ok: false, error: "Engine service not yet available." }, 503);
  return c.json({ ok: true, devices: await store.listDevices(verified.user.id) });
});

app.get("/api/engine/dashboard", async (c) => {
  const initData = telegramInitData(c);
  if (!initData) return c.json({ ok: false, error: "missing initData" }, 400);
  const verified = verifyInitData(initData); if (!verified) return c.json({ ok: false, error: "Telegram verification failed" }, 401);
  const store = requireEngineStore(c); if (!store) return c.json({ ok: false, error: "Engine service not yet available." }, 503);
  return c.json({ ok: true, dashboard: await store.readDashboardState(verified.user.id) });
});

app.post("/api/engine/commands", async (c) => {
  const initData = telegramInitData(c);
  if (!initData) return c.json({ ok: false, error: "missing initData" }, 400);
  const verified = verifyInitData(initData); if (!verified) return c.json({ ok: false, error: "Telegram verification failed" }, 401);
  const store = requireEngineStore(c); if (!store) return c.json({ ok: false, error: "Engine service not yet available." }, 503);
  let body: unknown; try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }
  const parsed = z.object({ deviceId: z.string().uuid(), command: EngineCommand }).strict().safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: "invalid engine command" }, 400);
  await store.appendCommand(verified.user.id, parsed.data.deviceId, parsed.data.command);
  return c.json({ ok: true, commandId: parsed.data.command.id });
});

app.post("/api/engine/devices/:id/revoke", async (c) => {
  const initData = telegramInitData(c);
  if (!initData) return c.json({ ok: false, error: "missing initData" }, 400);
  const verified = verifyInitData(initData); if (!verified) return c.json({ ok: false, error: "Telegram verification failed" }, 401);
  const store = requireEngineStore(c); if (!store) return c.json({ ok: false, error: "Engine service not yet available." }, 503);
  const revoked = await store.revokeDevice(verified.user.id, c.req.param("id"));
  return revoked ? c.json({ ok: true }) : c.json({ ok: false, error: "device not found" }, 404);
});

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
