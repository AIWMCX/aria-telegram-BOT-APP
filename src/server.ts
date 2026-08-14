import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import { CONFIG, PAYMENTS_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { verifyInitData } from "./telegram-auth.js";
import { upsertLead, recentSubmissionsByUser, totalLeads } from "./leads.js";
import { sendAdminLeadNotification, sendLicenseEmail } from "./email.js";
import { notifyAdminOfLicense, notifyCustomerLicenseIssued } from "./bot.js";
import { issueLicense, getActiveLicenseForLead } from "./licenses.js";
import { createCheckoutSession, handleStripeWebhook } from "./stripe.js";
import { getOrderById } from "./orders.js";

export const app = new Hono();

const SolanaAddress = z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "invalid Solana address");

const SubmitBody = z.object({
  initData: z.string().min(10, "initData missing — open this via the Telegram bot"),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  wallet: SolanaAddress,
  interest: z.string().trim().max(500).optional(),
});

const CheckoutBody = z.object({
  initData: z.string().min(10),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  wallet: SolanaAddress,
  tier: z.enum(["standard", "pro"]),
});

app.get("/healthz", (c) =>
  c.json({ ok: true, uptime: process.uptime(), leads: totalLeads(), paymentsEnabled: PAYMENTS_ENABLED }),
);

/** Trial signup — verifies Telegram identity, saves lead, issues a trial license immediately. */
app.post("/api/submit", async (c) => {
  const ua = c.req.header("user-agent") ?? "";
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = SubmitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
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

/** Post-checkout landing — looks up the order, returns license info once issued. */
app.get("/api/license-by-order/:orderId", (c) => {
  const orderId = c.req.param("orderId");
  const order = getOrderById(orderId);
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.status !== "paid") return c.json({ ok: true, status: order.status });

  const license = getActiveLicenseForLead(order.lead_id);
  if (!license) return c.json({ ok: true, status: "paid", license: null });
  return c.json({ ok: true, status: "paid", license });
});

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
