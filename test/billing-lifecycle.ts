/**
 * Self-contained test for the two billing-lifecycle gaps closed this
 * session: charge.refunded auto-revocation, and 7d/1d expiry-warning
 * DMs. Same conventions as test/e2e.ts — own throwaway SQLite file, own
 * env vars, real modules exercised in-process. No real Stripe or
 * Telegram network calls: constructEvent/generateTestHeaderString are
 * pure local crypto (no API call), and every notify function in bot.ts
 * already fails safe (caught, logged, never throws) on a real Telegram
 * rejection of a fake bot token — same fire-and-forget discipline
 * e2e.ts's own top comment documents.
 *
 * Run: npx tsx test/billing-lifecycle.ts
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";

const TEST_DB = "./data/billing-lifecycle-test.db";
if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(TEST_DB + suffix)) fs.rmSync(TEST_DB + suffix);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };

process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = privJwk.d;
process.env.ARIA_LICENSE_PUBLIC_X = pubJwk.x;
process.env.DB_PATH = TEST_DB;
process.env.LOG_LEVEL = "error";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_for_local_crypto_only";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake_secret_for_local_crypto_only";

const { publicKey: entPub, privateKey: entPriv } = generateKeyPairSync("ed25519");
const entPrivJwk = entPriv.export({ format: "jwk" }) as { d: string; x: string };
const entPubJwk = entPub.export({ format: "jwk" }) as { x: string };
process.env.ARIA_ENTITLEMENT_PRIVATE_D = entPrivJwk.d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = entPubJwk.x;

const { stripe, handleStripeWebhook } = await import("../src/stripe.js");
const { upsertLead } = await import("../src/leads.js");
const { issueLicense, getActiveLicenseForLead } = await import("../src/licenses.js");
const { upsertSubscription } = await import("../src/subscriptions.js");
const { db } = await import("../src/db.js");
const { checkAndSendExpiryWarnings } = await import("../src/expiry-warnings.js");

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

function signedWebhookRequest(eventPayload: object): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(eventPayload);
  const signature = stripe!.webhooks.generateTestHeaderString({ payload: rawBody, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  return { rawBody, signature };
}

// ── charge.refunded auto-revokes the active license ──────────────────────
{
  const leadId = upsertLead({ tg_user_id: 111, name: "Refund Test", email: "refund@example.com", wallet: "So11111111111111111111111111111111111111112" });
  const license = issueLicense({ id: leadId, tg_user_id: 111, name: "Refund Test", email: "refund@example.com", wallet: "So11111111111111111111111111111111111111112" } as any, "standard");
  upsertSubscription({ leadId, tier: "standard", stripeSubId: "sub_refund_test", stripeCustomerId: "cus_refund_test", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString() });

  check("setup: the license is active before the refund", getActiveLicenseForLead(leadId)?.id === license.id);

  const { rawBody, signature } = signedWebhookRequest({
    id: "evt_refund_1", type: "charge.refunded",
    data: { object: { id: "ch_refund_1", customer: "cus_refund_test", payment_intent: "pi_refund_1" } },
  });
  const result = await handleStripeWebhook(rawBody, signature);
  check("handleStripeWebhook reports the license was revoked", result.includes(license.id) && result.includes("revoked"));
  check("the license is no longer active after the refund", getActiveLicenseForLead(leadId) === undefined);

  const row = db.prepare(`SELECT revoked, revoked_reason FROM licenses WHERE id = ?`).get(license.id) as { revoked: number; revoked_reason: string };
  check("the license row itself is marked revoked with reason 'refunded'", row.revoked === 1 && row.revoked_reason === "refunded");
}

// ── charge.refunded also revokes a RENEWAL charge (not just the first payment) ──
{
  // Same customer, different (later) charge — this is the case the checkout-session-id-based
  // approach from the original gap note could NOT have handled, since renewals never get a
  // checkout session id recorded on `orders` at all.
  const leadId = upsertLead({ tg_user_id: 222, name: "Renewal Refund", email: "renewal@example.com", wallet: "So11111111111111111111111111111111111111113" });
  const license = issueLicense({ id: leadId, tg_user_id: 222, name: "Renewal Refund", email: "renewal@example.com", wallet: "So11111111111111111111111111111111111111113" } as any, "pro");
  upsertSubscription({ leadId, tier: "pro", stripeSubId: "sub_renewal_test", stripeCustomerId: "cus_renewal_test", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString() });

  const { rawBody, signature } = signedWebhookRequest({
    id: "evt_refund_renewal", type: "charge.refunded",
    data: { object: { id: "ch_renewal_refund", customer: "cus_renewal_test", payment_intent: "pi_renewal_refund" } },
  });
  await handleStripeWebhook(rawBody, signature);
  check("a refund on a RENEWAL charge (same customer, no matching order) still revokes the license", getActiveLicenseForLead(leadId) === undefined);
  void license;
}

// ── charge.refunded for an unknown Stripe customer degrades safely ───────
{
  const { rawBody, signature } = signedWebhookRequest({
    id: "evt_refund_unknown", type: "charge.refunded",
    data: { object: { id: "ch_unknown", customer: "cus_never_seen_before" } },
  });
  const result = await handleStripeWebhook(rawBody, signature);
  check("a refund for a customer with no local subscription is reported, not thrown", result.includes("skipped") && result.includes("unknown"));
}

// ── charge.refunded with no customer id on the charge degrades safely ────
{
  const { rawBody, signature } = signedWebhookRequest({
    id: "evt_refund_no_customer", type: "charge.refunded",
    data: { object: { id: "ch_no_customer" } },
  });
  const result = await handleStripeWebhook(rawBody, signature);
  check("a refund with no customer id at all is reported, not thrown", result.includes("skipped") && result.includes("no customer id"));
}

// ── charge.refunded when the license is already revoked doesn't double-revoke or throw ──
{
  const leadId = upsertLead({ tg_user_id: 333, name: "Double Refund", email: "double@example.com", wallet: "So11111111111111111111111111111111111111114" });
  issueLicense({ id: leadId, tg_user_id: 333, name: "Double Refund", email: "double@example.com", wallet: "So11111111111111111111111111111111111111114" } as any, "standard");
  upsertSubscription({ leadId, tier: "standard", stripeSubId: "sub_double_test", stripeCustomerId: "cus_double_test", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString() });

  const req1 = signedWebhookRequest({ id: "evt_double_1", type: "charge.refunded", data: { object: { id: "ch_double_1", customer: "cus_double_test" } } });
  await handleStripeWebhook(req1.rawBody, req1.signature);
  const req2 = signedWebhookRequest({ id: "evt_double_2", type: "charge.refunded", data: { object: { id: "ch_double_2", customer: "cus_double_test" } } });
  const result2 = await handleStripeWebhook(req2.rawBody, req2.signature);
  check("a second refund for an already-revoked license is reported honestly, not a crash or a fabricated second revocation", result2.includes("no active license"));
}

// ── expiry warnings: 7-day window ─────────────────────────────────────────
{
  const leadId = upsertLead({ tg_user_id: 444, name: "Expiry 7d", email: "expiry7d@example.com", wallet: "So11111111111111111111111111111111111111115" });
  const license = issueLicense({ id: leadId, tg_user_id: 444, name: "Expiry 7d", email: "expiry7d@example.com", wallet: "So11111111111111111111111111111111111111115" } as any, "standard");
  // Force expires_at to 3 days out (inside the 7d window, outside the 1d window) — issueLicense's own duration is fixed by tier, so overwrite it directly for this test.
  db.prepare(`UPDATE licenses SET expires_at = datetime('now', '+3 days') WHERE id = ?`).run(license.id);

  const { sent7d, sent1d } = await checkAndSendExpiryWarnings();
  check("a license 3 days from expiry gets exactly one 7d warning, not a 1d warning", sent7d === 1 && sent1d === 0);

  const row = db.prepare(`SELECT warned_7d, warned_1d FROM licenses WHERE id = ?`).get(license.id) as { warned_7d: number; warned_1d: number };
  check("warned_7d is now set, warned_1d is not", row.warned_7d === 1 && row.warned_1d === 0);

  const second = await checkAndSendExpiryWarnings();
  check("calling checkAndSendExpiryWarnings again does NOT re-send the same 7d warning — it's idempotent", second.sent7d === 0);
}

// ── expiry warnings: 1-day window (a license close enough to trigger BOTH, if neither has fired yet) ──
{
  const leadId = upsertLead({ tg_user_id: 555, name: "Expiry 1d", email: "expiry1d@example.com", wallet: "So11111111111111111111111111111111111111116" });
  const license = issueLicense({ id: leadId, tg_user_id: 555, name: "Expiry 1d", email: "expiry1d@example.com", wallet: "So11111111111111111111111111111111111111116" } as any, "standard");
  db.prepare(`UPDATE licenses SET expires_at = datetime('now', '+12 hours') WHERE id = ?`).run(license.id);

  const { sent7d, sent1d } = await checkAndSendExpiryWarnings();
  check("a license 12 hours from expiry (inside both windows, neither warned yet) gets BOTH the 7d and 1d warning in the same pass", sent7d === 1 && sent1d === 1);

  const row = db.prepare(`SELECT warned_7d, warned_1d FROM licenses WHERE id = ?`).get(license.id) as { warned_7d: number; warned_1d: number };
  check("both warned flags are now set", row.warned_7d === 1 && row.warned_1d === 1);
}

// ── expiry warnings: a license far from expiry is never warned ───────────
{
  const leadId = upsertLead({ tg_user_id: 666, name: "Not Expiring", email: "notexpiring@example.com", wallet: "So11111111111111111111111111111111111111117" });
  const license = issueLicense({ id: leadId, tg_user_id: 666, name: "Not Expiring", email: "notexpiring@example.com", wallet: "So11111111111111111111111111111111111111117" } as any, "standard");
  // Default standard duration (30 days, config.ts) is already outside both windows — no override needed.

  await checkAndSendExpiryWarnings();
  const row = db.prepare(`SELECT warned_7d, warned_1d FROM licenses WHERE id = ?`).get(license.id) as { warned_7d: number; warned_1d: number };
  check("a license 30 days from expiry is not warned at all yet", row.warned_7d === 0 && row.warned_1d === 0);
}

// ── expiry warnings: a REVOKED license is never warned, even if it would otherwise be in-window ──
{
  const leadId = upsertLead({ tg_user_id: 777, name: "Revoked Expiring", email: "revokedexpiring@example.com", wallet: "So11111111111111111111111111111111111111118" });
  const license = issueLicense({ id: leadId, tg_user_id: 777, name: "Revoked Expiring", email: "revokedexpiring@example.com", wallet: "So11111111111111111111111111111111111111118" } as any, "standard");
  db.prepare(`UPDATE licenses SET expires_at = datetime('now', '+3 days'), revoked = 1, revoked_reason = 'test' WHERE id = ?`).run(license.id);

  const { sent7d } = await checkAndSendExpiryWarnings();
  const row = db.prepare(`SELECT warned_7d FROM licenses WHERE id = ?`).get(license.id) as { warned_7d: number };
  check("a revoked license inside the 7d window is never warned — there's nothing to renew", row.warned_7d === 0);
  void sent7d;
}

console.log(`\n${failures === 0 ? "✅ ALL TESTS PASSED" : `❌ ${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
