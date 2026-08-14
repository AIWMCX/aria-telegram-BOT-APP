import Stripe from "stripe";
import { CONFIG, TIER_LIMITS, PAYMENTS_ENABLED, type Tier } from "./config.js";
import { logger } from "./logger.js";
import { createOrder, attachExternalRef, markOrderPaid } from "./orders.js";
import { upsertSubscription, updateSubscriptionStatus, cancelSubscription, getSubscriptionByStripeId } from "./subscriptions.js";
import { getLeadById } from "./leads.js";
import { issueLicense } from "./licenses.js";
import { sendLicenseEmail } from "./email.js";
import { notifyAdminOfLicense, notifyCustomerLicenseIssued } from "./bot.js";

export const stripe = PAYMENTS_ENABLED ? new Stripe(CONFIG.STRIPE_SECRET_KEY!) : null;

/** Create a Stripe Checkout session for Standard or Pro. Throws if payments aren't configured. */
export async function createCheckoutSession(opts: {
  leadId: number;
  tier: Exclude<Tier, "trial">;
  email: string;
}): Promise<{ url: string; orderId: string }> {
  if (!stripe) throw new Error("Payments not configured — set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET");

  const cfg = TIER_LIMITS[opts.tier];
  if (!cfg.priceId) {
    throw new Error(`No Stripe price configured for tier "${opts.tier}" — set STRIPE_${opts.tier.toUpperCase()}_PRICE_ID`);
  }

  const orderId = createOrder(opts.leadId, opts.tier, cfg.amountUsd);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: cfg.priceId, quantity: 1 }],
    customer_email: opts.email,
    client_reference_id: orderId,
    success_url: `${CONFIG.PUBLIC_URL}/license/${orderId}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${CONFIG.PUBLIC_URL}/?checkout=cancelled`,
    metadata: { orderId, tier: opts.tier, leadId: String(opts.leadId) },
  });

  attachExternalRef(orderId, session.id);
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url, orderId };
}

/** Verify + dispatch a Stripe webhook event. Returns a short status string for logging. */
export async function handleStripeWebhook(rawBody: string, signature: string): Promise<string> {
  if (!stripe || !CONFIG.STRIPE_WEBHOOK_SECRET) throw new Error("Payments not configured");

  const event = stripe.webhooks.constructEvent(rawBody, signature, CONFIG.STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.client_reference_id;
      const tier = session.metadata?.tier as Exclude<Tier, "trial"> | undefined;
      const leadId = session.metadata?.leadId ? Number(session.metadata.leadId) : undefined;
      if (!orderId || !tier || !leadId) {
        logger.warn({ sessionId: session.id }, "checkout.session.completed missing metadata");
        return "skipped: missing metadata";
      }

      const lead = getLeadById(leadId);
      if (!lead?.id) return "skipped: lead not found";

      markOrderPaid(orderId);

      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        upsertSubscription({
          leadId,
          tier,
          stripeSubId: sub.id,
          stripeCustomerId: String(session.customer),
          status: sub.status,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
        });
      }

      const license = issueLicense(lead as any, tier, orderId);
      await sendLicenseEmail(lead as any, license);
      await notifyAdminOfLicense(lead as any, license, "paid");
      await notifyCustomerLicenseIssued(lead as any, license);
      return `issued license ${license.id} for order ${orderId}`;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = invoice.subscription as string | null;
      if (!subId) return "skipped: no subscription on invoice";
      const sub = await stripe.subscriptions.retrieve(subId);
      const localSub = getSubscriptionByStripeId(subId);
      if (!localSub) return "skipped: unknown subscription locally";

      updateSubscriptionStatus(subId, sub.status, new Date(sub.current_period_end * 1000).toISOString());

      // Renewal — only re-issue a license if this ISN'T the very first invoice
      // (the first invoice's license was already issued by checkout.session.completed)
      if (invoice.billing_reason === "subscription_cycle") {
        const lead = getLeadById(localSub.lead_id);
        if (lead?.id) {
          const license = issueLicense(lead as any, localSub.tier, undefined);
          await sendLicenseEmail(lead as any, license);
          await notifyAdminOfLicense(lead as any, license, "renewed");
          await notifyCustomerLicenseIssued(lead as any, license);
        }
      }
      return `renewed subscription ${subId}`;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      cancelSubscription(sub.id);
      return `cancelled subscription ${sub.id}`;
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntent = charge.payment_intent as string | null;
      if (!paymentIntent) return "skipped: no payment intent";
      // Find order by session id isn't direct from charge; log for manual reconciliation.
      // For MVP, admin revokes manually via /revoke command using the license id from the email.
      logger.warn({ chargeId: charge.id, paymentIntent }, "refund received — revoke license manually via /revoke");
      return `refund logged: ${charge.id}`;
    }

    default:
      return `ignored: ${event.type}`;
  }
}
