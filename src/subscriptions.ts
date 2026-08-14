import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { audit } from "./audit.js";
import type { Tier } from "./config.js";

export interface Subscription {
  id: string;
  lead_id: number;
  tier: Exclude<Tier, "trial">;
  stripe_sub_id: string;
  stripe_customer_id: string;
  status: string;
  current_period_end: string;
  cancel_at_period_end: number;
}

const upsertStmt = db.prepare(`
  INSERT INTO subscriptions (id, lead_id, tier, stripe_sub_id, stripe_customer_id, status, current_period_end)
  VALUES (@id, @lead_id, @tier, @stripe_sub_id, @stripe_customer_id, @status, @current_period_end)
  ON CONFLICT(stripe_sub_id) DO UPDATE SET
    status = excluded.status,
    current_period_end = excluded.current_period_end
`);

const updateStatusStmt = db.prepare(`
  UPDATE subscriptions SET status = ?, current_period_end = ? WHERE stripe_sub_id = ?
`);

const cancelStmt = db.prepare(`
  UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 1 WHERE stripe_sub_id = ?
`);

const findByStripeIdStmt = db.prepare(`SELECT * FROM subscriptions WHERE stripe_sub_id = ?`);
const findActiveByLeadStmt = db.prepare(
  `SELECT * FROM subscriptions WHERE lead_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
);

export function upsertSubscription(input: {
  leadId: number;
  tier: Exclude<Tier, "trial">;
  stripeSubId: string;
  stripeCustomerId: string;
  status: string;
  currentPeriodEnd: string;
}): void {
  upsertStmt.run({
    id: "sub_" + randomBytes(6).toString("hex"),
    lead_id: input.leadId,
    tier: input.tier,
    stripe_sub_id: input.stripeSubId,
    stripe_customer_id: input.stripeCustomerId,
    status: input.status,
    current_period_end: input.currentPeriodEnd,
  });
  audit("system", "subscription.upserted", { type: "subscription", id: input.stripeSubId }, { status: input.status });
}

export function updateSubscriptionStatus(stripeSubId: string, status: string, currentPeriodEnd: string): void {
  updateStatusStmt.run(status, currentPeriodEnd, stripeSubId);
  audit("system", "subscription.updated", { type: "subscription", id: stripeSubId }, { status });
}

export function cancelSubscription(stripeSubId: string): void {
  cancelStmt.run(stripeSubId);
  audit("system", "subscription.canceled", { type: "subscription", id: stripeSubId });
}

export function getSubscriptionByStripeId(stripeSubId: string): Subscription | undefined {
  return findByStripeIdStmt.get(stripeSubId) as Subscription | undefined;
}

export function getActiveSubscriptionForLead(leadId: number): Subscription | undefined {
  return findActiveByLeadStmt.get(leadId) as Subscription | undefined;
}
